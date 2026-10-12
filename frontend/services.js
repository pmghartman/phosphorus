'use strict';
// this host's own services: services.export validated whole or not at all,
// then health checked, live ones, every game and the git-role row published

const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const clock = require('./clock');
const { EXTRA_KEYS, rowError } = require('./proxy');
const { notes, readJson } = require('./util');

const SERVICES_FILE = process.env.SERVICES_FILE || '/etc/hesperus/services.export';
const STATE_DIR = process.env.STATE_DIR || '/state';
// git-daemon's output file
const GIT_ROLE_FILE = path.join(STATE_DIR, 'git-role');
// a local hop, not a tailnet one, a stuck probe failing fast
const PROBE_TIMEOUT_MS = 1000;
// every connection logged by game servers, a connect at most this often
const GAME_CONNECT_MS = 10000;
// starting/stopping shown at most this long
const GAME_ACTION_MS = { start: 180000, stop: 60000 };
const KEYS = new Set(['port', 'scheme', 'mode', 'base_path', 'extras', 'type', 'start', 'stop']);

const { note, clear, reset } = notes('services');

// --- services.export -------------------------------------------------------

// every section as a declared row, or the first reason the file is rejected
function parse(text) {
  const sections = [];
  let cur = null;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /^[#;]/.test(line)) continue;
    const head = line.match(/^\[\s*(.*?)\s*\]$/);
    if (head) { cur = { name: head[1], f: {} }; sections.push(cur); continue; }
    const eq = line.indexOf('=');
    if (eq < 0) return { error: `line ${i + 1} is not key = value` };
    const key = line.slice(0, eq).trim();
    if (!cur) return { error: `line ${i + 1}: ${key} outside any [section]` };
    if (!KEYS.has(key)) return { error: `[${cur.name}] has an unknown key, ${key}` };
    cur.f[key] = line.slice(eq + 1).trim().replace(/^"|"$/g, '');
  }

  const rows = [];
  const names = new Set();
  for (const { name, f } of sections) {
    if (names.has(name)) return { error: `[${name}] is declared twice` };
    names.add(name);
    const port = /^[0-9]+$/.test(f.port || '') ? Number(f.port) : f.port;
    let row;
    if (f.type === 'game') {
      row = { name, port, type: 'game', mode: 'game', controllable: !!(f.start && f.stop) };
    } else {
      let extras;
      try { extras = JSON.parse(f.extras || '{}'); } catch { return { error: `[${name}] extras is not valid JSON` }; }
      if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return { error: `[${name}] extras is not a JSON object` };
      const odd = Object.keys(extras).find((k) => !EXTRA_KEYS.includes(k));
      if (odd) return { error: `[${name}] extras has an unknown key, ${odd}` };
      // extras' keys spread onto the row, no wrapper field
      row = { ...extras, name, port, scheme: f.scheme || 'http', mode: f.mode || 'path', base_path: f.base_path || '' };
      if (f.type) row.type = f.type;
    }
    const why = rowError(row);
    if (why) return { error: `[${name}] ${why}` };
    rows.push(row);
  }
  return { rows };
}

let text = null;
let declared = [];

// re-parsed only when the text changes, a rejected file keeping the last good rows
function readDeclared() {
  let t;
  try {
    t = fs.readFileSync(SERVICES_FILE, 'utf8');
    clear('file');
  } catch {
    note('file', `can't read ${SERVICES_FILE}; publishing nothing`);
    text = null;
    declared = [];
    return;
  }
  if (t === text) return;
  text = t;
  const out = parse(t);
  if (out.error) {
    note('parse', `${SERVICES_FILE} rejected, still publishing the last good one: ${out.error}`);
    return;
  }
  note('parse', `${SERVICES_FILE} read: ${out.rows.length} declared`);
  declared = out.rows;
  // every verdict logged afresh against the new file
  reset('svc:');
}

// --- health ----------------------------------------------------------------

// key -> { at, up, busy }, answered from the last result, never awaited,
// undefined until the first one lands
const probes = new Map();

function probe(key, everyMs, check) {
  let p = probes.get(key);
  if (!p) { p = { at: 0, up: undefined, busy: false }; probes.set(key, p); }
  p.seen = true;
  if (!p.busy && Date.now() - p.at >= everyMs) {
    p.busy = true;
    p.at = Date.now();
    check().then((up) => {
      if (up !== p.up) clock.markHot();
      p.up = up;
      p.busy = false;
    });
  }
  return p.up;
}

