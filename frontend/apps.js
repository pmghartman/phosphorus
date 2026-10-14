'use strict';
// app tabs, Linux hosts only: .desktop entries off the host's root, each one
// launched over ssh on its own xpra display, xpra's html5 client proxied here

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { Client } = require('ssh2');
const WebSocket = require('ws');
const { phosphorusIni } = require('./util');

// the host's / as compose mounts it, unset under a desktop VM
const HOST_ROOT = process.env.PHOSPHORUS_HOST_ROOT ? '/hostfs' : '';
const APP_DIRS = [
  '/usr/share/applications', '/usr/local/share/applications',
  '/var/lib/flatpak/exports/share/applications', '/var/lib/snapd/desktop/applications',
];
const XPRA = ['/usr/bin/xpra', '/usr/local/bin/xpra'];
// a long list rescanned at most this often
const LIST_TTL_MS = 30000;
const LOGIN_TIMEOUT_MS = 120000;
const START_TIMEOUT_MS = 30000;
// a dropped socket's app, held for the tab to rejoin
const GRACE_MS = 10 * 60000;
const MAX_TRIES = 3;
const MAX_FIELD = 256;
const MAX_APPS = 8;
// as term.js: gone for good, taken by another tab
const ENDED = 4000;
const TAKEN = 4001;
const ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
// what xpra printed last, for a failed start's reason
const LOG_MAX = 4096;

const enabled = () => phosphorusIni('apps', 'host') === 'true';

// [Desktop Entry]'s own keys, localized ones skipped
function parseDesktop(text) {
  const out = {};
  let on = false;
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^\[(.+)\]\s*$/);
    if (head) { on = head[1] === 'Desktop Entry'; continue; }
    const kv = on && line.match(/^([A-Za-z0-9-]+)\s*=\s*(.*)$/);
    if (kv && !(kv[1] in out)) out[kv[1]] = kv[2];
  }
  return out;
}

// Exec's field codes dropped, nothing passed to them
const execLine = (exec) => exec.replace(/%[fFuUdDnNickvm]/g, '').replace(/%%/g, '%').replace(/\s+/g, ' ').trim();

// flatpak's exports absolute links into the host's tree
function hostPath(p) {
  try {
    const t = fs.readlinkSync(p);
    return t.startsWith('/') ? HOST_ROOT + t : path.resolve(path.dirname(p), t);
  } catch { return p; }
}

let cache = { at: 0, apps: [] };
function scan() {
  if (Date.now() - cache.at < LIST_TTL_MS) return cache.apps;
  const seen = new Map();
  for (const dir of APP_DIRS) {
    let names;
    try { names = fs.readdirSync(HOST_ROOT + dir); } catch { continue; }
    for (const f of names) {
      const id = f.replace(/\.desktop$/, '');
      if (id === f || !ID.test(id) || seen.has(id)) continue;
      let e;
      try { e = parseDesktop(fs.readFileSync(hostPath(path.join(HOST_ROOT + dir, f)), 'utf8')); } catch { continue; }
      if (e.Type !== 'Application' || e.NoDisplay === 'true' || e.Hidden === 'true' || e.Terminal === 'true') continue;
      const exec = execLine(e.Exec || '');
      if (exec && e.Name) seen.set(id, { id, name: e.Name, exec });
    }
  }
  cache = { at: Date.now(), apps: [...seen.values()].sort((a, b) => a.name.localeCompare(b.name)) };
  return cache.apps;
}

const hasXpra = () => XPRA.some((p) => fs.existsSync(HOST_ROOT + p));

// why this host lists nothing, '' when it can
function blocked(platform) {
  if (!enabled()) return 'apps are off here, [apps] host in phosphorus.ini';
  if (platform !== 'linux') return 'apps are Linux only for now';
  if (!HOST_ROOT) return "can't see the host's root";
  if (!hasXpra()) return 'xpra is not installed on this host, phosphorus start installs it';
  return '';
}

function list(platform) {
  const why = blocked(platform);
  return [200, { on: enabled(), why, apps: why ? [] : scan().map(({ id, name }) => ({ id, name })) }];
}

// --- sessions ---------------------------------------------------------------

// sid -> session, from login until its ssh channel closes
const sessions = new Map();

const sq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const answers = (port) => new Promise((resolve) => {
  const c = net.connect(port, '127.0.0.1');
  c.on('connect', () => { c.destroy(); resolve(true); });
  c.on('error', () => resolve(false));
});

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function createSession(sid, app) {
  const s = { sid, app, ws: null, client: null, port: 0, ready: false, log: '', graceTimer: null, onAuth: null };

  s.end = (why) => {
    if (!sessions.has(sid)) return;
    sessions.delete(sid);
    clearTimeout(s.graceTimer);
    clearTimeout(s.loginTimer);
    if (why) send(s.ws, { type: 'error', text: why });
    // the pty's hangup takes xpra and the app with it
    if (s.client) s.client.end();
    if (s.ws) s.ws.close(ENDED);
  };

  s.join = (ws) => {
    clearTimeout(s.graceTimer);
    if (s.ws && s.ws !== ws) s.ws.close(TAKEN);
    s.ws = ws;
    if (s.ready) send(ws, { type: 'ready' });
    ws.on('message', (data, isBinary) => {
      if (s.ws !== ws || isBinary) return;
      let m;
      try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.type === 'close') s.end();
      else if (m.type === 'auth' && s.onAuth) s.onAuth(String(m.user || '').slice(0, MAX_FIELD), String(m.password || '').slice(0, MAX_FIELD));
    });
    ws.on('close', () => {
      if (s.ws !== ws) return;
      s.ws = null;
      // a login in progress, not worth keeping
      if (!s.ready) s.end();
      else s.graceTimer = setTimeout(() => s.end(), GRACE_MS);
    });
  };

  sessions.set(sid, s);
  return s;
}

