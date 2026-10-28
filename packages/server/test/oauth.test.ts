import "./env.ts";
import { expect, test } from "bun:test";
import type { Ctx } from "@phosphorus/wsock";

const { appHandler, start } = await import("@phosphorus/server");

// a request as the ingress hands it over, cloudflared's https in front
const viaIngress = (path: string, init: RequestInit = {}): Ctx => {
  const url = "http://mesh.test" + path;
  return { req: new Request(url, { ...init, headers: { host: "mesh.test", "x-forwarded-proto": "https", ...init.headers } }), url: new URL(url), ip: "203.0.113.5", ingress: true, server: undefined as any };
};

// an agent's whole road in: sent to sign in, the metadata, registration, the page, the token
test("oauth for the mcp connector", async () => {
  const srv = await start();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    // keyless from outside the mesh: a 401 that names the resource metadata
    const no = (await appHandler(viaIngress("/api/mcp", { method: "POST", body: "{}" })))!;
    expect(no.status).toBe(401);
    expect(no.headers.get("www-authenticate")).toBe('Bearer realm="phosphorus", resource_metadata="https://mesh.test/.well-known/oauth-protected-resource/api/mcp"');
    const bad = (await appHandler(viaIngress("/api/mcp", { method: "POST", body: "{}", headers: { authorization: "Bearer xx" } })))!;
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    // the metadata, every url on the host the agent asked by
    const pr = await (await appHandler(viaIngress("/.well-known/oauth-protected-resource/api/mcp")))!.json();
    expect(pr).toMatchObject({ resource: "https://mesh.test/api/mcp", authorization_servers: ["https://mesh.test"] });
    const as = await (await fetch(base + "/.well-known/oauth-authorization-server")).json();
    expect(as.issuer).toBe(base);
    expect(as.authorization_endpoint).toBe(base + "/oauth/authorize");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    // registration: loopback redirects only
    const evil = await fetch(base + "/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["https://evil.test/cb"] }) });
    expect(evil.status).toBe(400);
    const reg = await fetch(base + "/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "Claude <b>Code</b>", redirect_uris: ["http://localhost:4567/callback"] }) });
    expect(reg.status).toBe(201);
    const { client_id } = await reg.json();
    // the sign-in page, never framed, the client's name escaped
    const q = new URLSearchParams({
      client_id, redirect_uri: "http://localhost:4567/callback", response_type: "code", state: "st",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    });
    const pg = await fetch(base + "/oauth/authorize?" + q);
    expect(pg.status).toBe(200);
    expect(pg.headers.get("x-frame-options")).toBe("DENY");
    const html = await pg.text();
    expect(html).toContain("Claude &#60;b&#62;Code&#60;/b&#62;");
    expect(html).toContain('name="pass"');
    // a redirect it didn't register: refused on the page, never sent there
    const off = await fetch(base + "/oauth/authorize?" + new URLSearchParams({ ...Object.fromEntries(q), redirect_uri: "http://evil.test/cb" }), { redirect: "manual" });
    expect(off.status).toBe(400);
    // denied: back to the agent with the refusal and its state
    const deny = await fetch(base + "/oauth/authorize", { method: "POST", body: new URLSearchParams({ ...Object.fromEntries(q), act: "deny" }), redirect: "manual" });
    expect(deny.status).toBe(302);
    const to = new URL(deny.headers.get("location")!);
    expect([to.host, to.searchParams.get("error"), to.searchParams.get("state")]).toEqual(["localhost:4567", "access_denied", "st"]);
    // a code it never got
    const tok = await fetch(base + "/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: "nope", client_id, redirect_uri: "http://localhost:4567/callback", code_verifier: "v".repeat(43) }) });
    expect(tok.status).toBe(400);
    expect(tok.headers.get("cache-control")).toBe("no-store");
    expect((await tok.json()).error).toBe("invalid_grant");
  } finally {
    srv.stop(true);
  }
}, 30000);
