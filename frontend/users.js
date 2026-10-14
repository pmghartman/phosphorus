'use strict';
// the mesh's people: scrypt hashes, each one's vault of host and page logins
// sealed with a key from their own password, the latest change on the mesh winning

const crypto = require('crypto');
const sys = require('./sysfs');

// the sys tree: etc/passwd/<name> {admin}, etc/shadow/<name> {salt, hash,
// pwAt}, home/<name>/vault {iv, tag, data}, etc/secret {v}
const SECRET = 'etc/secret.json';
const passwd = (n) => `etc/passwd/${n}.json`;
const shadow = (n) => `etc/shadow/${n}.json`;
const vaultFile = (n) => `home/${n}/vault.json`;
sys.oldestWins(SECRET);

// .env's update password, the bootstrap admin's, unset: an empty one
const ADMIN_PASS = process.env.PHOSPHORUS_UPDATE_PASSWORD || '';
const ADMIN = 'admin';
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const COOKIE = 'phosphorus-user';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const BOOT_SESSION_MS = 3600 * 1000;
const MAX_VAULT = 64 * 1024;
const MAX_PASS = 256;

const live = (name) => {
  const pw = NAME_RE.test(name) && sys.read(passwd(name));
  const sh = pw && sys.read(shadow(name));
  return sh ? { admin: !!pw.admin, ...sh } : null;
};
const names = () => sys.list('etc/passwd').map((f) => f.slice(0, -5)).filter(live).sort();
const anyAdmin = () => names().some((n) => live(n).admin);

// --- crypto ---------------------------------------------------------------

// 64 bytes: the hash's half stored, the vault key's half never
function derive(pass, salt) {
  return new Promise((resolve, reject) => crypto.scrypt(String(pass), Buffer.from(salt, 'hex'), 64, (err, out) => (err ? reject(err) : resolve(out))));
}

function seal(key, text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('base64') };
}

