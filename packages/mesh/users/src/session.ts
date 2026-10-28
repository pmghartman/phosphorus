// sessions
import { isLoopbackAddr, isTailnetAddr } from "@phosphorus/util";
import * as store from "@phosphorus/store";
import { marshal, now, obj, sleep } from "@phosphorus/util";
import { B64URL, b64url, type Box, boxOf, derive, hashOK, hex, Open, randHex, sameSecret, Seal, unhex } from "./crypto.ts";
import { cleanToken } from "./anthropic.ts";
import { resealMCP } from "./mcpkeys.ts";
import { Cookie, MaxWall, MeshKey, admin, adminPass, anyAdmin, baseDomain, bootSessionMS, hasAdmin, live, maxPass, maxPrefs, maxVault, nameRe, names, passwd, prefKeys, prefsFile, pull, pulled, reserved, secretRel, selfHost, sessionMS, shadow, str, tries, triesMS, triesMax, truthy, type Req, vaultFile, wallFile, wallTypes } from "./secrets.ts";

// Session a logged in browser
export type Session = { user: string; admin: boolean; boot: boolean; key?: Uint8Array; token: string; e: number };

export const cookieRe = /(?:^|[;,]\s*)phosphorus-user=([A-Za-z0-9_-]+)/g;

export const cookiesOf = (c: Req) => [...(c.req.headers.get("cookie") ?? "").matchAll(cookieRe)].map((m) => m[1]!);

export const hostOf = (c: Req) => c.req.headers.get("host") ?? "";

export function attrs(c: Req): string {
  const host = hostOf(c).toLowerCase().replace(/:\d+$/, "");
  const domain = baseDomain && (host === baseDomain || host.endsWith("." + baseDomain)) ? "; Domain=" + baseDomain : "";
  const secure = c.req.headers.get("x-forwarded-proto") === "https" ? "; Secure" : "";
  return "; Path=/" + domain + "; SameSite=Lax; HttpOnly" + secure;
}

export function issue(c: Req, payload: Record<string, unknown>, ms: number): string {
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

export function locked(keys: string[]): number {
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

export function failed(keys: string[]) {
  for (const k of keys) tries.set(k, [...(tries.get(k) ?? []), now()]);
  // a Map's order: insertion, the oldest keys dropped first
  for (const k of tries.keys()) {
    if (tries.size <= 10000) break;
    tries.delete(k);
  }
}

export function openToken(token: string): Record<string, any> | undefined {
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

export const unexpired = (o: Record<string, any> | undefined) => !!o && typeof o.e === "number" && o.e > now();

export function sessionOf(token: string): Session | undefined {
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

export type Vault = Record<string, any>;

// undefined while this host holds no vault it can open, as a fresh host
// before its sys arrives
export function openVault(s: Session): Vault | undefined {
  const text = Open(s.key, boxOf(store.read(vaultFile(s.user))));
  if (text === undefined) return;
  try {
    return obj(JSON.parse(text)) ?? {};
  } catch {
    return {};
  }
}

export async function vaultOf(s: Session | undefined): Promise<[Vault | undefined, boolean]> {
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

export const dataURLRe = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/;

// R a call's answer
export type R = { status: number; body: any; cookie?: string[] };

export const errR = (status: number, msg: string): R => ({ status, body: { error: msg } });

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

export const runes = (s: string) => [...s].length;

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

export async function setPass(name: string, pass: string, vault: unknown, adminFlag?: boolean): Promise<Uint8Array> {
  const salt = randHex(16);
  const out = await derive(pass, salt);
  const pwAt = randHex(8);
  if (adminFlag !== undefined) store.write(passwd(name), { admin: adminFlag });
  store.write(shadow(name), { salt, hash: hex(out.subarray(0, 32)), pwAt });
  store.write(vaultFile(name), Seal(out.subarray(32), marshal(vault)));
  return out.subarray(32);
}

export const hostKeyRe = /^[a-z0-9][a-z0-9-]{0,62}$/;

// the first n code points, as Go's runes
export function clip(v: unknown, n: number): string {
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
export function pageVault(v: Vault): Vault {
  const { anthropic, ...out } = v;
  return out;
}

// the session's vault, this host's sys pulled when it can't open one
export async function vaultOrPull(s: Session): Promise<Vault | undefined> {
  let v = openVault(s);
  if (!v) {
    await pull();
    v = openVault(s);
  }
  return v;
}

export const notSynced = () => errR(503, "this host hasn't your saved logins yet, try again shortly");

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

export const needAdmin = (s: Session | undefined): R | undefined => (s?.admin ? undefined : errR(403, "admins only"));

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
