// the mesh's people, scrypt hashes, each one's vault of host and page logins
// (and Anthropic token) sealed with a key from their own password
import { createHash, randomBytes } from "node:crypto";
import { isLoopbackAddr, isTailnetAddr } from "@phosphorus/proxy";
import * as store from "@phosphorus/store";
import { env, marshal, now, obj, sleep } from "@phosphorus/util";
import type { Ctx } from "@phosphorus/wsock";
import { B64URL, b64url, type Box, boxOf, derive, hashOK, hex, Open, randHex, sameSecret, Seal, unhex } from "./crypto.ts";

export { B64URL, type Box, Derive, Open, Seal } from "./crypto.ts";

const secretRel = "etc/secret.json";
const admin = "admin";
export const Cookie = "phosphorus-user";
const sessionMS = 30 * 24 * 3600 * 1000;
const bootSessionMS = 3600 * 1000;
const maxVault = 64 * 1024;
const maxPass = 256;
const triesMS = 15 * 60 * 1000;
const maxPrefs = 32 * 1024;
export const MaxWall = 3 * 1024 * 1024;
const pullWait = 3000;

const passwd = (n: string) => `etc/passwd/${n}.json`;
const shadow = (n: string) => `etc/shadow/${n}.json`;
export const vaultFile = (n: string) => `home/${n}/vault.json`;
const prefsFile = (n: string) => `home/${n}/prefs.json`;
const wallFile = (n: string) => `home/${n}/wallpaper.json`;
const mcpFile = (n: string) => `home/${n}/mcp.json`;

const adminPass = env("ADMIN_PASS", env("PHOSPHORUS_UPDATE_PASSWORD"));
const nameRe = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const reserved = [admin, "shared", "sys", "usr"];
const baseDomain = env("BASE_DOMAIN").toLowerCase();
const selfHost = env("SELF_HOST");
const triesMax: Record<string, number> = { ip: 5, user: 20 };
const tries = new Map<string, number[]>();
const prefKeys = ["icons", "theme", "palette", "custom", "recent", "color", "agentview"];
const wallTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// the request a session is read from or a cookie is written for
export type Req = Pick<Ctx, "req" | "url" | "ip">;

// Init the mesh secret's oldest-wins rule
export const Init = () => store.oldestWins(secretRel);

type ShadowRec = { salt: string; hash: string; pwAt: string };
type LiveUser = ShadowRec & { admin: boolean };

// a shadow record's fields, each a string or absent as Go's struct took them
function shadowOf(v: unknown): ShadowRec | undefined {
  const o = obj(v);
  if (!o) return;
  const f = (k: string) => (o[k] === undefined || o[k] === null ? "" : typeof o[k] === "string" ? (o[k] as string) : undefined);
  const salt = f("salt"), hash = f("hash"), pwAt = f("pwAt");
  if (salt === undefined || hash === undefined || pwAt === undefined) return;
  return { salt, hash, pwAt };
}

function live(name: string): LiveUser | undefined {
  if (!nameRe.test(name)) return;
  const pw = store.read(passwd(name));
  if (pw === undefined) return;
  const sh = shadowOf(store.read(shadow(name)));
  if (!sh) return;
  return { admin: truthy(obj(pw)?.admin), ...sh };
}

// Go's truthy: false, nil, 0 and "" are false, everything else true
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v !== "";
  return true;
}

// a value as the page's string: JSON for anything not scalar
export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  return marshal(v);
}

const names = () =>
  store
    .list("etc/passwd")
    .map((f) => f.replace(/\.json$/, ""))
    .filter((n) => live(n) !== undefined)
    .sort();

const hasAdmin = () => names().some((n) => live(n)?.admin);

// a fresh host's empty etc/ never taken for a mesh without admins
async function anyAdmin(): Promise<boolean> {
  if (hasAdmin()) return true;
  await pull();
  return hasAdmin();
}

let pulled = false;
// pull the mesh's sys, waiting at most pullWait
async function pull() {
  await Promise.race([store.pull(), sleep(pullWait)]);
  pulled = true;
}

// --- crypto ---------------------------------------------------------------

// MeshKey one per mesh, the oldest winning
export function MeshKey(): Uint8Array {
  let v = obj(store.read(secretRel))?.v;
  if (typeof v !== "string") {
    store.write(secretRel, { v: randomBytes(32).toString("hex") });
    v = obj(store.read(secretRel))?.v;
    if (typeof v !== "string") v = "";
  }
  return createHash("sha256").update(v).digest();
}

// --- sessions -------------------------------------------------------------

// Session a logged in browser
export type Session = { user: string; admin: boolean; boot: boolean; key?: Uint8Array; token: string; e: number };

