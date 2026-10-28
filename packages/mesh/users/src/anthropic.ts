// anthropic
import * as store from "@phosphorus/store";
import { marshal, obj } from "@phosphorus/util";
import { Seal } from "./crypto.ts";
import { loginOf, MCPURL } from "./mcpkeys.ts";
import { maxVault, type Req, str, vaultFile } from "./secrets.ts";
import { cleanVault, errR, notSynced, type R, type Session, type Vault, vaultOf, vaultOrPull } from "./session.ts";

// a user's own Anthropic subscription token (claude setup-token's), kept in
// their vault under their password: only a request carrying their login
// opens it; and what a Code session needs of a logged in user: a host
// login, their mcp key, all from that same vault

export const maxToken = 512;
export const tokenRe = /^[A-Za-z0-9_.:+/=-]+$/;

// cleanToken a token as kept, "" for none or a bad one
export function cleanToken(v: unknown): string {
  const t = str(v).trim();
  return Buffer.byteLength(t) > maxToken || !tokenRe.test(t) ? "" : t;
}

// DropOldTokens the tokens older releases sealed with the mesh key, gone
export function DropOldTokens() {
  for (const f of store.list("home"))
    if (f.split("/").length === 2 && f.endsWith("/anthropic.json")) store.remove("home/" + f);
}

// the old tokens gone on the first read too, any synced in late
export let dropped = false;
export function dropOnce() {
  if (dropped) return;
  dropped = true;
  DropOldTokens();
}

// SetAnthropic the token sealed in the vault, "" clearing it
export async function SetAnthropic(s: Session | undefined, p: Record<string, any>): Promise<R> {
  if (!s || s.boot || !s.key?.length) return errR(403, "log in as a user");
  dropOnce();
  const t = str(p.token).trim();
  if (t !== "" && cleanToken(t) === "")
    return errR(400, "that isn't a token: run claude setup-token and paste what it prints");
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
export async function PageLogin(
  s: Session | undefined,
  name: string,
  urlHas: string,
): Promise<[string, string, boolean]> {
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
