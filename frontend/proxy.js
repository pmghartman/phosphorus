'use strict';
// the ingress cloudflared points at: every published service by path or
// subdomain, the frontend itself for everything else on the base domain

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { notes } = require('./util');

const BASE_DOMAIN = process.env.BASE_DOMAIN || '';

const { log, note, clear } = notes('ingress');

// --- validation ------------------------------------------------------------

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const BASE_RE = /^[a-z0-9]([a-z0-9/_-]*[a-z0-9])?$/;
const SIZE_RE = /^([0-9]+)(KB|MB|GB)?$/;
const UNIT = { '': 1, KB: 1e3, MB: 1e6, GB: 1e9 };
const GAME_STATUS = new Set(['online', 'offline', 'starting', 'stopping']);

// services.export `extras`, spread onto the published row
const EXTRAS = {
  flush_interval: (v) => Number.isInteger(Number(v)) && /^-?[0-9]+$/.test(String(v)),
  max_body: (v) => SIZE_RE.test(String(v)),
  forwarded_proto: (v) => v === 'http' || v === 'https',
};
const EXTRA_KEYS = Object.keys(EXTRAS);

const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// why a published row can't be routed, '' when it can, unknown keys
// ignored, never copied into a route
function rowError(r) {
  if (!r || typeof r !== 'object') return 'not an object';
  if (!NAME_RE.test(r.name || '')) return `'${r.name}' is not a valid name`;
  if (!validPort(r.port)) return `'${r.port}' is not a valid port`;
  if (r.type === 'game') {
    return r.status === undefined || GAME_STATUS.has(r.status) ? '' : `'${r.status}' is not a game status`;
  }
  if (r.type !== undefined && r.type !== '') return `'${r.type}' is not a service type`;
  if (r.scheme !== 'http' && r.scheme !== 'https') return `'${r.scheme}' is not http or https`;
  if (r.mode !== 'path' && r.mode !== 'subdomain') return `'${r.mode}' is not path or subdomain`;
  if (r.base_path && (typeof r.base_path !== 'string' || r.base_path.includes('..') || !BASE_RE.test(r.base_path))) {
    return `'${r.base_path}' is not a valid base_path`;
  }
  for (const k of EXTRA_KEYS) {
    if (r[k] !== undefined && !EXTRAS[k](r[k])) return `'${r[k]}' is not a valid ${k}`;
  }
  return '';
}

// --- routing table ---------------------------------------------------------
// rebuilt whole from the merged rows, swapped in by one assignment

let table = { domains: new Map(), paths: [] };
let tableFp = '[]';

function toRoute(r, ip) {
  const base = r.base_path ? `/${r.base_path}` : '';
  const sub = r.mode === 'subdomain';
  const size = String(r.max_body || '').match(SIZE_RE);
  return {
    host: r.host, name: r.name, master: r.master === true,
    domain: sub ? `${r.name}.${BASE_DOMAIN}` : '',
    prefix: sub ? base : `/${r.host}/${r.name}${base}`,
    scheme: r.scheme, ip, port: r.port,
    maxBody: size ? Number(size[1]) * UNIT[size[2] || ''] : 0,
    proto: r.forwarded_proto || 'http',
  };
}

// a candidate table, or the first reason not to swap it in
function build(rows, ipOf) {
  const domains = new Map();
  const paths = [];
  for (const r of rows) {
    if (r.type === 'game') continue;
    const why = NAME_RE.test(r.host || '') ? rowError(r) : `'${r.host}' is not a valid host`;
    if (why) return { error: `${r.host}'s ${r.name}: ${why}` };
    const route = toRoute(r, ipOf(r.host) || r.host);
    if (!route.domain) { paths.push(route); continue; }
    // one name on two hosts: the git master, else the first alphabetically
    const held = domains.get(route.domain);
    if (held && !(route.master && !held.master)) {
      note(`dup:${route.domain}`, `${route.domain} is published by ${held.host} and ${route.host}; serving ${held.host}'s`);
      continue;
    }
    domains.set(route.domain, route);
  }
  // most specific prefix first
  paths.sort((a, b) => b.prefix.length - a.prefix.length);
  return { table: { domains, paths } };
}

// validate then swap, the live table untouched on any failure
function swap(rows, ipOf) {
  const out = build(rows, ipOf);
  if (out.error) {
    note('table', `routes rejected, still serving the previous ones: ${out.error}`);
    return false;
  }
  clear('table');
  const all = [...out.table.domains.values(), ...out.table.paths];
  const fp = JSON.stringify(all);
  if (fp === tableFp) return false;
  table = out.table;
  tableFp = fp;
  const hosts = new Set(all.map((r) => r.host));
  const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  log(`routes updated, now serving ${s(all.length, 'service')} across ${s(hosts.size, 'host')}`);
  return true;
}