const cookieRe = /(?:^|[;,]\s*)phosphorus-user=([A-Za-z0-9_-]+)/g;

const cookiesOf = (c: Req) => [...(c.req.headers.get("cookie") ?? "").matchAll(cookieRe)].map((m) => m[1]!);

const hostOf = (c: Req) => c.req.headers.get("host") ?? "";

function attrs(c: Req): string {
  const host = hostOf(c).toLowerCase().replace(/:\d+$/, "");
  const domain = baseDomain && (host === baseDomain || host.endsWith("." + baseDomain)) ? "; Domain=" + baseDomain : "";
  const secure = c.req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return "; Path=/" + domain + "; SameSite=Lax; HttpOnly" + secure;
}

function issue(c: Req, payload: Record<string, unknown>, ms: number): string {
  payload.e = now() + ms;
  const b = Seal(MeshKey(), marshal(payload));
  const token = b64url(marshal({ iv: b.iv, tag: b.tag, data: b.data, h: selfHost }));
  return `${Cookie}=${token}; Max-Age=${Math.round(ms / 1000)}${attrs(c)}`;
}

// ClearCookie the session cookie gone
export const ClearCookie = (c: Req) => [Cookie + "=; Max-Age=0" + attrs(c)];

// IPOf the browser's address as cloudflared or a peer's ingress saw it, else the socket's
export function IPOf(c: Req): string {
  const sock = c.ip;
  if (!isLoopbackAddr(sock) && !isTailnetAddr(sock)) return sock;
  const v = c.req.headers.get("cf-connecting-ip") || c.req.headers.get("x-forwarded-for") || sock;
  return v.split(",")[0]!.trim();
}

function locked(keys: string[]): number {
  const at = now();
  let until = 0;
  for (const k of keys) {
    const t = (tries.get(k) ?? []).filter((x) => at - x < triesMS);
    if (t.length) tries.set(k, t);
    else tries.delete(k);
    const max = triesMax[k.split(":", 1)[0]!] ?? 0;
    if (t.length >= max && max > 0) until = Math.max(until, t[t.length - max]! + triesMS);
  }
  return until;
}

function failed(keys: string[]) {
  for (const k of keys) tries.set(k, [...(tries.get(k) ?? []), now()]);
  // a Map's order: insertion, the oldest keys dropped first
  for (const k of tries.keys()) {
    if (tries.size <= 10000) break;
    tries.delete(k);
  }
}

function openToken(token: string): Record<string, any> | undefined {
  const raw = B64URL(token);
  if (!raw) return;
  let b: Box | undefined;
  try {
    b = boxOf(JSON.parse(Buffer.from(raw).toString("utf8")));
  } catch {
    return;
  }
  const text = Open(MeshKey(), b);
  if (text === undefined) return;
  try {
    return obj(JSON.parse(text));
  } catch {
    return;
  }
}

const unexpired = (o: Record<string, any> | undefined) => !!o && typeof o.e === "number" && o.e > now();

function sessionOf(token: string): Session | undefined {
  const s = openToken(token);
  if (!unexpired(s)) return;
  if (truthy(s!.b)) {
    // a boot cookie refused once any admin exists, this host's sys pulled
    // first by Soon; before that pull, by what's on disk
    if (hasAdmin()) return;
    if (!pulled) void pull();
    return { user: admin, admin: true, boot: true, token, e: s!.e };
  }
  const u = typeof s!.u === "string" ? s!.u : "";
  const lu = live(u);
  if (!lu || lu.pwAt !== (typeof s!.p === "string" ? s!.p : "")) return;
  return { user: u, admin: lu.admin, boot: false, key: unhex(s!.k), token, e: s!.e };
}

// Of the first valid cookie's session, a user's before a boot one
export function Of(c: Req): Session | undefined {
  if (store.read(secretRel) === undefined) return;
  let boot: Session | undefined;
  for (const t of cookiesOf(c)) {
    const s = sessionOf(t);
    if (s && !s.boot) return s;
    boot ??= s;
  }
  return boot;
}

// Soon a login this host can't read yet: the mesh's sys pulled first
export async function Soon(c: Req): Promise<Session | undefined> {
  const s = Of(c);
  if ((s && (!s.boot || pulled)) || !cookiesOf(c).length) return s;
  await pull();
  return Of(c);
}

// Pass any valid session
export const Pass = (c: Req) => Of(c) !== undefined;

// Issuers the hosts that issued the cookies sent, this one aside
export function Issuers(c: Req): string[] {
  const out: string[] = [];
  for (const t of cookiesOf(c)) {
    const raw = B64URL(t);
    if (!raw) continue;
    let o: Record<string, any> | undefined;
    try {
      o = obj(JSON.parse(Buffer.from(raw).toString("utf8")));
    } catch {
      continue;
    }
    const h = o?.h === undefined || o.h === null ? "" : str(o.h);
    if (h && h !== selfHost && !out.includes(h)) out.push(h);
  }
  return out;
}

