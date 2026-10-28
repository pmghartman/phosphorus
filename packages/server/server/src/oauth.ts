// oauth for an agent's mcp connector: its metadata, dynamic registration, the
// mesh's own sign-in page and the token, the user's mcp key, traded for a code
import * as users from "@phosphorus/users";
import type { Ctx } from "@phosphorus/wsock";
import { maxJSONBody, plain, readRaw, reqHost, sendJSON } from "./http.ts";
import { decode, obj, str } from "./js.ts";

const challengeRe = /^[A-Za-z0-9_-]{43}$/;
const maxState = 1024;

// originOf the scheme and host the agent asked by, so every url it's sent back matches
export function originOf(c: Ctx): string {
  const tls = c.url.protocol === "https:" || c.req.headers.get("x-forwarded-proto") === "https";
  return (tls ? "https" : "http") + "://" + reqHost(c);
}

// resourceMeta where a client finds who signs it in to /api/mcp
export const resourceMeta = (c: Ctx) => originOf(c) + "/.well-known/oauth-protected-resource/api/mcp";

// Unauthorized a 401 that sends an mcp client to the sign-in
export function Unauthorized(c: Ctx, why = ""): Response {
  const err = why ? `, error="invalid_token", error_description="${why.replace(/["\\]/g, "")}"` : "";
  return sendJSON(
    401,
    { error: why || "sign in first" },
    { "WWW-Authenticate": `Bearer realm="phosphorus", resource_metadata="${resourceMeta(c)}"${err}` },
  );
}

const noStore = { "Cache-Control": "no-store" };

