'use strict';
// the mesh's own replicated tree, an /etc and /home for the pretend OS: every
// host a full copy, each file's latest write on the mesh winning, never served

const fs = require('fs');
const path = require('path');
const mesh = require('./mesh');
const { FRONTEND_PORT, readJson, requestJson, writeJsonAtomic } = require('./util');

const STATE_DIR = process.env.STATE_DIR || '/state';
const ROOT = path.join(STATE_DIR, 'sys');
const REL_RE = /^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63}){0,5}\.json$/;
// paths whose first write stays, a mesh secret two hosts made at once
const oldest = new Set();

// rel -> {at, gone?, data}
const files = new Map();

function load(dir, rel) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) load(path.join(dir, e.name), r);
    else if (REL_RE.test(r)) {
      const f = readJson(path.join(dir, e.name), null);
      if (valid(f)) files.set(r, f);
    }
  }
}

const valid = (f) => !!f && Number.isFinite(f.at) && f.at <= Date.now() + 60000 && (f.gone === true || 'data' in f);

function put(rel, f) {
  files.set(rel, f);
  const abs = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  writeJsonAtomic(abs, f);
}

const stampOf = (rel) => (files.get(rel) || {}).at || 0;
const nextAt = (rel) => Math.max(Date.now(), stampOf(rel) + 1);

function read(rel) {
  const f = files.get(rel);
  return f && !f.gone ? f.data : null;
}

function write(rel, data) {
  if (!REL_RE.test(rel)) throw new Error(`bad sys path ${rel}`);
  if (oldest.has(rel) && read(rel) !== null) return;
  put(rel, { at: nextAt(rel), data });
}

function remove(rel) {
  if (read(rel) !== null) put(rel, { at: nextAt(rel), gone: true });
}

// live files under a directory, rel to it
function list(dir) {
  const pre = `${dir}/`;
  return [...files.keys()].filter((r) => r.startsWith(pre) && read(r) !== null).map((r) => r.slice(pre.length));
}

// --- the mesh -------------------------------------------------------------

const stamps = () => Object.fromEntries([...files].map(([r, f]) => [r, f.at]));
const dump = () => Object.fromEntries(files);

const wins = (rel, at) => (oldest.has(rel) && read(rel) !== null ? at < stampOf(rel) : at > stampOf(rel));

function merge(got) {
  for (const [rel, f] of Object.entries(got && typeof got === 'object' ? got : {})) {
    if (REL_RE.test(rel) && valid(f) && wins(rel, f.at)) put(rel, f.gone ? { at: f.at, gone: true } : { at: f.at, data: f.data });
  }
}

const newer = (st) => Object.entries(st).some(([rel, at]) => REL_RE.test(rel) && Number.isFinite(at) && wins(rel, at));

let pulling = false;
async function pull() {
  if (pulling) return;
  pulling = true;
  try {
    const ips = mesh.peerIps();
    for (const { host, stamps: st } of mesh.peerSys()) {
      if (!newer(st)) continue;
      const ip = ips.get(host);
      const r = ip && await requestJson({ host: ip, port: FRONTEND_PORT, path: '/api/sys/sync', timeout: 5000 }).catch(() => null);
      if (r && r.status === 200) merge(r.body);
    }
  } finally { pulling = false; }
}

load(ROOT, '');
setInterval(() => { pull().catch(() => {}); }, 2000).unref();

module.exports = { read, write, remove, list, stamps, dump, oldestWins: (rel) => oldest.add(rel) };
