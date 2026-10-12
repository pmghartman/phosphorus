'use strict';
// chat attachments: kept on the host they were sent to, pulled from it by any
// other host on first view and cached there, the oldest dropped past the cap

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { Transform, pipeline } = require('stream');

const DIR = path.join(process.env.STATE_DIR || '/state', 'chat-media');
const MAX_FILE = Number(process.env.CHAT_MEDIA_MAX_MB || 25) * 1024 * 1024;
const MAX_TOTAL = Number(process.env.CHAT_MEDIA_TOTAL_MB || 1024) * 1024 * 1024;
const MAX_FILES = 8;
const ID = /^[0-9a-f]{32}$/;
const HOST = /^[a-z0-9][a-z0-9-]{0,62}$/;

// shown in the page, everything else a download, never html or svg
const INLINE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/ogg',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/mp4', 'audio/aac', 'audio/flac',
  'application/pdf', 'text/plain',
]);

const where = (host, id) => path.join(DIR, host, id);
const valid = (host, id) => HOST.test(host || '') && ID.test(id || '');

function meta(host, id) {
  if (!valid(host, id)) return null;
  try { return JSON.parse(fs.readFileSync(`${where(host, id)}.json`, 'utf8')); } catch { return null; }
}

// a message's attachments as peers and browsers may hand them over, the rest dropped
function clean(list) {
  if (!Array.isArray(list)) return undefined;
  const out = list.filter((f) => f && valid(f.host, f.id)).slice(0, MAX_FILES).map((f) => ({
    host: f.host, id: f.id,
    name: String(f.name || 'file').slice(0, 200),
    type: String(f.type || '').slice(0, 100),
    size: Number.isFinite(f.size) ? f.size : 0,
  }));
  return out.length ? out : undefined;
}

// oldest first until under the cap, the files and their meta together
function prune() {
  const all = [];
  let total = 0;
  for (const host of fs.readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of fs.readdirSync(path.join(DIR, host.name))) {
      if (!ID.test(f)) continue;
      try {
        const st = fs.statSync(path.join(DIR, host.name, f));
        all.push({ file: path.join(DIR, host.name, f), size: st.size, at: st.mtimeMs });
        total += st.size;
      } catch {}
    }
  }
  all.sort((a, b) => a.at - b.at);
  for (const f of all) {
    if (total <= MAX_TOTAL) break;
    fs.rmSync(f.file, { force: true });
    fs.rmSync(`${f.file}.json`, { force: true });
    total -= f.size;
  }
}

// a body streamed to a temp file, capped, renamed into place once whole
function store(host, id, src, info) {
  fs.mkdirSync(path.join(DIR, host), { recursive: true });
  const abs = where(host, id);
  const tmp = `${abs}.${process.pid}.tmp`;
  let size = 0;
  const cap = new Transform({
    transform(c, _enc, cb) {
      size += c.length;
      cb(size > MAX_FILE ? new Error('file too large') : null, c);
    },
  });
  return new Promise((resolve) => {
    pipeline(src, cap, fs.createWriteStream(tmp), (err) => {
      try {
        if (err) throw err;
        const m = { name: info.name, type: info.type, size };
        fs.writeFileSync(`${abs}.json`, JSON.stringify(m));
        fs.renameSync(tmp, abs);
        try { prune(); } catch {}
        resolve([200, { host, id, ...m }]);
      } catch (e) {
        fs.rm(tmp, { force: true }, () => {});
        resolve([size > MAX_FILE ? 413 : 500, { error: size > MAX_FILE ? `over ${MAX_FILE / 1048576}MB` : e.message }]);
      }
    });
  });
}

function save(host, req, name, type) {
  const len = Number(req.headers['content-length']);
  if (len > MAX_FILE) return Promise.resolve([413, { error: `over ${MAX_FILE / 1048576}MB` }]);
  return store(host, crypto.randomBytes(16).toString('hex'), req, {
    name: String(name || 'file').replace(/[/\\\0]/g, '_').slice(0, 200) || 'file',
    type: /^[\w.+-]+\/[\w.+-]+$/.test(type || '') ? type.toLowerCase() : 'application/octet-stream',
  });
}

// a file shipped with the app, kept under an id from its name so it lands once
function bundled(host, file) {
  const name = path.basename(file);
  const id = crypto.createHash('md5').update(name).digest('hex');
  const info = { name, type: `image/${path.extname(name).slice(1)}`, size: fs.statSync(file).size };
  if (!meta(host, id)) {
    fs.mkdirSync(path.join(DIR, host), { recursive: true });
    fs.copyFileSync(file, where(host, id));
    fs.writeFileSync(`${where(host, id)}.json`, JSON.stringify(info));
  }
  return { host, id, ...info };
}

function serve(res, host, id, download) {
  const m = meta(host, id);
  if (!m) return false;
  const inline = !download && INLINE.has(m.type);
  res.writeHead(200, {
    'Content-Type': inline ? m.type : 'application/octet-stream',
    'Content-Length': m.size,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(m.name)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    // the pdf viewer the one thing a sandbox breaks
    ...(m.type === 'application/pdf' ? {} : { 'Content-Security-Policy': 'sandbox' }),
    'X-Phos-Media': encodeURIComponent(JSON.stringify(m)),
  });
  const stream = fs.createReadStream(where(host, id));
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return true;
}

// from the host it lives on, cached here, false if it can't be had, one
// pull per file however many ask at once
const pulling = new Map();
function pull(host, id, ip, port) {
  const key = `${host}/${id}`;
  if (!pulling.has(key)) pulling.set(key, fetchOnce(host, id, ip, port).finally(() => pulling.delete(key)));
  return pulling.get(key);
}

function fetchOnce(host, id, ip, port) {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path: `/api/chat/media/${host}/${id}?hop=1`, timeout: 60000 }, (r) => {
      let info = null;
      try { info = JSON.parse(decodeURIComponent(r.headers['x-phos-media'] || '')); } catch {}
      if (r.statusCode !== 200 || !info) { r.resume(); resolve(false); return; }
      store(host, id, r, { name: String(info.name || 'file').slice(0, 200), type: String(info.type || '') }).then(([s]) => resolve(s === 200));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', () => resolve(false));
  });
}

module.exports = { MAX_FILE, valid, meta, clean, save, bundled, serve, pull };
