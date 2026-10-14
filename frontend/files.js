'use strict';
// files tab backend: each [files] dir mounted under SHARE_ROOT, every request
// path held inside its share and every write checked against its perms

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pipeline, Transform } = require('stream');
const { phosphorusIni } = require('./util');

// one mount per share, /shares/<index>, FILES_ROOT the home's own files/
// when [files] dir is blank
const SHARE_ROOT = process.env.SHARE_ROOT || '/shares';
const FILES_ROOT = process.env.FILES_ROOT || '/files';
// read inline by the previewer, anything larger download-only
const MAX_PREVIEW = 512 * 1024;
const MAX_UPLOAD = 256 * 1024 * 1024;
const MAX_ENTRIES = 5000;
// a tree listing's reach, deep enough for any share, capped for one tool result
const TREE_DEPTH_MAX = 8;
const TREE_MAX = 2000;
// an upload in flight, beside its target, never listed
const UPLOAD_TMP = '.phosphorus-upload-';

// r browse and download, w upload/new folder/rename, d delete, nothing else
// (the frontend never runs anything in a share)
const PERM_CHARS = ['r', 'w', 'd'];
const FULL_PERMS = 'rwd';

function cleanPerms(spec) {
  const want = new Set(String(spec || '').toLowerCase().split(''));
  return PERM_CHARS.filter((c) => want.has(c)).join('');
}

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// empty when [files] dir is unset, with FILES_ROOT served instead
const configuredDirs = () => splitList(phosphorusIni('files', 'dir'));

// the host paths /shares/* were created from
const mountedDirs = () => splitList(process.env.PHOSPHORUS_FILES_DIRS);

// each mount's source on the host, off the docker daemon, fixed for the
// container's life, retried until docker answers
const hostMounts = new Map();
function loadMounts() {
  execFile('docker', ['inspect', 'phosphorus', '--format', '{{range .Mounts}}{{.Destination}}\t{{.Source}}\n{{end}}'],
    { timeout: 10000 }, (err, out) => {
      if (err) { setTimeout(loadMounts, 60000).unref(); return; }
      for (const line of String(out).split('\n')) {
        const [dest, src] = line.split('\t');
        if (dest && src) hostMounts.set(dest.replace(/\/+$/, ''), src);
      }
    });
}
loadMounts();

