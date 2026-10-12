'use strict';
// shared helpers: JSON files on disk, JSON over HTTP, phos.ini, tailnet name
// lookups and change-only logging

const { execFile } = require('child_process');
const fs = require('fs');
const http = require('http');

const FRONTEND_PORT = Number(process.env.FRONTEND_PORT || 8090);
const PHOS_INI_FILE = process.env.PHOS_INI_FILE || '/etc/phosphorus/phos.ini';

// one key of phos.ini, blank when unset, re-parsed only on a stat change
// (edited in place, asked many times a second)
let ini = { sig: '', keys: new Map() };
function phosIni(section, key) {
  let st;
  try { st = fs.statSync(PHOS_INI_FILE); } catch { return ''; }
  const sig = `${st.ino}:${st.size}:${st.mtimeMs}`;
  if (sig !== ini.sig) {
    let text = '';
    try { text = fs.readFileSync(PHOS_INI_FILE, 'utf8'); } catch {}
    const keys = new Map();
    let current = '';
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*[;#]/.test(line)) continue;
      const head = line.match(/^\s*\[\s*(.+?)\s*\]\s*$/);
      if (head) { current = head[1]; continue; }
      const kv = line.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);
      const k = kv && `${current}\0${kv[1]}`;
      if (k && !keys.has(k)) keys.set(k, kv[2].replace(/^"|"$/g, ''));
    }
    ini = { sig, keys };
  }
  return ini.keys.get(`${section}\0${key}`) || '';
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// a daemon's json while refreshed within maxAgeMs, else null, re-parsed
// only once rewritten (peers ask many times a second)
const fresh = new Map();
function readFresh(file, maxAgeMs) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (Date.now() - st.mtimeMs > maxAgeMs) return null;
  const sig = `${st.ino}:${st.mtimeMs}`;
  const hit = fresh.get(file);
  if (hit && hit.sig === sig) return hit.value;
  const value = readJson(file, null);
  fresh.set(file, { sig, value });
  return value;
}

// temp then rename, so a reader never sees half a file
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// the same off the hot path: the caller's broadcast first, one write in flight
// per file, the latest data next, anything unwritten flushed on exit
const dueWrites = new Map();
const lastWrites = new Map();
async function drainWrites(file) {
  await null;
  while (dueWrites.has(file)) {
    const data = dueWrites.get(file);
    dueWrites.delete(file);
    const tmp = `${file}.${process.pid}.soon.tmp`;
    try {
      await fs.promises.writeFile(tmp, JSON.stringify(data));
      await fs.promises.rename(tmp, file);
    } catch (err) { console.warn(`[frontend] couldn't write ${file}: ${err.message}`); }
  }
  lastWrites.delete(file);
}
function writeJsonSoon(file, data) {
  const idle = !lastWrites.has(file);
  dueWrites.set(file, data);
  lastWrites.set(file, data);
  if (idle) drainWrites(file);
}
process.on('exit', () => { for (const [file, data] of lastWrites) try { writeJsonAtomic(file, data); } catch {} });

// host -> tailnet IPv4, as mesh's discovery last listed them, so a hop
// never waits on a tailscale exec
let knownIps = new Map();
function noteTailnetIps(ips) {
  knownIps = new Map([...ips].filter(([, ip]) => /^\d+\.\d+\.\d+\.\d+$/.test(ip || '')));
}

// asked of tailscale when not already known: a host's own /etc/hosts entry
// shadows MagicDNS for its own name, blank when unknown
function tailnetIp(name) {
  const known = knownIps.get(name);
  if (known) return Promise.resolve(known);
  return new Promise((resolve) => {
    execFile('tailscale', ['ip', '-4', name], { timeout: 3000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout).trim());
    });
  });
}

// {status, body, text}, body null for non-JSON, rejects only on a failed
// request, timeout idle, connectTimeout for a peer that never picks up
function requestJson({ host, port, method = 'GET', path, body, timeout, connectTimeout }) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host, port, method, path, timeout,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed, text });
      });
      res.on('error', reject);
    });
    if (connectTimeout) {
      req.on('socket', (s) => {
        if (!s.connecting) return; // a kept-alive socket, already there
        const t = setTimeout(() => req.destroy(new Error('timed out connecting')), connectTimeout);
        s.once('connect', () => clearTimeout(t));
      });
    }
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(data || undefined);
  });
}

// [status, body] from a peer's frontend, never rejects, a non-JSON answer
// as the error text
function peerCall(host, opts) {
  return requestJson({ port: FRONTEND_PORT, ...opts })
    .then((r) => [r.status, r.body || { error: r.text.trim() || `status ${r.status}` }])
    .catch((e) => [502, { error: `${host} didn't answer: ${e.message}` }]);
}

// re-run every tick, logged only when a key's message changes
function notes(tag) {
  const last = new Map();
  const log = (msg) => console.log(`[${tag}] ${msg}`);
  const note = (key, msg) => {
    if (last.get(key) === msg) return;
    last.set(key, msg);
    log(msg);
  };
  // every key under a prefix, so each of them logs again
  const reset = (prefix) => { for (const k of last.keys()) if (k.startsWith(prefix)) last.delete(k); };
  return { log, note, clear: (key) => last.delete(key), reset };
}

module.exports = { FRONTEND_PORT, notes, phosIni, readJson, readFresh, writeJsonAtomic, writeJsonSoon, noteTailnetIps, tailnetIp, requestJson, peerCall };