// oauthRoute the oauth paths, undefined for any other
export async function oauthRoute(c: Ctx, pathname: string): Promise<Response | undefined> {
  const method = c.req.method;
  const base = originOf(c);
  if (
    method === "GET" &&
    (pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-protected-resource/api/mcp")
  ) {
    return sendJSON(200, {
      resource: base + "/api/mcp",
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_name: "Phosphorus",
    });
  }
  if (method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
    return sendJSON(200, {
      issuer: base,
      authorization_endpoint: base + "/oauth/authorize",
      token_endpoint: base + "/oauth/token",
      registration_endpoint: base + "/oauth/register",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  }
  if (pathname === "/oauth/register") {
    if (method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const b = await readRaw(c, maxJSONBody);
    const p = b === undefined ? undefined : obj(decode(b.length ? b : "{}"));
    if (!p) return sendJSON(400, { error: "invalid_client_metadata", error_description: "a JSON object" });
    const r = users.OAuthRegister(p);
    return sendJSON(r.status, r.body, noStore);
  }
  if (pathname === "/oauth/token") {
    if (method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    const p = await formOf(c);
    if (!p) return sendJSON(400, { error: "invalid_request", error_description: "bad body" }, noStore);
    const r = users.OAuthToken(p);
    return sendJSON(r.status, r.body, noStore);
  }
  if (pathname === "/oauth/authorize") {
    if (method === "GET") return authorize(c, Object.fromEntries(c.url.searchParams), false);
    if (method === "POST") {
      const p = await formOf(c);
      if (!p) return plain(400, "bad request");
      return authorize(c, p, true);
    }
    return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  }
}

// formOf a form or JSON body as fields
async function formOf(c: Ctx): Promise<Record<string, any> | undefined> {
  const b = await readRaw(c, maxJSONBody);
  if (b === undefined) return;
  const text = Buffer.from(b).toString("utf8");
  if ((c.req.headers.get("content-type") ?? "").includes("application/json")) return obj(decode(text || "{}"));
  return Object.fromEntries(new URLSearchParams(text));
}

type Ask = { client: string; name: string; redirect: string; challenge: string; state: string };

// askOf an authorize request's fields checked, else why it's refused
function askOf(p: Record<string, any>): [Ask | undefined, string] {
  const client = str(p.client_id);
  const cl = users.OAuthClient(client);
  if (!cl) return [undefined, "this agent isn't registered with the mesh; remove its sign-in and connect it again"];
  const redirect = users.OAuthRedirectFor(client, str(p.redirect_uri));
  if (!redirect) return [undefined, "this agent asked to be sent somewhere it didn't register"];
  if (str(p.response_type) !== "code") return [undefined, "only the code flow is offered"];
  if (str(p.code_challenge_method) !== "S256" || !challengeRe.test(str(p.code_challenge)))
    return [undefined, "the agent didn't send a PKCE S256 challenge"];
  const state = str(p.state);
  if (state.length > maxState) return [undefined, "state too long"];
  return [{ client, name: cl.name, redirect, challenge: str(p.code_challenge), state }, ""];
}

// back the agent's redirect with these fields
function back(redirect: string, fields: Record<string, string>, cookie: string[] = []): Response {
  const u = new URL(redirect);
  for (const [k, v] of Object.entries(fields)) if (v !== "") u.searchParams.set(k, v);
  const h = new Headers({ Location: u.toString(), ...noStore });
  for (const ck of cookie) h.append("Set-Cookie", ck);
  return new Response(null, { status: 302, headers: h });
}

// authorize the sign-in page, then the answer: a code to the agent, or its refusal
async function authorize(c: Ctx, p: Record<string, any>, posted: boolean): Promise<Response> {
  const [ask, why] = askOf(p);
  if (!ask) return page(400, "can't sign this agent in", `<p class="err">${esc(why)}</p>`);
  const iss = originOf(c);
  let s = await users.Soon(c);
  if (s?.boot) s = undefined;
  if (!posted) return page(200, "sign in an agent", form(ask, s?.user ?? "", ""));
  if (str(p.act) === "deny") return back(ask.redirect, { error: "access_denied", state: ask.state, iss });
  let cookie: string[] = [];
  if (!s || str(p.user) !== "") {
    const [r, ns] = await users.SignIn({ user: p.user, pass: p.pass }, c);
    if (!ns || ns.boot)
      return page(
        r.status === 200 ? 403 : r.status,
        "sign in an agent",
        form(ask, "", ns?.boot ? "the setup admin can't sign an agent in, make a user first" : str(r.body?.error)),
      );
    s = ns;
    cookie = r.cookie ?? [];
  }
  const [code, no] = await users.OAuthCode(s, c, ask.client, ask.redirect, ask.challenge);
  if (!code) return page(503, "sign in an agent", form(ask, s.user, no));
  return back(ask.redirect, { code, state: ask.state, iss }, cookie);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

// form the sign-in, or the consent when the browser is already signed in
function form(ask: Ask, user: string, err: string): string {
  const fields = {
    client_id: ask.client,
    redirect_uri: ask.redirect,
    response_type: "code",
    code_challenge: ask.challenge,
    code_challenge_method: "S256",
    state: ask.state,
  };
  const keep = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("");
  const to = new URL(ask.redirect);
  const who = user
    ? `<p>Signed in as <b>${esc(user)}</b>.</p>
<details><summary class="dim">sign in as someone else</summary><label>user<input name="user" autocomplete="username" autocapitalize="none"></label><label>password<input name="pass" type="password" autocomplete="current-password"></label></details>`
    : `<label>user<input name="user" autocomplete="username" autocapitalize="none" required autofocus></label><label>password<input name="pass" type="password" autocomplete="current-password" required></label>`;
  return `<p><b>${esc(ask.name)}</b> wants to use this mesh as you, with your rights and your saved host logins.</p>
<p class="dim">It returns to ${esc(to.host)}. Refreshing or revoking your key in the agent tray signs it out.</p>
${err ? `<p class="err">${esc(err)}</p>` : ""}
<form method="post" action="/oauth/authorize">${keep}${who}
<div class="row"><button name="act" value="deny" formnovalidate class="quiet">deny</button><button name="act" value="allow">allow</button></div>
</form>`;
}

// page the sign-in's own html, no script, never framed
function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Phosphorus sign-in</title><style>
:root{--bg:#f6f5f2;--card:#fff;--fg:#1c1b19;--dim:#6b6860;--line:#dcd9d2;--acc:#7a3cf0;--err:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1d1b;--fg:#ecebe7;--dim:#9b978d;--line:#36342f;--acc:#a983ff;--err:#f2b8b5}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:18px;margin:0 0 12px}p{margin:0 0 12px}.dim{color:var(--dim);font-size:13px}.err{color:var(--err)}
label{display:block;margin:0 0 12px;font-size:13px;color:var(--dim)}input:not([type=hidden]){display:block;width:100%;margin-top:4px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid var(--acc);background:var(--acc);color:#fff;cursor:pointer}
button.quiet{background:transparent;color:var(--fg);border-color:var(--line)}summary{cursor:pointer;margin:0 0 12px}
</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...noStore,
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    },
  });
}