// any HTTP answer alive, at the address about to be published
function answers(scheme, host, port, base) {
  return new Promise((resolve) => {
    const req = (scheme === 'https' ? https : http).get({
      host, port, path: `/${base}`, timeout: PROBE_TIMEOUT_MS, agent: false, rejectUnauthorized: false,
    }, (res) => { res.destroy(); resolve(true); });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function connects(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: PROBE_TIMEOUT_MS });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => s.destroy());
    s.once('error', () => resolve(false));
    s.once('close', () => resolve(false));
  });
}

// listening ports on a wildcard or ip (host netns on Linux), null if ss can't say
function listening(ip) {
  return new Promise((resolve) => {
    execFile('ss', ['-Htln'], { timeout: 2000 }, (err, out) => {
      if (err) { resolve(null); return; }
      const ports = new Set();
      for (const line of String(out).split('\n')) {
        const m = (line.trim().split(/\s+/)[3] || '').match(/^(.*):(\d+)$/);
        if (m && ['0.0.0.0', '*', '[::]', ip].includes(m[1])) ports.add(Number(m[2]));
      }
      resolve(ports);
    });
  });
}

// --- game presses ----------------------------------------------------------

// name -> { action, until }, starting/stopping until the port flips
const pending = new Map();

function setPending(name, action) {
  if (action) pending.set(name, { action, until: Date.now() + GAME_ACTION_MS[action] });
  else pending.delete(name);
  clock.markHot();
}

function pendingFor(name) {
  const p = pending.get(name);
  if (p && p.until > Date.now()) return p.action;
  pending.delete(name);
  return '';
}

// --- rows ------------------------------------------------------------------

function gameRow(r, ip, ports) {
  // ss first, a connect only when it can't see the port
  const up = (ports && ports.has(r.port)) || probe(`game:${ip}:${r.port}`, GAME_CONNECT_MS, () => connects(ip, r.port));
  const press = pendingFor(r.name);
  const status = up ? (press === 'stop' ? 'stopping' : 'online') : (press === 'start' ? 'starting' : 'offline');
  note(`svc:${r.name}`, `game ${r.name} on port ${r.port} is ${status}`);
  return { ...r, status };
}

function webRow(r, ip) {
  const up = probe(`web:${r.scheme}:${ip}:${r.port}:${r.base_path}`, clock.IDLE_MS, () => answers(r.scheme, ip, r.port, r.base_path));
  if (up === undefined) return null;
  note(`svc:${r.name}`, up ? `${r.name} is up on port ${r.port}, published` : `${r.name} is not answering on port ${r.port}, not published`);
  return up ? r : null;
}

// git-daemon's publish decision, held to the same rules as services.export
function gitRow(ip) {
  const g = readJson(GIT_ROLE_FILE, null);
  if (!g || g.publish !== true) { clear('git'); return null; }
  const row = {
    name: g.name, port: g.port, scheme: g.scheme || 'http', mode: g.mode || 'subdomain',
    base_path: g.base_path || '', master: g.master === true,
  };
  const why = rowError(row);
  if (why) { note('git', `ignoring git-role: ${why}`); return null; }
  const up = probe(`web:${row.scheme}:${ip}:${row.port}:${row.base_path}`, clock.IDLE_MS, () => answers(row.scheme, ip, row.port, row.base_path));
  if (up === undefined) return null;
  note('git', up ? `${row.name} is up on port ${row.port}, published (master=${row.master})`
    : `git-role says publish, but ${row.name} is not answering on port ${row.port}, not published`);
  return up ? row : null;
}

let own = [];
let lastScan = 0;
let ports = null;

// once per tick at ip, the tailnet address peers route to
async function refresh(ip) {
  readDeclared();
  const pressing = [...pending.keys()].some(pendingFor);
  // a port flip being watched, fast rate held
  if (pressing) clock.markHot();
  if (declared.some((r) => r.type === 'game') && (pressing || Date.now() - lastScan >= clock.IDLE_MS)) {
    lastScan = Date.now();
    ports = await listening(ip);
  }
  for (const p of probes.values()) p.seen = false;
  const rows = declared.map((r) => (r.type === 'game' ? gameRow(r, ip, ports) : webRow(r, ip)));
  rows.push(gitRow(ip));
  // checks for services gone from the file dropped
  for (const [k, p] of probes) if (!p.seen && !p.busy) probes.delete(k);
  own = rows.filter(Boolean);
  return own;
}

module.exports = { parse, refresh, setPending, own: () => own };