function open(key, box) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex'));
    d.setAuthTag(Buffer.from(box.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

// one per mesh, the oldest winning
function meshKey() {
  if (!sys.read(SECRET)) sys.write(SECRET, { v: crypto.randomBytes(32).toString('hex') });
  return crypto.createHash('sha256').update(sys.read(SECRET).v).digest();
}

// --- sessions -------------------------------------------------------------

function cookieOf(req) {
  return (String(req.headers.cookie || '').match(/(?:^|;\s*)phosphorus-user=([A-Za-z0-9_-]+)/) || [])[1] || '';
}

function issue(payload, ms) {
  const box = seal(meshKey(), JSON.stringify({ ...payload, e: Date.now() + ms }));
  const token = Buffer.from(JSON.stringify(box)).toString('base64url');
  return `${COOKIE}=${token}; Path=/; Max-Age=${Math.round(ms / 1000)}; SameSite=Strict; HttpOnly`;
}
const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; SameSite=Strict; HttpOnly`;

// {user, admin, boot, key} or null
function session(req) {
  const token = cookieOf(req);
  if (!token || !sys.read(SECRET)) return null;
  let s;
  try { s = JSON.parse(open(meshKey(), JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))) || 'null'); } catch { return null; }
  if (!s || !(s.e > Date.now())) return null;
  if (s.b) return { user: ADMIN, admin: true, boot: true, key: null };
  const u = live(s.u);
  if (!u || u.pwAt !== s.p) return null;
  return { user: s.u, admin: !!u.admin, boot: false, key: Buffer.from(s.k, 'hex') };
}

function vaultOf(s) {
  if (!s || s.boot) return null;
  const box = sys.read(vaultFile(s.user));
  const text = box && open(s.key, box);
  try { return JSON.parse(text) || {}; } catch { return {}; }
}

const me = (s) => ({ user: s.user, admin: s.admin, boot: s.boot, vault: vaultOf(s) || { hosts: {}, pages: {} } });

// --- the browser's calls, [status, body, cookie?] -------------------------

async function login(p) {
  const name = String(p.user || '').trim().toLowerCase();
  const pass = String(p.pass || '');
  const fail = async () => { await new Promise((r) => setTimeout(r, 400)); return [401, { error: 'wrong user or password' }]; };
  if (name === ADMIN) {
    if (anyAdmin()) return [403, { error: 'the setup admin is off once an admin user exists' }];
    if (pass !== ADMIN_PASS) return fail();
    return [200, me({ user: ADMIN, admin: true, boot: true }), issue({ b: 1 }, BOOT_SESSION_MS)];
  }
  const u = live(name);
  if (!u || pass.length > MAX_PASS) return fail();
  const out = await derive(pass, u.salt);
  if (!crypto.timingSafeEqual(out.subarray(0, 32), Buffer.from(u.hash, 'hex'))) return fail();
  const key = out.subarray(32);
  const s = { user: name, admin: !!u.admin, boot: false, key };
  return [200, me(s), issue({ u: name, p: u.pwAt, k: key.toString('hex') }, SESSION_MS)];
}

// a fresh salt, hash and key, the vault sealed under it
async function setPass(name, pass, vault, admin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const out = await derive(pass, salt);
  const pwAt = crypto.randomBytes(8).toString('hex');
  if (admin !== undefined) sys.write(passwd(name), { admin: !!admin });
  sys.write(shadow(name), { salt, hash: out.subarray(0, 32).toString('hex'), pwAt });
  sys.write(vaultFile(name), seal(out.subarray(32), JSON.stringify(vault)));
  return out.subarray(32);
}

function cleanVault(v) {
  const out = { hosts: {}, pages: {} };
  const str = (x, n = MAX_PASS) => String(x == null ? '' : x).slice(0, n);
  for (const [h, c] of Object.entries((v && v.hosts) || {})) {
    if (/^[a-z0-9][a-z0-9-]{0,62}$/.test(h) && c && c.user) out.hosts[h] = { user: str(c.user, 64), pass: str(c.pass) };
  }
  for (const [k, c] of Object.entries((v && v.pages) || {})) {
    if (k && k.length <= 128 && c) out.pages[str(k, 128)] = { url: str(c.url, 512), user: str(c.user, 128), pass: str(c.pass) };
  }
  return out;
}

function setVault(s, p) {
  if (!s || s.boot) return [403, { error: 'the setup admin keeps no logins' }];
  const vault = cleanVault(p.vault);
  const text = JSON.stringify(vault);
  if (text.length > MAX_VAULT) return [413, { error: 'too many saved logins' }];
  sys.write(vaultFile(s.user), seal(s.key, text));
  return [200, { vault }];
}

async function changePass(s, p) {
  if (!s || s.boot) return [403, { error: 'the setup admin\'s password is the update password in .env' }];
  const pass = String(p.pass || '');
  if (pass.length < 4 || pass.length > MAX_PASS) return [400, { error: 'password: 4 to 256 characters' }];
  const u = live(s.user);
  const old = await derive(String(p.old || ''), u.salt);
  if (!crypto.timingSafeEqual(old.subarray(0, 32), Buffer.from(u.hash, 'hex'))) return [401, { error: 'wrong current password' }];
  const key = await setPass(s.user, pass, vaultOf(s) || {});
  return [200, { ok: true }, issue({ u: s.user, p: live(s.user).pwAt, k: key.toString('hex') }, SESSION_MS)];
}

const needAdmin = (s) => (s && s.admin ? null : [403, { error: 'admins only' }]);
const list = (s) => needAdmin(s) || [200, { users: names().map((n) => ({ name: n, admin: live(n).admin })) }];

async function create(s, p) {
  const no = needAdmin(s);
  if (no) return no;
  const name = String(p.name || '').trim().toLowerCase();
  const pass = String(p.pass || '');
  if (!NAME_RE.test(name) || name === ADMIN) return [400, { error: 'name: letters, digits, . _ -, up to 32, never admin' }];
  if (live(name)) return [409, { error: `${name} already exists` }];
  if (pass.length < 4 || pass.length > MAX_PASS) return [400, { error: 'password: 4 to 256 characters' }];
  await setPass(name, pass, { hosts: {}, pages: {} }, !!p.admin);
  return list(s);
}

function setAdmin(s, p) {
  const no = needAdmin(s);
  if (no) return no;
  const name = String(p.name || '');
  if (!live(name)) return [404, { error: 'no such user' }];
  if (name === s.user && !p.admin) return [400, { error: 'your own admin stays, another admin can take it' }];
  sys.write(passwd(name), { admin: !!p.admin });
  return list(s);
}

function remove(s, p) {
  const no = needAdmin(s);
  if (no) return no;
  const name = String(p.name || '');
  if (!live(name)) return [404, { error: 'no such user' }];
  if (name === s.user) return [400, { error: 'another admin can delete you, not yourself' }];
  for (const f of [passwd(name), shadow(name), vaultFile(name)]) sys.remove(f);
  return list(s);
}

module.exports = {
  session, me, login, setVault, changePass, list, create, setAdmin, remove, clearCookie, setup: () => !anyAdmin(),
};