// Refresh a host-only cookie moved onto the base domain
export function Refresh(c: Req, s: Session | undefined): string[] | undefined {
  if (!s || !attrs(c).includes("Domain=")) return;
  const left = Math.round((s.e - now()) / 1000);
  return [Cookie + "=; Max-Age=0; Path=/; SameSite=Lax; HttpOnly", `${Cookie}=${s.token}; Max-Age=${left}${attrs(c)}`];
}

type Vault = Record<string, any>;

// undefined while this host holds no vault it can open, as a fresh host
// before its sys arrives
function openVault(s: Session): Vault | undefined {
  const text = Open(s.key, boxOf(store.read(vaultFile(s.user))));
  if (text === undefined) return;
  try {
    return obj(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

async function vaultOf(s: Session | undefined): Promise<[Vault | undefined, boolean]> {
  if (!s || s.boot) return [undefined, true];
  let v = openVault(s);
  if (!v) {
    await pull();
    v = openVault(s);
  }
  return v ? [v, true] : [{}, false];
}

// Me what the page gets about its user
export async function Me(s: Session): Promise<Record<string, any>> {
  const [v, vaultOK] = await vaultOf(s);
  const vault = v ?? { hosts: {}, pages: {} };
  let prefs: unknown = {};
  let prefsAt = 0, wall = 0;
  if (!s.boot) {
    const p = store.read(prefsFile(s.user));
    if (p !== undefined) prefs = p;
    prefsAt = store.stamp(prefsFile(s.user));
    if (store.read(wallFile(s.user)) !== undefined) wall = store.stamp(wallFile(s.user));
  }
  return { user: s.user, admin: s.admin, boot: s.boot, vault: pageVault(vault), vaultOK, prefs, prefsAt, wallpaper: wall };
}

// Wallpaper the user's desktop picture: its type and bytes, none for ["", undefined]
export function Wallpaper(s: Session | undefined): [string, Uint8Array | undefined] {
  if (!s || s.boot) return ["", undefined];
  const w = obj(store.read(wallFile(s.user)));
  if (!w || typeof w.type !== "string" || !wallTypes.includes(w.type)) return ["", undefined];
  return [w.type, Buffer.from(typeof w.data === "string" ? w.data : "", "base64")];
}

const dataURLRe = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/;

// R a call's answer
export type R = { status: number; body: any; cookie?: string[] };

const errR = (status: number, msg: string): R => ({ status, body: { error: msg } });

// SetWallpaper a data: url, "" dropping it
export function SetWallpaper(s: Session | undefined, p: Record<string, any>): R {
  if (!s || s.boot) return errR(403, "the setup admin keeps no settings");
  const u = str(p.data);
  if (u === "") {
    store.remove(wallFile(s.user));
    return { status: 200, body: { wallpaper: 0 } };
  }
  const m = dataURLRe.exec(u);
  if (!m || !wallTypes.includes(m[1]!)) return errR(400, "png, jpeg, webp or gif only");
  if (m[2]!.length * 0.75 > MaxWall) return errR(413, "picture too large");
  store.write(wallFile(s.user), { type: m[1], data: m[2] });
  return { status: 200, body: { wallpaper: store.stamp(wallFile(s.user)) } };
}

// SetPrefs each a string as the page's localStorage held it
export function SetPrefs(s: Session | undefined, p: Record<string, any>): R {
  if (!s || s.boot) return errR(403, "the setup admin keeps no settings");
  const prefs: Record<string, any> = obj(store.read(prefsFile(s.user))) ?? {};
  const inp = obj(p.prefs);
  for (const k of prefKeys) {
    if (!inp || !Object.hasOwn(inp, k)) continue;
    const sv = str(inp[k]);
    if (sv !== "") prefs[k] = sv;
    else delete prefs[k];
  }
  if (Buffer.byteLength(marshal(prefs)) > maxPrefs) return errR(413, "settings too large");
  store.write(prefsFile(s.user), prefs);
  return { status: 200, body: { prefs, prefsAt: store.stamp(prefsFile(s.user)) } };
}

const runes = (s: string) => [...s].length;

// Login a user, or the setup admin while there's no admin user
export const Login = async (p: Record<string, any>, c: Req): Promise<R> => (await SignIn(p, c))[0];

// SignIn Login's answer and, on success, the session it made
export async function SignIn(p: Record<string, any>, c: Req): Promise<[R, Session | undefined]> {
  const name = str(p.user).trim().toLowerCase();
  const pass = str(p.pass);
  const keys = ["ip:" + IPOf(c), "user:" + name];
  const until = locked(keys);
  if (until > 0) return [errR(429, `too many wrong passwords, try again in ${Math.ceil((until - now()) / 60000)} min`), undefined];
  const fail = async (): Promise<[R, undefined]> => {
    failed(keys);
    await sleep(400);
    return [errR(401, "wrong user or password"), undefined];
  };
  if (name === admin) {
    if (await anyAdmin()) return [errR(403, "the setup admin is off once an admin user exists"), undefined];
    if (adminPass === "" || !sameSecret(pass, adminPass)) return fail();
    const s: Session = { user: admin, admin: true, boot: true, token: "", e: 0 };
    return [{ status: 200, body: await Me(s), cookie: [issue(c, { b: 1 }, bootSessionMS)] }, s];
  }
  if (runes(pass) > maxPass) return fail();
  let u = live(name);
  if (!u || !hashOK(await derive(pass, u.salt), u.hash)) {
    // a user or new password this host hasn't pulled yet
    await pull();
    u = live(name);
  }
  if (!u) return fail();
  const out = await derive(pass, u.salt);
  if (!hashOK(out, u.hash)) return fail();
  const key = out.subarray(32);
  const s: Session = { user: name, admin: u.admin, boot: false, key, token: "", e: 0 };
  return [{ status: 200, body: await Me(s), cookie: [issue(c, { u: name, p: u.pwAt, k: hex(key) }, sessionMS)] }, s];
}

async function setPass(name: string, pass: string, vault: unknown, adminFlag?: boolean): Promise<Uint8Array> {
  const salt = randHex(16);
  const out = await derive(pass, salt);
  const pwAt = randHex(8);
  if (adminFlag !== undefined) store.write(passwd(name), { admin: adminFlag });
  store.write(shadow(name), { salt, hash: hex(out.subarray(0, 32)), pwAt });
  store.write(vaultFile(name), Seal(out.subarray(32), marshal(vault)));
  return out.subarray(32);
}

const hostKeyRe = /^[a-z0-9][a-z0-9-]{0,62}$/;

// the first n code points, as Go's runes
function clip(v: unknown, n: number): string {
  const r = [...str(v)];
  return (r.length > n ? r.slice(0, n) : r).join("");
}

// cleanVault the vault as kept: hosts and pages with their keys and fields
// checked, the Anthropic token when it looks like one
export function cleanVault(v: unknown): Vault {
  const hosts: Vault = {}, pages: Vault = {};
  const o = obj(v) ?? {};
  const hs = obj(o.hosts);
  if (hs)
    for (const [h, c] of Object.entries(hs)) {
      const cm = obj(c);
      if (hostKeyRe.test(h) && cm && truthy(cm.user)) hosts[h] = { user: clip(cm.user, 64), pass: clip(cm.pass, maxPass) };
    }
  const ps = obj(o.pages);
  if (ps)
    for (const [k, c] of Object.entries(ps)) {
      const cm = obj(c);
      if (k !== "" && Buffer.byteLength(k) <= 128 && cm) pages[clip(k, 128)] = { url: clip(cm.url, 512), user: clip(cm.user, 128), pass: clip(cm.pass, maxPass) };
    }
  const out: Vault = { hosts, pages };
  const t = cleanToken(o.anthropic);
  if (t) out.anthropic = t;
  return out;
}

// pageVault the vault as the page holds it: the Anthropic token never sent
function pageVault(v: Vault): Vault {
  const { anthropic, ...out } = v;
  return out;
}

// the session's vault, this host's sys pulled when it can't open one
async function vaultOrPull(s: Session): Promise<Vault | undefined> {
  let v = openVault(s);
  if (!v) {
    await pull();
    v = openVault(s);
  }
  return v;
}

const notSynced = () => errR(503, "this host hasn't your saved logins yet, try again shortly");

// SetVault the page's saved logins, sealed
export async function SetVault(s: Session | undefined, p: Record<string, any>): Promise<R> {
  if (!s || s.boot) return errR(403, "the setup admin keeps no logins");
  // an unsynced host's empty vault never sealed over the mesh's
  const old = await vaultOrPull(s);
  if (!old) return notSynced();
  const vault = cleanVault(p.vault);
  // the token set only by SetAnthropic, the page's copy (it has none) ignored
  delete vault.anthropic;
  const t = cleanVault(old).anthropic;
  if (typeof t === "string" && t !== "") vault.anthropic = t;
  const text = marshal(vault);
  if (Buffer.byteLength(text) > maxVault) return errR(413, "too many saved logins");
  store.write(vaultFile(s.user), Seal(s.key!, text));
  resealMCP(s, vault);
  return { status: 200, body: { vault: pageVault(vault) } };
}

// ChangePass the vault resealed under the new password
export async function ChangePass(s: Session | undefined, p: Record<string, any>, c: Req): Promise<R> {
  if (!s || s.boot) return errR(403, "the setup admin's password is ADMIN_PASS in .env");
  const pass = str(p.pass);
  const n = runes(pass);
  if (n < 4 || n > maxPass) return errR(400, "password: 4 to 256 characters");
  const u = live(s.user);
  if (!u || !hashOK(await derive(str(p.old), u.salt), u.hash)) return errR(401, "wrong current password");
  const v = await vaultOrPull(s);
  if (!v) return notSynced();
  const key = await setPass(s.user, pass, v);
  return { status: 200, body: { ok: true }, cookie: [issue(c, { u: s.user, p: live(s.user)!.pwAt, k: hex(key) }, sessionMS)] };
}

const needAdmin = (s: Session | undefined): R | undefined => (s?.admin ? undefined : errR(403, "admins only"));

// List the users, admins only
export function List(s: Session | undefined): R {
  const no = needAdmin(s);
  if (no) return no;
  return { status: 200, body: { users: names().map((n) => ({ name: n, admin: live(n)!.admin })) } };
}

// Create a user
export async function Create(s: Session | undefined, p: Record<string, any>): Promise<R> {
  const no = needAdmin(s);
  if (no) return no;
  const name = str(p.name).trim().toLowerCase();
  const pass = str(p.pass);
  if (!nameRe.test(name) || reserved.includes(name)) return errR(400, "name: letters, digits, . _ -, up to 32, never " + reserved.join(", "));
  if (live(name)) return errR(409, name + " already exists");
  const n = runes(pass);
  if (n < 4 || n > maxPass) return errR(400, "password: 4 to 256 characters");
  await setPass(name, pass, { hosts: {}, pages: {} }, truthy(p.admin));
  return List(s);
}

// SetAdmin flips a user's admin
export function SetAdmin(s: Session | undefined, p: Record<string, any>): R {
  const no = needAdmin(s);
  if (no) return no;
  const name = str(p.name);
  if (!live(name)) return errR(404, "no such user");
  if (name === s!.user && !truthy(p.admin)) return errR(400, "your own admin stays, another admin can take it");
  store.write(passwd(name), { admin: truthy(p.admin) });
  return List(s);
}

// Remove a user and their files
export function Remove(s: Session | undefined, p: Record<string, any>): R {
  const no = needAdmin(s);
  if (no) return no;
  const name = str(p.name);
  if (!live(name)) return errR(404, "no such user");
  if (name === s!.user) return errR(400, "another admin can delete you, not yourself");
  for (const f of [passwd(name), shadow(name), vaultFile(name), prefsFile(name), wallFile(name)]) store.remove(f);
  return List(s);
}

// SealGrant a short lived grant any host reads
export function SealGrant(o: Record<string, unknown>, ms: number): string {
  o.e = now() + ms;
  return b64url(marshal(Seal(MeshKey(), marshal(o))));
}

// OpenGrant undefined when bad or expired
export function OpenGrant(token: string): Record<string, any> | undefined {
  const o = openToken(token);
  return unexpired(o) ? o : undefined;
}

// --- mcp keys: one per user, its rights, a new one voiding the last ------

// MCPKey a fresh key for the session's user, a year long, the last one void
// the user's saved host logins ride along, sealed under a secret held only in
// the key, its copy under the user's own key so a vault change reseals them
export async function MCPKey(s: Session | undefined, _p: Record<string, any> | undefined, c: Req): Promise<R> {
  if (!s || s.boot) return errR(403, "log in as a user");
  const lu = live(s.user);
  if (!lu) return errR(403, "no such user");
  const [v, ok] = await vaultOf(s);
  if (!ok) return notSynced();
  const g = randHex(8);
  const k = randomBytes(32);
  const cv = cleanVault(v);
  const logins = cv.hosts as Vault, pages = cv.pages as Vault;
  store.write(mcpFile(s.user), { g, kk: Seal(s.key!, hex(k)), c: Seal(k, marshal(logins)), p: Seal(k, marshal(pages)) });
  return mcpGrant(s.user, lu.pwAt, g, k, logins, pages, c, true);
}

// MCPURL the user's key as its url: the one in use, sealed again so nothing using
// it breaks, or a fresh one when there's none or it can't be opened
export async function MCPURL(s: Session | undefined, p: Record<string, any> | undefined, c: Req): Promise<R> {
  if (!s || s.boot) return errR(403, "log in as a user");
  const lu = live(s.user);
  if (!lu) return errR(403, "no such user");
  const rec = mcpRecord(s.user);
  if (rec.g === "" || !rec.kk) return MCPKey(s, p, c);
  const k = unhex(Open(s.key, rec.kk));
  if (!k || k.length !== 32) return MCPKey(s, p, c);
  const [v] = await vaultOf(s);
  const cv = cleanVault(v);
  return mcpGrant(s.user, lu.pwAt, rec.g, k, cv.hosts, cv.pages, c, false);
}

// HasMCPKey whether the user has a key in use
export const HasMCPKey = (u: string) => mcpRecord(u).g !== "";

function mcpGrant(u: string, pwAt: string, g: string, k: Uint8Array, logins: Vault, pages: Vault, c: Req, fresh: boolean): R {
  const key = SealGrant({ u, p: pwAt, m: g, k: hex(k) }, 365 * 24 * 3600 * 1000);
  return { status: 200, body: { key, url: MCPBase(c) + "/api/mcp/" + key, fresh, user: u, hosts: Object.keys(logins).sort(), pages: Object.keys(pages).sort() } };
}

// MCPBase where an agent reaches the mesh: the base domain, else the host asked
export function MCPBase(c: Req): string {
  if (baseDomain) return "https://" + baseDomain;
  const tls = c.url.protocol === "https:" || c.req.headers.get("x-forwarded-proto") === "https";
  return (tls ? "https" : "http") + "://" + hostOf(c);
}

type McpRec = { g: string; kk?: Box; c?: Box; p?: Box };

// mcpRecord the user's key record, its boxes typed
function mcpRecord(u: string): McpRec {
  const o = obj(store.read(mcpFile(u))) ?? {};
  return { g: typeof o.g === "string" ? o.g : "", kk: boxOf(o.kk), c: boxOf(o.c), p: boxOf(o.p) };
}

// resealMCP the key's host logins kept in step with a vault just saved
function resealMCP(s: Session, vault: Vault) {
  const rec = mcpRecord(s.user);
  if (!rec.kk) return;
  const k = unhex(Open(s.key, rec.kk));
  if (!k || k.length !== 32) return;
  store.write(mcpFile(s.user), { g: rec.g, kk: rec.kk, c: Seal(k, marshal(vault.hosts)), p: Seal(k, marshal(vault.pages)) });
}

// a saved login's user and pass, ok false when there's no user
function loginOf(l: unknown): [string, string, boolean] {
  const o = obj(l);
  const user = typeof o?.user === "string" ? o.user : "", pass = typeof o?.pass === "string" ? o.pass : "";
  return [user, pass, user !== ""];
}

// MCPLogin the host login a key carries, ok false when it carries none
export const MCPLogin = (key: string, host: string): [string, string, boolean] => loginOf(MCPLogins(key)?.[host]);

// MCPLogins every host login a key carries, by host
export const MCPLogins = (key: string) => mcpOpen(key, (r) => r.c);

// MCPPages every page login a key carries by its name: url, user and pass;
// a key older than this carries none
export const MCPPages = (key: string) => mcpOpen(key, (r) => r.p);

// mcpOpen one of a key's boxes opened with the secret the key holds
function mcpOpen(key: string, box: (r: McpRec) => Box | undefined): Record<string, any> | undefined {
  const o = OpenGrant(key);
  if (!o) return;
  const k = unhex(o.k);
  if (!k || k.length !== 32) return;
  const rec = mcpRecord(typeof o.u === "string" ? o.u : "");
  const c = box(rec);
  if (!c || rec.g !== o.m) return;
  const text = Open(k, c);
  if (text === undefined) return;
  try {
    return obj(JSON.parse(text));
  } catch {
    return;
  }
}

// MCPRevoke every key of the session's user void
export function MCPRevoke(s: Session | undefined, _p?: Record<string, any>): R {
  if (!s || s.boot) return errR(403, "log in as a user");
  store.remove(mcpFile(s.user));
  return { status: 200, body: { ok: true } };
}

// OfMCPKey the user behind a key: live, its password and key unchanged
export const OfMCPKey = (key: string) => CheckMCPKey(key)[0];

// CheckMCPKey the key's user, or why it's refused: missing, malformed,
// expired, user gone, password changed or revoked
export function CheckMCPKey(key: string): [Session | undefined, string] {
  if (key === "") return [undefined, "missing"];
  const o = openToken(key);
  if (!o) return [undefined, "malformed, or sealed by another mesh"];
  if (!unexpired(o)) return [undefined, "expired, make a new one"];
  const u = typeof o.u === "string" ? o.u : "";
  const g = typeof o.m === "string" ? o.m : "";
  const lu = live(u);
  if (!lu) return [undefined, "its user " + u + " no longer exists"];
  if (g === "") return [undefined, "malformed"];
  if (o.p !== lu.pwAt) return [undefined, "voided by a password change, make a new one"];
  const cur = mcpRecord(u).g;
  if (cur === "" || cur !== g) return [undefined, "revoked or replaced by a newer key"];
  return [{ user: u, admin: lu.admin, boot: false, token: "", e: 0 }, ""];
}

// --- oauth: an agent signs in on the mesh's own page -------------------------
// clients and codes sealed grants any host opens, none kept; the token handed
// back is the user's mcp key, so a refresh, revoke or password change voids it

const oauthClientMS = 10 * 365 * 24 * 3600 * 1000;
const oauthCodeMS = 5 * 60 * 1000;
const verifierRe = /^[A-Za-z0-9._~-]{43,128}$/;
// codes already traded for a token on this host, by when they expire
const usedCodes = new Map<string, number>();

const sha = (s: string) => createHash("sha256").update(s).digest();

// OAuthRedirectOK a redirect a client may register: this machine's loopback,
// where Claude Code listens, or claude.ai's own callback
export function OAuthRedirectOK(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.username || u.password || u.hash) return false;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname) && u.port === "" && u.pathname === "/api/mcp/auth_callback";
}

// sameRedirect the uri a client registered, a loopback one on any port as RFC 8252 asks
function sameRedirect(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    const r = new URL(registered), a = new URL(asked);
    return r.protocol === "http:" && a.protocol === "http:" && OAuthRedirectOK(asked) && r.hostname === a.hostname && r.pathname === a.pathname && r.search === a.search;
  } catch {
    return false;
  }
}

