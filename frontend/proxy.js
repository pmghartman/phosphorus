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
// every route, a subdomain's shadowed duplicate too, for icons
let everyRoute = [];
let tableFp = '[]';

function toRoute(r, ip) {
  const base = r.base_path ? `/${r.base_path}` : '';
  const sub = r.mode === 'subdomain';
  const size = String(r.max_body || '').match(SIZE_RE);
  return {
    host: r.host, name: r.name, master: r.master === true,
    // git-daemon's forgejo, behind only its own login
    git: typeof r.master === 'boolean',
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
  const every = [];
  for (const r of rows) {
    if (r.type === 'game') continue;
    const why = NAME_RE.test(r.host || '') ? rowError(r) : `'${r.host}' is not a valid host`;
    if (why) return { error: `${r.host}'s ${r.name}: ${why}` };
    const route = toRoute(r, ipOf(r.host) || r.host);
    every.push(route);
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
  return { table: { domains, paths }, every };
}

// validate then swap, the live table untouched on any failure
function swap(rows, ipOf) {
  const out = build(rows, ipOf);
  if (out.error) {
    note('table', `routes rejected, still serving the previous ones: ${out.error}`);
    return false;
  }
  clear('table');
  everyRoute = out.every;
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

// the client's own X-Forwarded-* never trusted, always replaced; the login
// cookie only ever to another host's ingress, never to a service
function upstreamHeaders(req, route, upgrade) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith('x-forwarded-') || (!upgrade && HOP.has(k))) continue;
    if (k === 'cookie' && !route.pin) {
      const kept = String(v).split(/;\s*/).filter((c) => c && !c.startsWith(`${LOGIN_COOKIE}=`)).join('; ');
      if (kept) out[k] = kept;
      continue;
    }
    out[k] = v;
  }
  out['x-forwarded-for'] = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  out['x-forwarded-proto'] = route.proto;
  out['x-forwarded-host'] = req.headers.host || '';
  if (route.pin) out[PIN_HOP] = SELF_HOST;
  return out;
}

// --- the login ------------------------------------------------------------
// every request through the ingress a logged in user's, but the page itself
// and its login calls; a page of a service sent to log in first

const LOGIN_COOKIE = 'phosphorus-user';
let passes = () => true;
let issuers = () => [];
const gated = (hit) => (hit.route ? !hit.route.git : !!hit.frontend);

// a login this host can't read yet: to the host that issued it, gated there
function issuerRoute(req) {
  if (pinHopped(req)) return null;
  const host = issuers(req).find((h) => pinIps.has(h));
  return host ? peerIngress(host) : null;
}
const OPEN_API = /^\/api\/(me|login|logout|users)(\/|$)/;

function isOpen(req, hit) {
  if (!hit.frontend) return false;
  const p = req.url.split('?')[0];
  return !p.startsWith('/api/') && !p.startsWith('/internal/') ? true : OPEN_API.test(p);
}

function deny(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  const page = req.method === 'GET' && /text\/html/.test(String(req.headers.accept || ''));
  if (page && BASE_DOMAIN) {
    const why = /(?:^|;\s*)phosphorus-user=/.test(String(req.headers.cookie || '')) ? 'refused' : 'none';
    const q = new URLSearchParams({ next: `https://${host}${req.url}`, why, by: SELF_HOST });
    res.writeHead(302, { Location: `https://${BASE_DOMAIN}/?${q}`, 'Cache-Control': 'no-store' }).end();
    return;
  }
  refuse(res, 401, `log in first${SELF_HOST ? ` (${SELF_HOST})` : ''}`);
}

// --- pinning ---------------------------------------------------------------
// no affinity across tunnel replicas: a browser held on the host it first reached

const SELF_HOST = process.env.SELF_HOST || '';
const INGRESS_PORT = Number(process.env.INGRESS_PORT || 80);
const PIN_COOKIE = 'phosphorus-host';
// set on a pinned hop, never a second hop from the far ingress
const PIN_HOP = 'x-forwarded-phosphorus-host';
const pinHopped = (req) => !!req.headers[PIN_HOP];

// live phosphorus peers, name -> tailnet IP, mesh.js's, every tick
let pinIps = new Map();
const pinTargets = (ips) => { pinIps = ips; };

