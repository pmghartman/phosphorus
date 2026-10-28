// oauth: an agent signs in on the mesh's own page
import { createHash } from "node:crypto";
import { now } from "@phosphorus/util";
import { KeyOf } from "./anthropic.ts";
import { b64url, hex } from "./crypto.ts";
import { CheckMCPKey } from "./mcpkeys.ts";
import { anyAdmin, live, type Req, str } from "./secrets.ts";
import { clip, OpenGrant, type R, SealGrant, type Session } from "./session.ts";

// clients and codes sealed grants any host opens, none kept; the token handed
// back is the user's mcp key, so a refresh, revoke or password change voids it

export const oauthClientMS = 10 * 365 * 24 * 3600 * 1000;
export const oauthCodeMS = 5 * 60 * 1000;
export const verifierRe = /^[A-Za-z0-9._~-]{43,128}$/;
// codes already traded for a token on this host, by when they expire
export const usedCodes = new Map<string, number>();

export const sha = (s: string) => createHash("sha256").update(s).digest();

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
  return (
    u.protocol === "https:" &&
    ["claude.ai", "claude.com"].includes(u.hostname) &&
    u.port === "" &&
    u.pathname === "/api/mcp/auth_callback"
  );
}

// sameRedirect the uri a client registered, a loopback one on any port as RFC 8252 asks
export function sameRedirect(registered: string, asked: string): boolean {
  if (registered === asked) return true;
  try {
    const r = new URL(registered),
      a = new URL(asked);
    return (
      r.protocol === "http:" &&
      a.protocol === "http:" &&
      OAuthRedirectOK(asked) &&
      r.hostname === a.hostname &&
      r.pathname === a.pathname &&
      r.search === a.search
    );
  } catch {
    return false;
  }
}

export const oauthErr = (error: string, why: string): R => ({ status: 400, body: { error, error_description: why } });

// OAuthRegister a client, RFC 7591's dynamic registration: its id the sealed
// record of its name and redirects
export function OAuthRegister(p: Record<string, any>): R {
  const uris = Array.isArray(p.redirect_uris) ? p.redirect_uris.map(str) : [];
  if (!uris.length || uris.length > 8 || !uris.every(OAuthRedirectOK))
    return oauthErr("invalid_redirect_uri", "redirects go to this machine's loopback or claude.ai only");
  const name = clip(p.client_name, 64).trim() || "an agent";
  const id = SealGrant({ oc: 1, n: name, r: uris }, oauthClientMS);
  return {
    status: 201,
    body: {
      client_id: id,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
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
export async function OAuthCode(
  s: Session,
  c: Req,
  clientId: string,
  redirect: string,
  challenge: string,
): Promise<[string, string]> {
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