// null once xpra answers on its port, else why not
function launch(s, user, password, { sshHost, port }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (why) => { if (!done) { done = true; resolve(why); } };
    const c = new Client();
    s.client = c;
    c.on('keyboard-interactive', (_n, _i, _l, prompts, reply) => reply(prompts.map(() => password)));
    c.on('error', (err) => finish(err.level === 'client-authentication' ? 'access denied' : err.message));
    c.on('close', () => { finish('the connection closed'); if (s.ready) s.end('the app closed'); });
    c.on('ready', async () => {
      try { s.port = await freePort(); } catch (e) { finish(e.message); return; }
      // the app's own display, gone with the app or the channel
      const cmd = ['exec xpra start --daemon=no --mdns=no --html=on',
        `--bind-tcp=127.0.0.1:${s.port}`, '--exit-with-children=yes', '--terminate-children=yes',
        `--start-child=${sq(s.app.exec)}`].join(' ');
      c.exec(cmd, { pty: { term: 'dumb', cols: 200, rows: 50 } }, (err, st) => {
        if (err) { finish(err.message); return; }
        const keep = (d) => { s.log = (s.log + d.toString()).slice(-LOG_MAX); };
        st.on('data', keep);
        st.stderr.on('data', keep);
        st.on('close', () => {
          const last = s.log.trim().split(/\r?\n/).pop() || 'xpra exited';
          finish(last);
          if (s.ready) s.end('the app closed');
        });
        const until = Date.now() + START_TIMEOUT_MS;
        (async function wait() {
          while (!done && Date.now() < until) {
            if (await answers(s.port)) { finish(null); return; }
            await new Promise((r) => setTimeout(r, 400));
          }
          finish(`xpra never answered: ${s.log.trim().split(/\r?\n/).pop() || 'no output'}`);
        })();
      });
    });
    c.connect({ host: sshHost, port, username: user, password, tryKeyboard: true, readyTimeout: 10000 });
  });
}

// the tab's socket: a login, then ready, the stream itself on /api/appview
function attach(ws, { host, sid, id, resume, sshHost, port, platform }) {
  ws.on('error', () => {});
  const live = sessions.get(sid);
  if (live) { live.join(ws); return; }
  const refuse = (text) => { send(ws, { type: 'error', text }); ws.close(ENDED); };
  if (resume) { refuse('session ended'); return; }
  const why = blocked(platform);
  if (why) { refuse(why); return; }
  if (sessions.size >= MAX_APPS) { refuse(`${MAX_APPS} apps already open on ${host}`); return; }
  const app = scan().find((a) => a.id === id);
  if (!app) { refuse(`no app ${id} on ${host}`); return; }

  const s = createSession(sid, app);
  s.join(ws);
  s.loginTimer = setTimeout(() => { if (!s.ready) s.end('login timed out'); }, LOGIN_TIMEOUT_MS);

  (async () => {
    for (let i = 0; i < MAX_TRIES && sessions.has(sid); i++) {
      send(s.ws, { type: 'login', host, why: i ? 'try again' : '' });
      const [user, password] = await new Promise((r) => { s.onAuth = (u, p) => r([u, p]); });
      s.onAuth = null;
      if (!sessions.has(sid)) return;
      send(s.ws, { type: 'status', text: `starting ${app.name}…` });
      const failed = await launch(s, user, password, { sshHost, port });
      if (!sessions.has(sid)) return;
      if (!failed) {
        s.ready = true;
        clearTimeout(s.loginTimer);
        send(s.ws, { type: 'ready' });
        return;
      }
      if (failed !== 'access denied') { s.end(failed); return; }
      s.client = null;
    }
    s.end('access denied');
  })();
}

// --- the stream: xpra's html5 client and its socket, under the session's path

function upstream(sid) {
  const s = sessions.get(sid);
  return s && s.ready ? s.port : 0;
}

// url: the path past /api/appview/<host>/<sid>, or the whole one to a peer
function proxyHttp(req, res, port, ip, url, extra = {}) {
  const up = http.request({ host: ip, port, method: req.method, path: url, headers: { ...req.headers, ...extra } }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502).end('the app is gone'); else res.destroy(); });
  req.pipe(up);
}

// a raw splice, the upgrade's own handshake passed through
function proxyUpgrade(req, socket, head, port, ip, url, extra = {}) {
  const up = net.connect(port, ip);
  socket.on('error', () => up.destroy());
  up.on('error', () => socket.destroy());
  up.on('connect', () => {
    let out = `${req.method} ${url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries({ ...req.headers, ...extra })) for (const x of [].concat(v)) out += `${k}: ${x}\r\n`;
    up.write(`${out}\r\n`);
    if (head && head.length) up.write(head);
    socket.pipe(up).pipe(socket);
  });
}

const sessionCount = () => sessions.size;

module.exports = { list, attach, upstream, proxyHttp, proxyUpgrade, sessionCount, ENDED, TAKEN };
