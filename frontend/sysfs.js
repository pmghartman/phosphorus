'use strict';
// the pretend OS's tree: etc/ and home/ replicated, every host a full copy,
// each file's latest write winning; var/ this host's own; never served

const fs = require('fs');
const path = require('path');
const clock = require('./clock');
const mesh = require('./mesh');
const { FRONTEND_PORT, readJson, requestJson, writeJsonAtomic } = require('./util');

// beside usr/ in [home] dir, the home's state/ unset
const ROOT = path.join(process.env.HOME_FS || process.env.STATE_DIR || '/state', 'sys');
const REL_RE = /^(etc|home)(\/[a-z0-9][a-z0-9._-]{0,63}){1,5}\.json$/;
// paths whose first write stays, a mesh secret two hosts made at once
const oldest = new Set();

// rel -> {at, gone?, data}
const files = new Map();

function load(dir, rel) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (r !== 'var') load(path.join(dir, e.name), r); }
    else if (REL_RE.test(r)) {
      const f = readJson(path.join(dir, e.name), null);
      if (valid(f)) files.set(r, f);
    }
  }
}

const valid = (f) => !!f && Number.isFinite(f.at) && f.at <= Date.now() + 60000 && (f.gone === true || 'data' in f);

function put(rel, f) {
  files.set(rel, f);
  // peers see the new stamp on their next fast poll
  clock.markHot();
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

// an older file's contents taken in at its own stamp, a newer one kept
function adopt(rel, data, at) {
  if (REL_RE.test(rel) && Number.isFinite(at) && at > stampOf(rel)) put(rel, { at, data });
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
// the whole tree, or only the files asked for
const dump = (rels) => Object.fromEntries(rels ? rels.filter((r) => files.has(r)).map((r) => [r, files.get(r)]) : files);

const wins = (rel, at) => (oldest.has(rel) && read(rel) !== null ? at < stampOf(rel) : at > stampOf(rel));

function merge(got) {
  let changed = false;
  for (const [rel, f] of Object.entries(got && typeof got === 'object' ? got : {})) {
    if (!REL_RE.test(rel) || !valid(f) || !wins(rel, f.at)) continue;
    put(rel, f.gone ? { at: f.at, gone: true } : { at: f.at, data: f.data });
    changed = true;
  }
  return changed;
}

// a peer's stamps this host lacks, one ahead of the clock left for later
const wanted = (st) => Object.entries(st)
  .filter(([rel, at]) => REL_RE.test(rel) && Number.isFinite(at) && at <= Date.now() + 60000 && wins(rel, at))
  .map(([rel]) => rel);

// var/<rel>: this host's own, an older file at <old> moved in once
function local(rel, old) {
  const abs = path.join(ROOT, 'var', rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
  if (old && !fs.existsSync(abs) && fs.existsSync(old)) {
    try { fs.renameSync(old, abs); } catch {}
  }
  return abs;
}

let pulling = null;
function pull() {
  if (!pulling) pulling = pullOnce().finally(() => { pulling = null; });
  return pulling;
}
const PULL_BATCH = 40;
async function pullOnce() {
  const ips = mesh.peerIps();
  await Promise.all(mesh.peerSys().map(async ({ host, stamps: st }) => {
    const ip = ips.get(host);
    const want = ip ? wanted(st) : [];
    for (let i = 0; i < want.length; i += PULL_BATCH) {
      const rels = want.slice(i, i + PULL_BATCH).filter((rel) => wins(rel, st[rel]));
      if (!rels.length) continue;
      const q = new URLSearchParams({ rels: rels.join(',') });
      const r = await requestJson({ host: ip, port: FRONTEND_PORT, path: `/api/sys/sync?${q}`, timeout: 5000 }).catch(() => null);
      if (!r || r.status !== 200) return;
      merge(r.body);
    }
  }));
}

load(ROOT, '');
setInterval(() => { pull().catch(() => {}); }, 1000).unref();

module.exports = { read, write, adopt, remove, list, local, stamp: stampOf, pull, stamps, dump, oldestWins: (rel) => oldest.add(rel) };