// --- matching --------------------------------------------------------------

const under = (p, prefix) => p === prefix || p.startsWith(`${prefix}/`);
const strip = (p, prefix) => p.slice(prefix.length) || '/';

// loopback (cloudflared) or the tailnet, never the LAN host networking exposes
function onMesh(req) {
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (addr === '127.0.0.1' || addr === '::1') return true;
  const m = addr.match(/^100\.(\d+)\./);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

// {route, path}, {frontend}, or {status, text}
function resolve(req) {
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  const q = req.url.indexOf('?');
  const pathname = q < 0 ? req.url : req.url.slice(0, q);
  const search = q < 0 ? '' : req.url.slice(q);
  const t = table;
  if (host === BASE_DOMAIN) {
    const r = t.paths.find((x) => under(pathname, x.prefix));
    if (r) return { route: r, path: strip(pathname, r.prefix) + search };
    // host to host over the tailnet only
    if (pathname === '/api/update/local') return { status: 404, text: 'not found' };
    return onMesh(req) ? { frontend: true } : { status: 403, text: 'forbidden' };
  }
  const r = t.domains.get(host);
  if (r) {
    if (!r.prefix) return { route: r, path: req.url };
    if (under(pathname, r.prefix)) return { route: r, path: strip(pathname, r.prefix) + search };
    return { status: 404, text: 'not found' };
  }
  if (pathname === '/healthz') return { status: 200, text: 'ok' };
  return { status: 404, text: 'no route for this hostname' };
}

// --- proxying --------------------------------------------------------------

const HOP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const agents = {
  http: new http.Agent({ keepAlive: true }),
  // no certificate for a tailnet IP, the hop already WireGuard encrypted
  https: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
};

// the client's own X-Forwarded-* never trusted, always replaced
function upstreamHeaders(req, route, upgrade) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-forwarded-') || (!upgrade && HOP.has(k))) continue;
    out[k] = v;
  }
  out['x-forwarded-for'] = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  out['x-forwarded-proto'] = route.proto;
  out['x-forwarded-host'] = req.headers.host || '';
  if (route.pin) out[PIN_HOP] = SELF_HOST;
  return out;
}

// --- pinning ---------------------------------------------------------------
// no affinity across tunnel replicas: a browser held on the host it first reached

const SELF_HOST = process.env.SELF_HOST || '';
const INGRESS_PORT = Number(process.env.INGRESS_PORT || 80);
const PIN_COOKIE = 'hesperus-host';
// set on a pinned hop, never a second hop from the far ingress
const PIN_HOP = 'x-forwarded-hesperus-host';

// live hesperus peers, name -> tailnet IP, mesh.js's, every tick
let pinIps = new Map();
const pinTargets = (ips) => { pinIps = ips; };

const pinnedTo = (req) => (String(req.headers.cookie || '').match(/(?:^|;\s*)hesperus-host=([a-z0-9-]+)/) || [])[1] || '';
const pinCookie = (host) => `${PIN_COOKIE}=${host}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`;

// the pinned host's ingress, or null to serve here
function pinRoute(req) {
  if (!SELF_HOST || req.headers[PIN_HOP]) return null;
  const host = pinnedTo(req);
  const ip = host && host !== SELF_HOST && pinIps.get(host);
  return ip ? { pin: true, host, name: 'frontend', scheme: 'http', ip, port: INGRESS_PORT, proto: 'https', maxBody: 0 } : null;
}

// POST /api/host?host=<name>: the browser's pin moved by hand, answered here
// and never passed on
function pinSwitch(req, res) {
  const host = new URL(req.url, 'http://x').searchParams.get('host') || '';
  let origin = true;
  try { origin = !req.headers.origin || new URL(req.headers.origin).host === req.headers.host; } catch { origin = false; }
  if (!origin) return refuse(res, 403, 'forbidden');
  if (!SELF_HOST || (host !== SELF_HOST && !pinIps.has(host))) return refuse(res, 409, `${host || 'that host'} isn't serving`);
  res.writeHead(204, { 'Set-Cookie': pinCookie(host) }).end();
}