const oauthErr = (error: string, why: string): R => ({ status: 400, body: { error, error_description: why } });

// OAuthRegister a client, RFC 7591's dynamic registration: its id the sealed
// record of its name and redirects
export function OAuthRegister(p: Record<string, any>): R {
  const uris = Array.isArray(p.redirect_uris) ? p.redirect_uris.map(str) : [];
  if (!uris.length || uris.length > 8 || !uris.every(OAuthRedirectOK)) return oauthErr("invalid_redirect_uri", "redirects go to this machine's loopback or claude.ai only");
  const name = clip(p.client_name, 64).trim() || "an agent";
  const id = SealGrant({ oc: 1, n: name, r: uris }, oauthClientMS);
  return {
    status: 201,
    body: {
      client_id: id, client_id_issued_at: Math.floor(now() / 1000), client_name: name, redirect_uris: uris,
      grant_types: ["authorization_code"], response_types: ["code"], token_endpoint_auth_method: "none",
    },
  };
}

// OAuthClient a client id's name and redirects, undefined when it isn't one
export function OAuthClient(id: string): { name: string; redirects: string[] } | undefined {
  const o = OpenGrant(id);
  if (o?.oc !== 1 || !Array.isArray(o.r)) return;
  return { name: str(o.n), redirects: o.r.map(str) };
}

