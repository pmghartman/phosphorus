// mcp keys: one per user, its rights, a new one voiding the last
import { randomBytes } from "node:crypto";
import * as store from "@phosphorus/store";
import { marshal, obj } from "@phosphorus/util";
import { type Box, boxOf, hex, Open, randHex, Seal, unhex } from "./crypto.ts";
import { baseDomain, live, mcpFile, type Req } from "./secrets.ts";
import { OpenGrant, SealGrant, cleanVault, errR, hostOf, notSynced, openToken, type R, type Session, type Vault, unexpired, vaultOf } from "./session.ts";

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

export function mcpGrant(u: string, pwAt: string, g: string, k: Uint8Array, logins: Vault, pages: Vault, c: Req, fresh: boolean): R {
  const key = SealGrant({ u, p: pwAt, m: g, k: hex(k) }, 365 * 24 * 3600 * 1000);
  return { status: 200, body: { key, url: MCPBase(c) + "/api/mcp/" + key, fresh, user: u, hosts: Object.keys(logins).sort(), pages: Object.keys(pages).sort() } };
}

// MCPBase where an agent reaches the mesh: the base domain, else the host asked
export function MCPBase(c: Req): string {
  if (baseDomain) return "https://" + baseDomain;
  const tls = c.url.protocol === "https:" || c.req.headers.get("x-forwarded-proto") === "https";
  return (tls ? "https" : "http") + "://" + hostOf(c);
}

export type McpRec = { g: string; kk?: Box; c?: Box; p?: Box };

// mcpRecord the user's key record, its boxes typed
export function mcpRecord(u: string): McpRec {
  const o = obj(store.read(mcpFile(u))) ?? {};
  return { g: typeof o.g === "string" ? o.g : "", kk: boxOf(o.kk), c: boxOf(o.c), p: boxOf(o.p) };
}

// resealMCP the key's host logins kept in step with a vault just saved
export function resealMCP(s: Session, vault: Vault) {
  const rec = mcpRecord(s.user);
  if (!rec.kk) return;
  const k = unhex(Open(s.key, rec.kk));
  if (!k || k.length !== 32) return;
  store.write(mcpFile(s.user), { g: rec.g, kk: rec.kk, c: Seal(k, marshal(vault.hosts)), p: Seal(k, marshal(vault.pages)) });
}

// a saved login's user and pass, ok false when there's no user
export function loginOf(l: unknown): [string, string, boolean] {
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
export function mcpOpen(key: string, box: (r: McpRec) => Box | undefined): Record<string, any> | undefined {
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