// Docker Desktop's VM spelling back to the Windows drive it mounts
function hostSpelling(src) {
  const vm = /^\/run\/desktop\/mnt\/host\/([a-z])(\/.*)?$/.exec(src);
  const p = vm ? `${vm[1].toUpperCase()}:${vm[2] || '/'}` : src;
  return p.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

// a container path as it lives on the host, its nearest mount's source
function hostPathOf(p) {
  for (let at = p; at && at !== '/'; at = path.posix.dirname(at)) {
    const src = hostMounts.get(at);
    if (src) return hostSpelling(src) + p.slice(at.length);
  }
  return null;
}

// a share's root as the tab prints it: where it lives on the host, before
// docker answers the dir compose got when absolute, else the container path
function labelFor(dir, root) {
  const host = hostPathOf(root);
  if (host) return host;
  const clean = String(dir || '').replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  return /^([A-Za-z]:)?\//.test(clean) && !/^\/repo(\/|$)/.test(clean) ? clean : root;
}

// containment against the resolved root, for a mount behind a symlink,
// rebuilt every request so a remount needs no restart
function makeShare(id, dir, perms, root) {
  let real = root;
  try { real = fs.realpathSync(root); } catch {}
  let ok = false;
  try { ok = fs.statSync(root).isDirectory(); } catch {}
  return { id: String(id), label: labelFor(dir, root), perms, root, real, ok };
}

// PHOSPHORUS_FILES_DIRS: what compose mounted, in order, unset: one full-access
// share of FILES_ROOT
function buildShares() {
  const dirs = mountedDirs();
  if (!dirs.length) {
    return [makeShare(0, process.env.PHOSPHORUS_FILES_DIR || '', FULL_PERMS, FILES_ROOT)];
  }
  const perms = splitList(process.env.PHOSPHORUS_FILES_PERMS);
  return dirs.map((dir, i) => makeShare(
    i, dir,
    perms[i] === undefined ? FULL_PERMS : cleanPerms(perms[i]),
    path.join(SHARE_ROOT, String(i)),
  ));
}

// the orangutan's project workspaces, read only, once there is one
const PROJECTS_ROOT = path.join(process.env.STATE_DIR || '/state', 'projects');
const shares = () => [...buildShares(), makeShare('projects', '', 'r', PROJECTS_ROOT)].filter((s) => s.ok);

const shareOf = (id) => shares().find((s) => s.id === String(id)) || null;

const can = (share, perm) => !!share && share.perms.includes(perm);

const enabled = () => shares().length > 0;

const inside = (share, p) => p === share.real || p.startsWith(share.real + path.sep);

// traversal refused before the filesystem is touched, a request path always
// relative to the share root, `..` climbing at most to it
function toAbs(share, rel) {
  const clean = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (clean.includes('\0')) return null;
  const abs = path.resolve(share.real, `./${clean.replace(/^\/+/, '')}`);
  return inside(share, abs) ? abs : null;
}

// the resolved target checked too, a symlink in the share able to point out,
// for a new file its parent in its place
function safePath(share, rel, mustExist) {
  const abs = toAbs(share, rel);
  if (!abs) return null;
  try {
    if (mustExist) return inside(share, fs.realpathSync(abs)) ? abs : null;
    return inside(share, fs.realpathSync(path.dirname(abs))) ? abs : null;
  } catch {
    return null;
  }
}

const relOf = (share, abs) => path.relative(share.real, abs).split(path.sep).join('/');

// an absolute path back to its share and its path there, null outside them all
function locate(abs) {
  let real;
  try { real = fs.realpathSync(abs); } catch { return null; }
  const sh = shares().find((s) => inside(s, real));
  return sh ? { share: sh.id, path: relOf(sh, real) } : null;
}

async function isEmptyDir(abs) {
  try {
    const d = await fs.promises.opendir(abs);
    const first = await d.read();
    await d.close();
    return !first;
  } catch { return undefined; }
}

async function entryOf(dirAbs, name) {
  const abs = path.join(dirAbs, name);
  let st;
  // lstat, so a broken or escaping symlink lists as itself instead of throwing
  try { st = await fs.promises.lstat(abs); } catch { return null; }
  const link = st.isSymbolicLink();
  let target = st;
  if (link) {
    try { target = await fs.promises.stat(abs); } catch { target = null; }
  }
  const dir = !!target && target.isDirectory();
  return {
    name,
    dir,
    // nothing to unfold, links left unknown (target maybe off the share)
    empty: dir && !link ? await isEmptyDir(abs) : undefined,
    link,
    size: target && target.isFile() ? target.size : null,
    mtime: target ? Math.round(target.mtimeMs) : null,
  };
}

// a folder's entries stat'ed side by side, a slow mount's round trips overlapping
const STAT_WIDTH = 64;
async function entriesOf(dirAbs, names) {
  const out = new Array(names.length);
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const i = next++;
      out[i] = await entryOf(dirAbs, names[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_WIDTH, names.length) }, worker));
  return out.filter(Boolean);
}

async function list(share, rel) {
  if (!can(share, 'r')) return [403, { error: 'this share is not readable' }];
  const abs = safePath(share, rel, true);
  if (!abs) return [400, { error: 'bad path' }];
  let names;
  try { names = await fs.promises.readdir(abs); } catch (e) {
    if (e.code === 'ENOENT') return [404, { error: 'no such directory' }];
    if (e.code === 'ENOTDIR') return [400, { error: 'not a directory' }];
    return [500, { error: e.message }];
  }
  names = names.filter((n) => !n.startsWith(UPLOAD_TMP));
  const entries = await entriesOf(abs, names.slice(0, MAX_ENTRIES));
  // directories first, then by name, the way a file manager is read
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return [200, {
    path: relOf(share, abs),
    truncated: names.length > MAX_ENTRIES,
    entries,
  }];
}

// * and ? over a name, case-insensitive
const globRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');