// OAuthRedirectFor the client's redirect for the one asked, "" when it registered none such
export function OAuthRedirectFor(id: string, asked: string): string {
  const cl = OAuthClient(id);
  return cl?.redirects.some((r) => sameRedirect(r, asked)) ? asked : "";
}

// OAuthCode a code for the session's user, good once and briefly, its mcp key
// inside: the one in use, as MCPURL, so signing in breaks no other agent
export async function OAuthCode(s: Session, c: Req, clientId: string, redirect: string, challenge: string): Promise<[string, string]> {
  if (s.boot) return ["", "the setup admin can't sign an agent in, make a user first"];
  const [key, ok] = await KeyOf(s, c);
  if (!ok) return ["", "this host hasn't your saved logins yet, try again shortly"];
  return [SealGrant({ oa: 1, ci: hex(sha(clientId)), r: redirect, x: challenge, t: key }, oauthCodeMS), ""];
}

// OAuthToken a code traded for the user's mcp key, its PKCE verifier checked
export function OAuthToken(p: Record<string, any>): R {
  if (str(p.grant_type) !== "authorization_code") return oauthErr("unsupported_grant_type", "authorization_code only");
  const code = str(p.code);
  const o = OpenGrant(code);
  if (o?.oa !== 1) return oauthErr("invalid_grant", "code expired or not this mesh's");
  const at = now();
  for (const [k, e] of usedCodes) if (e <= at) usedCodes.delete(k);
  if (usedCodes.has(code)) return oauthErr("invalid_grant", "code already used");
  if (o.ci !== hex(sha(str(p.client_id)))) return oauthErr("invalid_grant", "code issued to another client");
  if (o.r !== str(p.redirect_uri)) return oauthErr("invalid_grant", "redirect_uri isn't the one the code went to");
  const v = str(p.code_verifier);
  if (!verifierRe.test(v) || b64url(sha(v)) !== o.x) return oauthErr("invalid_grant", "code_verifier doesn't match");
  usedCodes.set(code, o.e);
  const key = str(o.t);
  const [s, why] = CheckMCPKey(key);
  if (!s) return oauthErr("invalid_grant", "key " + why);
  const left = Math.floor(((OpenGrant(key)?.e ?? at) - at) / 1000);
  return { status: 200, body: { access_token: key, token_type: "Bearer", expires_in: left } };
}

