'use strict';
// home files kept on every host: one sys entry per file (etc/mirror/<id>),
// stamped by the host that wrote it last, every other host pulling that copy
// over the tailnet; a removed entry deletes the copies it made

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const sys = require('./sysfs');
const files = require('./files');
const { readJson, writeJsonAtomic } = require('./util');

// small files only, the large ones live on one host
const MAX = 32 * 1024 * 1024;
const TICK_MS = 3000;
const DIR = 'etc/mirror';
const APPLIED = sys.local('mirror-applied.json');
const SELF = process.env.SELF_HOST || '';

const idOf = (rel) => crypto.createHash('sha256').update(rel).digest('hex').slice(0, 24);
const entryRel = (id) => `${DIR}/${id}.json`;
const share = () => files.shareOf('home');

// id -> {at, path}: the stamp each local copy was taken at
let applied = readJson(APPLIED, {}) || {};
const saveApplied = () => { try { writeJsonAtomic(APPLIED, applied); } catch {} };

const entry = (rel) => sys.read(entryRel(idOf(rel)));
const isMirrored = (rel) => !!entry(rel);

function sizeOf(rel) {
  const sh = share();
  const abs = sh && files.downloadPath(sh, rel);
  try { return abs ? fs.statSync(abs).size : -1; } catch { return -1; }
}

// this host's copy the one every other takes
function mark(rel) {
  const size = sizeOf(rel);
  if (size < 0) return [404, { error: 'no such file' }];
  if (size > MAX) return [413, { error: 'over 32MB, kept on one host' }];
  const id = idOf(rel);
  sys.write(entryRel(id), { path: rel, size, from: SELF });
  applied[id] = { at: sys.stamp(entryRel(id)), path: rel };
  saveApplied();
  return [200, { ok: true, all: true }];
}

function unmark(rel) {
  sys.remove(entryRel(idOf(rel)));
  return [200, { ok: true, all: false }];
}

// a write, rename or delete in the home, a mirrored path's entry following it
function touched(op, rel, to) {
  if (op === 'delete') {
    for (const id of sys.list(DIR).map((f) => f.slice(0, -5))) {
      const e = sys.read(entryRel(id));
      if (e && (e.path === rel || e.path.startsWith(`${rel}/`))) sys.remove(entryRel(id));
    }
  } else if (op === 'rename') {
    if (isMirrored(rel)) { unmark(rel); mark(to); }
  } else if (isMirrored(rel)) {
    if (mark(rel)[0] !== 200) unmark(rel);
  }
}

// GET /internal/mirror/<id> from a peer: this host's copy, when it's the latest
function serve(id, res) {
  const e = /^[0-9a-f]{24}$/.test(id) && sys.read(entryRel(id));
  const sh = share();
  const abs = e && e.from === SELF && sh && files.downloadPath(sh, e.path);
  if (!abs) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(abs).size });
  fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
}

function fetchTo(ip, port, id, tmp) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: `/internal/mirror/${id}`, timeout: 60000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => resolve(true));
      out.on('error', () => resolve(false));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

let busy = false;
async function tick(ipOf, port) {
  const sh = share();
  if (busy || !sh) return;
  busy = true;
  try {
    const live = new Set();
    for (const id of sys.list(DIR).map((f) => f.slice(0, -5))) {
      live.add(id);
      const e = sys.read(entryRel(id));
      const at = sys.stamp(entryRel(id));
      if (!e || (applied[id] && applied[id].at >= at)) continue;
      if (e.from === SELF) { applied[id] = { at, path: e.path }; continue; }
      const ip = await ipOf(e.from);
      files.makeParents(sh, e.path);
      const abs = ip && files.safePath(sh, e.path, false);
      if (!abs) continue;
      const tmp = path.join(path.dirname(abs), `.phosphorus-upload-mirror-${id}`);
      const was = applied[id]?.path;
      if (!(await fetchTo(ip, port, id, tmp))) { fs.rm(tmp, { force: true }, () => {}); continue; }
      try { fs.renameSync(tmp, abs); } catch { fs.rm(tmp, { force: true }, () => {}); continue; }
      applied[id] = { at, path: e.path };
      // an earlier copy at another path dropped
      const old = was && was !== e.path && files.safePath(sh, was, true);
      if (old) fs.rm(old, { force: true }, () => {});
    }
    // entries gone since a copy was made here: the copy too
    for (const [id, a] of Object.entries(applied)) {
      if (live.has(id) || sys.stamp(entryRel(id)) <= a.at) continue;
      const abs = files.safePath(sh, a.path, true);
      if (abs) fs.rm(abs, { force: true }, () => {});
      delete applied[id];
    }
  } finally {
    saveApplied();
    busy = false;
  }
}

function start(ipOf, port) {
  setInterval(() => { tick(ipOf, port).catch(() => {}); }, TICK_MS).unref();
}

module.exports = { MAX, isMirrored, mark, unmark, touched, serve, start };