// every entry under rel to depth, breadth first, folders as "path/", symlinked
// folders listed but never entered, match a name glob filtering what's listed
async function tree(share, rel, depth, match) {
  if (!can(share, 'r')) return [403, { error: 'this share is not readable' }];
  const root = safePath(share, rel, true);
  if (!root) return [400, { error: 'bad path' }];
  try { if (!fs.statSync(root).isDirectory()) return [400, { error: 'not a directory' }]; } catch { return [404, { error: 'no such directory' }]; }
  const want = match ? globRe(String(match)) : null;
  const maxDepth = Math.min(TREE_DEPTH_MAX, Math.max(1, Number(depth) || 1));
  const out = [];
  let truncated = false;
  let level = [root];
  for (let d = 1; d <= maxDepth && level.length && !truncated; d++) {
    const next = [];
    for (const dir of level) {
      let names;
      try { names = fs.readdirSync(dir).filter((n) => !n.startsWith(UPLOAD_TMP)).sort((a, b) => a.localeCompare(b)); } catch { continue; }
      const got = await entriesOf(dir, names);
      for (const e of got) {
        const n = e.name;
        const rp = relOf(share, path.join(dir, n));
        if (e.dir && !e.link) next.push(path.join(dir, n));
        if (want && !want.test(n)) continue;
        if (out.length >= TREE_MAX) { truncated = true; break; }
        out.push(e.dir ? { path: `${rp}/`, mtime: e.mtime } : { path: rp, size: e.size, mtime: e.mtime });
      }
      if (truncated) break;
    }
    level = next;
  }
  return [200, { path: relOf(share, root), depth: maxDepth, entries: out, ...(truncated ? { truncated: true } : {}) }];
}

// a destination's missing folders made, the nearest existing one held to the share
function makeParents(share, rel) {
  const abs = toAbs(share, rel);
  if (!abs) return;
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  try { if (inside(share, fs.realpathSync(dir))) fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch {}
}

// binary sniff, not an extension list: a NUL in the first block
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function read(share, rel) {
  if (!can(share, 'r')) return [403, { error: 'this share is not readable' }];
  const abs = safePath(share, rel, true);
  // missing but somewhere it could be made: a 404, so an editor starts it empty
  if (!abs) return safePath(share, rel, false) ? [404, { error: 'no such file' }] : [400, { error: 'bad path' }];
  let st;
  try { st = fs.statSync(abs); } catch { return [404, { error: 'no such file' }]; }
  if (st.isDirectory()) return [400, { error: 'that is a directory' }];
  if (st.size > MAX_PREVIEW) return [200, { path: relOf(share, abs), size: st.size, tooBig: true }];
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return [500, { error: e.message }]; }
  if (looksBinary(buf)) return [200, { path: relOf(share, abs), size: st.size, binary: true }];
  return [200, { path: relOf(share, abs), size: st.size, text: buf.toString('utf8') }];
}

// resolved for the caller to stream, never read into memory here
function downloadPath(share, rel) {
  if (!can(share, 'r')) return null;
  const abs = safePath(share, rel, true);
  if (!abs) return null;
  try { return fs.statSync(abs).isFile() ? abs : null; } catch { return null; }
}

const BAD_NAME = /[/\\]|^\.\.?$|\0/;

// one chunk of an upload appended to a temp file named by the upload's id,
// renamed into place once the last lands, a retried chunk rewrites from its
// offset, a gap answers 409 with what is held
function write(share, rel, req, q) {
  if (!can(share, 'w')) return Promise.resolve([403, { error: 'this share is read-only' }]);
  const abs = safePath(share, rel, false);
  if (!abs || BAD_NAME.test(path.basename(abs))) return Promise.resolve([400, { error: 'bad path' }]);
  const total = Number(q.total);
  const offset = Number(q.offset);
  if (!/^[a-z0-9]{8,40}$/.test(q.id || '') || !Number.isInteger(total) || !Number.isInteger(offset) || offset < 0 || offset > total) {
    req.resume();
    return Promise.resolve([400, { error: 'bad chunk' }]);
  }
  if (total > MAX_UPLOAD) {
    req.resume();
    return Promise.resolve([413, { error: 'file too large' }]);
  }
  const tmp = path.join(path.dirname(abs), `${UPLOAD_TMP}${q.id}`);
  let have = 0;
  try { have = fs.statSync(tmp).size; } catch {}
  if (offset > have) {
    req.resume();
    return Promise.resolve([409, { error: 'chunk out of order', have }]);
  }
  let size = 0;
  const cap = new Transform({
    transform(c, _enc, cb) {
      size += c.length;
      cb(offset + size > total ? new Error('chunk past the end') : null, c);
    },
  });
  const out = fs.createWriteStream(tmp, { flags: offset ? 'r+' : 'w', start: offset });
  return new Promise((resolve) => {
    pipeline(req, cap, out, (err) => {
      try {
        if (err) throw err;
        if (offset + size < total) { resolve([200, { ok: true, next: offset + size }]); return; }
        fs.truncateSync(tmp, total);
        fs.renameSync(tmp, abs);
        resolve([200, { ok: true, path: relOf(share, abs) }]);
      } catch (e) {
        if (offset === 0) fs.rm(tmp, { force: true }, () => {});
        resolve([500, { error: e.message }]);
      }
    });
  });
}