// Exists a live user
export const Exists = (name: string) => live(name) !== undefined;

// IsAdmin a live admin user
export const IsAdmin = (name: string) => live(name)?.admin === true;

// Setup true while no admin user exists
export const Setup = async () => !(await anyAdmin());

// --- anthropic ------------------------------------------------------------
// a user's own Anthropic subscription token (claude setup-token's), kept in
// their vault under their password: only a request carrying their login
// opens it; and what a Code session needs of a logged in user: a host
// login, their mcp key, all from that same vault

const maxToken = 512;
const tokenRe = /^[A-Za-z0-9_.:+/=-]+$/;

// cleanToken a token as kept, "" for none or a bad one
function cleanToken(v: unknown): string {
  const t = str(v).trim();
  return Buffer.byteLength(t) > maxToken || !tokenRe.test(t) ? "" : t;
}

// DropOldTokens the tokens older releases sealed with the mesh key, gone
export function DropOldTokens() {
  for (const f of store.list("home")) if (f.split("/").length === 2 && f.endsWith("/anthropic.json")) store.remove("home/" + f);
}

// the old tokens gone on the first read too, any synced in late
let dropped = false;
function dropOnce() {
  if (dropped) return;
  dropped = true;
  DropOldTokens();
}

// SetAnthropic the token sealed in the vault, "" clearing it
export async function SetAnthropic(s: Session | undefined, p: Record<string, any>): Promise<R> {
  if (!s || s.boot || !s.key?.length) return errR(403, "log in as a user");
  dropOnce();
  const t = str(p.token).trim();
  if (t !== "" && cleanToken(t) === "") return errR(400, "that isn't a token: run claude setup-token and paste what it prints");
  const v = await vaultOrPull(s);
  if (!v) return notSynced();
  const cv = cleanVault(v);
  delete cv.anthropic;
  if (t !== "") cv.anthropic = t;
  const text = marshal(cv);
  if (Buffer.byteLength(text) > maxVault) return errR(413, "too many saved logins");
  store.write(vaultFile(s.user), Seal(s.key, text));
  return { status: 200, body: { anthropic: t !== "" } };
}