const pinnedTo = (req) => (String(req.headers.cookie || '').match(/(?:^|;\s*)phosphorus-host=([a-z0-9-]+)/) || [])[1] || '';
const pinCookie = (host) => `${PIN_COOKIE}=${host}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`;

// the pinned host's ingress, or null to serve here
function pinRoute(req) {
  if (!SELF_HOST || pinHopped(req)) return null;
  const host = pinnedTo(req);
  return host && host !== SELF_HOST ? peerIngress(host) : null;
}

function peerIngress(host) {
  const ip = pinIps.get(host);
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
  if (SELF_HOST && !pinHopped(req) && pinnedTo(req) !== SELF_HOST) res.setHeader('Set-Cookie', pinCookie(SELF_HOST));
}

function refuse(res, status, text) {
  if (res.headersSent) { if (!res.writableEnded) res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
}

// a subdomain's app framed by the desktop on the base domain, no one else
function frameable(csp) {
  const own = `frame-ancestors 'self' https://${BASE_DOMAIN}`;
  const kept = String(csp).split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors(\s|$)/i.test(d));
  return [...kept, own].join('; ');
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
      const k = pr.rawHeaders[i].toLowerCase();
      if (HOP.has(k)) continue;
      if (route.domain && k === 'x-frame-options') continue;
      const v = route.domain && k === 'content-security-policy' ? frameable(pr.rawHeaders[i + 1]) : pr.rawHeaders[i + 1];
      if (v) headers.push(pr.rawHeaders[i], v);
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
function listen(port, app, upgrade, gate) {
  if (gate) ({ pass: passes, issuers } = gate);
  const server = http.createServer({ requestTimeout: 0 }, (req, res) => {
    req.ingress = true;
    const hit = resolve(req);
    const hop = hit.frontend && req.method === 'POST' && /^\/api\/host(\?|$)/.test(req.url);
    // a pinned request gated by the host serving it
    const pin = hit.frontend && !hop && pinRoute(req);
    if (gated(hit) && !pin && !isOpen(req, hit) && !passes(req)) {
      const via = issuerRoute(req);
      return via ? forward(via, req, res, req.url) : deny(req, res);
    }
    if (hop) return pinSwitch(req, res);
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
    if (gated(hit) && !pin && !passes(req)) {
      const via = issuerRoute(req);
      if (via) tunnel(via, req, socket, head, req.url);
      else socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return;
    }
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

// --- favicons -----------------------------------------------------------------
// a service's own icon for the desktop: its page's <link rel=icon>, else
// /favicon.ico, fetched upstream as the proxy would, kept a while

const ICON_MAX = 256 * 1024;
const ICON_KEEP_MS = 3600000;
const ICON_MISS_MS = 600000;
const icons = new Map();

// {type, body, path}, redirects on the same upstream followed; a page cut
// at max, anything else over it dropped
function grab(route, path, max, { page = false, hops = 4 } = {}) {
  return new Promise((resolve) => {
    const host = route.domain || BASE_DOMAIN;
    const req = (route.scheme === 'https' ? https : http).get({
      host: route.ip, port: route.port, path, timeout: 4000, agent: agents[route.scheme],
      headers: {
        host, accept: page ? 'text/html,*/*;q=0.8' : 'image/*,*/*;q=0.8', 'user-agent': 'Mozilla/5.0 (phosphorus icons)',
        'x-forwarded-host': host, 'x-forwarded-proto': route.proto, 'x-forwarded-prefix': route.prefix,
      },
    }, (res) => {
      const to = res.statusCode >= 300 && res.statusCode < 400 && res.headers.location;
      if (to) {
        res.resume();
        const next = hops > 0 && iconPath(route, to, path);
        resolve(next && next !== path ? grab(route, next, max, { page, hops: hops - 1 }) : null);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const parts = [];
      let n = 0;
      const done = () => resolve({ type: String(res.headers['content-type'] || ''), body: Buffer.concat(parts), path });
      res.on('data', (c) => {
        n += c.length;
        if (n <= max) { parts.push(c); return; }
        req.destroy();
        if (page) done(); else resolve(null);
      });
      res.on('end', done);
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// an href off the page, as an upstream path, the public prefix dropped
function iconPath(route, href, from = '/') {
  let u;
  try { u = new URL(href.replace(/&amp;/g, '&'), new URL(from, 'http://upstream/')); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  if (u.host !== 'upstream' && u.hostname !== (route.domain || BASE_DOMAIN)) return '';
  const p = route.prefix && under(u.pathname, route.prefix) ? strip(u.pathname, route.prefix) : u.pathname;
  return p + u.search;
}

// by its bytes when the server names it wrong
function sniff(b) {
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (b.readUInt32BE(0) === 0x00000100) return 'image/x-icon';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'image/gif';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (/^\uFEFF?\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(b.toString('utf8', 0, 1024))) return 'image/svg+xml';
  return '';
}

function asImage(r) {
  if (!r || r.body.length < 4) return null;
  const named = r.type.split(';')[0].trim().toLowerCase();
  const type = sniff(r.body) || (/^image\//.test(named) ? named : '');
  return type ? { type, body: r.body } : null;
}

const fromData = (href) => {
  const m = href.match(/^data:(image\/[a-z0-9.+-]+)(;base64)?,(.*)$/is);
  if (!m) return null;
  try { return { type: m[1].toLowerCase(), body: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])) }; } catch { return null; }
};

// a web manifest's icons, biggest first, as upstream paths
async function manifestIcons(route, href, from) {
  const path = iconPath(route, href, from);
  const r = path && await grab(route, path, ICON_MAX);
  let icons;
  try { icons = JSON.parse(r.body.toString('utf8')).icons; } catch { return []; }
  if (!Array.isArray(icons)) return [];
  const size = (i) => Math.max(0, ...String(i.sizes || '').split(/\s+/).map((x) => parseInt(x, 10) || (x === 'any' ? 1024 : 0)));
  return icons.filter((i) => i && typeof i.src === 'string').sort((a, b) => size(b) - size(a))
    .map((i) => iconPath(route, i.src, path)).filter(Boolean);
}

// rel=icon, then apple-touch-icon, the manifest's, then the usual paths
async function lookIcon(route) {
  const page = await grab(route, '/', ICON_MAX * 4, { page: true });
  const html = page && /html/.test(page.type) ? page.body.toString('utf8') : '';
  const from = page?.path || '/';
  const icons = [];
  const touch = [];
  let manifest = '';
  for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
    const rel = (tag.match(/\brel\s*=\s*["']?([^"'>]*)/i) || [])[1] || '';
    const m = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i) || tag.match(/\bhref\s*=\s*([^\s"'>]+)/i);
    if (m && /\bmanifest\b/i.test(rel)) manifest ||= m[1].trim();
    if (!/icon/i.test(rel) || /mask-icon/i.test(rel)) continue;
    if (m) (/apple-touch/i.test(rel) ? touch : icons).push(m[1].trim());
  }
  for (const h of [...icons, ...touch]) {
    const d = h.startsWith('data:') ? fromData(h) : null;
    if (d) return d;
  }
  const paths = [...icons, ...touch].filter((h) => !h.startsWith('data:')).map((h) => iconPath(route, h, from)).filter(Boolean);
  if (manifest) paths.push(...await manifestIcons(route, manifest, from));
  for (const path of new Set([...paths, '/favicon.ico', '/favicon.png', '/favicon.svg', '/apple-touch-icon.png', '/static/favicon.ico'])) {
    const r = asImage(await grab(route, path, ICON_MAX));
    if (r) return r;
  }
  return null;
}

// {type, body}, null when the service has none
function favicon(host, name) {
  const key = `${host}/${name}`;
  const held = icons.get(key);
  if (held && Date.now() < held.until) return held.icon;
  const route = everyRoute.find((r) => r.host === host && r.name === name);
  if (!route) return Promise.resolve(null);
  const icon = lookIcon(route).catch(() => null);
  icons.set(key, { icon, until: Date.now() + ICON_KEEP_MS });
  icon.then((v) => { if (!v) icons.set(key, { icon, until: Date.now() + ICON_MISS_MS }); });
  return icon;
}

module.exports = { EXTRA_KEYS, rowError, swap, pinTargets, listen, favicon };