// no pin, or one to a host gone quiet: pinned here from now on
function pinHere(req, res) {
  if (SELF_HOST && !req.headers[PIN_HOP] && pinnedTo(req) !== SELF_HOST) res.setHeader('Set-Cookie', pinCookie(SELF_HOST));
}

function refuse(res, status, text) {
  if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
}

// streamed both ways, unbuffered, max_body enforced on the way in
function forward(route, req, res, path) {
  if (route.maxBody && Number(req.headers['content-length']) > route.maxBody) {
    refuse(res, 413, 'request body too large');
    return;
  }
  const up = (route.scheme === 'https' ? https : http).request({
    host: route.ip, port: route.port, method: req.method, path,
    headers: upstreamHeaders(req, route, false), agent: agents[route.scheme],
  }, (pr) => {
    const headers = [];
    for (let i = 0; i < pr.rawHeaders.length; i += 2) {
      if (!HOP.has(pr.rawHeaders[i].toLowerCase())) headers.push(pr.rawHeaders[i], pr.rawHeaders[i + 1]);
    }
    res.writeHead(pr.statusCode, pr.statusMessage, headers);
    // upstream gone mid-body: cut the client too, never a hung response
    pr.on('close', () => { if (!pr.complete) res.destroy(); });
    pr.pipe(res);
  });
  up.on('error', () => {
    // the next request served here instead
    if (route.pin && !res.headersSent) res.setHeader('Set-Cookie', pinCookie(SELF_HOST));
    refuse(res, 502, `${route.host}'s ${route.name} didn't answer`);
  });
  res.on('close', () => { if (!res.writableFinished) up.destroy(); });
  if (route.maxBody) {
    let seen = 0;
    req.on('data', (c) => {
      seen += c.length;
      if (seen <= route.maxBody) return;
      req.unpipe(up);
      up.destroy();
      refuse(res, 413, 'request body too large');
    });
  }
  req.pipe(up);
}

// a websocket or any other upgrade: the request replayed upstream, then raw
// bytes both ways
function tunnel(route, req, socket, head, path) {
  const secure = route.scheme === 'https';
  const opts = { host: route.ip, port: route.port };
  const up = secure ? tls.connect({ ...opts, rejectUnauthorized: false }) : net.connect(opts);
  let open = false;
  up.once(secure ? 'secureConnect' : 'connect', () => {
    open = true;
    let text = `${req.method} ${path} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(upstreamHeaders(req, route, true))) {
      for (const x of [].concat(v)) text += `${k}: ${x}\r\n`;
    }
    up.write(`${text}\r\n`);
    if (head && head.length) up.write(head);
    socket.setNoDelay(true);
    up.setNoDelay(true);
    socket.pipe(up).pipe(socket);
  });
  up.on('error', () => (open ? socket.destroy() : socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')));
  up.on('close', () => socket.destroy());
  socket.on('error', () => up.destroy());
  socket.on('close', () => up.destroy());
}

// app and upgrade: the frontend's own handlers, for whatever no route claims
function listen(port, app, upgrade) {
  const server = http.createServer({ requestTimeout: 0 }, (req, res) => {
    req.ingress = true;
    const hit = resolve(req);
    if (hit.frontend && req.method === 'POST' && /^\/api\/host(\?|$)/.test(req.url)) return pinSwitch(req, res);
    const pin = hit.frontend && pinRoute(req);
    if (hit.route) forward(hit.route, req, res, hit.path);
    else if (pin) forward(pin, req, res, req.url);
    else if (hit.frontend) { pinHere(req, res); app(req, res); }
    else refuse(res, hit.status, hit.text);
  });
  // past cloudflared's 90s idle pool, so it never reuses a socket closing here
  server.keepAliveTimeout = 120000;
  server.headersTimeout = 125000;
  server.on('upgrade', (req, socket, head) => {
    req.ingress = true;
    socket.on('error', () => {});
    const hit = resolve(req);
    const pin = hit.frontend && pinRoute(req);
    if (hit.route) tunnel(hit.route, req, socket, head, hit.path);
    else if (pin) tunnel(pin, req, socket, head, req.url);
    else if (hit.frontend) upgrade(req, socket, head);
    else socket.end(`HTTP/1.1 ${hit.status} ${http.STATUS_CODES[hit.status]}\r\n\r\n`);
  });
  // no ingress, no host, container restart left to the supervisor
  server.on('error', (err) => {
    log(`can't serve on port ${port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(port, () => log(`serving ${BASE_DOMAIN} on port ${port}`));
  return server;
}

module.exports = { EXTRA_KEYS, rowError, swap, pinTargets, listen };