// AnthropicToken the session's user's token, "" for none
export async function AnthropicToken(s: Session | undefined): Promise<string> {
  dropOnce();
  const [v] = await vaultOf(s);
  const t = cleanVault(v).anthropic;
  return typeof t === "string" ? t : "";
}

// HostLogins the hosts the session's user saved a login for, sorted
export async function HostLogins(s: Session | undefined): Promise<string[]> {
  const [v] = await vaultOf(s);
  return Object.keys(cleanVault(v).hosts).sort();
}

// HostLogin the session's saved login for host: user, pass, ok
export async function HostLogin(s: Session | undefined, host: string): Promise<[string, string, boolean]> {
  const [v] = await vaultOf(s);
  return loginOf(cleanVault(v).hosts[host]);
}

// PageLogin the session's saved page login named name, else the first whose
// url holds urlHas: a service's own login, as Forgejo's
export async function PageLogin(s: Session | undefined, name: string, urlHas: string): Promise<[string, string, boolean]> {
  const [v] = await vaultOf(s);
  const ps = cleanVault(v).pages as Vault;
  let l = obj(ps[name]);
  if (!(typeof l?.user === "string" && l.user !== "") && urlHas !== "") {
    for (const x of Object.values(ps)) {
      const p = obj(x);
      if (typeof p?.user === "string" && p.user !== "" && str(p.url).includes(urlHas)) {
        l = p;
        break;
      }
    }
  }
  return loginOf(l);
}

// VaultOK whether this host could open the session's vault
export async function VaultOK(s: Session | undefined): Promise<boolean> {
  const [, ok] = await vaultOf(s);
  return ok;
}

// KeyOf the session's user's mcp key: the one in use, a fresh one when
// there's none or it can't be opened, as MCPURL
export async function KeyOf(s: Session | undefined, c: Req): Promise<[string, boolean]> {
  const o = await MCPURL(s, undefined, c);
  const k = typeof o.body?.key === "string" ? o.body.key : "";
  return [k, o.status === 200 && k !== ""];
}