// a text file written whole, or one exact passage in it replaced, temp then
// rename, as an upload
function save(share, rel, p) {
  if (!can(share, 'w')) return [403, { error: 'this share is read-only' }];
  makeParents(share, rel);
  const abs = safePath(share, rel, false);
  if (!abs || BAD_NAME.test(path.basename(abs))) return [400, { error: 'bad path' }];
  let text = p.text;
  if (typeof p.old === 'string' && typeof p.new === 'string') {
    if (!can(share, 'r')) return [403, { error: 'this share is not readable' }];
    const [status, cur] = read(share, rel);
    if (status !== 200) return [status, cur];
    if (cur.tooBig || cur.binary) return [400, { error: 'not a text file under 512KB' }];
    const at = p.old ? cur.text.indexOf(p.old) : -1;
    if (at < 0) return [409, { error: 'old text not found' }];
    if (cur.text.indexOf(p.old, at + 1) >= 0) return [409, { error: 'old text found more than once, give more of it' }];
    text = cur.text.slice(0, at) + p.new + cur.text.slice(at + p.old.length);
  }
  if (typeof text !== 'string') return [400, { error: 'text, or old and new' }];
  if (Buffer.byteLength(text) > MAX_PREVIEW) return [413, { error: 'over 512KB' }];
  const made = !fs.existsSync(abs);
  const tmp = path.join(path.dirname(abs), `${UPLOAD_TMP}${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, abs);
  } catch (e) {
    fs.rm(tmp, { force: true }, () => {});
    return [500, { error: e.message }];
  }
  return [200, { ok: true, path: relOf(share, abs), size: Buffer.byteLength(text), ...(made ? { created: true } : {}) }];
}

function mkdir(share, rel) {
  if (!can(share, 'w')) return [403, { error: 'this share is read-only' }];
  const abs = safePath(share, rel, false);
  if (!abs || BAD_NAME.test(path.basename(abs))) return [400, { error: 'bad path' }];
  if (fs.existsSync(abs)) return [409, { error: 'already exists' }];
  try { fs.mkdirSync(abs, { recursive: true }); } catch (e) { return [500, { error: e.message }]; }
  return [200, { ok: true, path: relOf(share, abs) }];
}

// to ending in / moves it into that folder under its own name, missing folders made
function rename(share, from, to) {
  if (!can(share, 'w')) return [403, { error: 'this share is read-only' }];
  const src = safePath(share, from, true);
  if (src && /[/\\]$/.test(String(to || ''))) to = `${to}${path.basename(src)}`;
  if (src) makeParents(share, to);
  const dst = safePath(share, to, false);
  if (!src || !dst || BAD_NAME.test(path.basename(dst))) return [400, { error: 'bad path' }];
  if (src === share.real) return [400, { error: "can't rename the share itself" }];
  if (fs.existsSync(dst)) return [409, { error: 'already exists' }];
  try { fs.renameSync(src, dst); } catch (e) { return [500, { error: e.message }]; }
  return [200, { ok: true, path: relOf(share, dst) }];
}

function remove(share, rel) {
  if (!can(share, 'd')) return [403, { error: 'deleting is off for this share' }];
  const abs = safePath(share, rel, true);
  if (!abs) return [400, { error: 'bad path' }];
  if (abs === share.real) return [400, { error: "can't delete the share itself" }];
  try { fs.rmSync(abs, { recursive: true, force: true }); } catch (e) { return [500, { error: e.message }]; }
  return [200, { ok: true }];
}

// what phosphorus.ini asks for now against what is mounted, a mismatch waiting on a
// container recreate
// both as host paths, relative entries off the home, as rebuild resolves them
function pending() {
  const home = hostPathOf('/repo');
  if (!home) return false;
  const norm = (d) => {
    const p = hostSpelling(String(d).trim());
    const abs = /^([A-Za-z]:)?\//.test(p) ? p : path.posix.join(home, p);
    return path.posix.normalize(abs).replace(/(.)\/+$/, '$1');
  };
  const want = configuredDirs().map(norm).join(',');
  const have = (mountedDirs().length ? mountedDirs() : [process.env.PHOSPHORUS_FILES_DIR || ''])
    .filter(Boolean).map(norm).join(',');
  return !!want && !!have && want !== have;
}

module.exports = {
  configuredDirs, pending, enabled, shares, shareOf, can, locate,
  list, tree, read, downloadPath, write, save, mkdir, rename, remove,
};
