import "./env.ts";
import { expect, test } from "bun:test";

const { start } = await import("@phosphorus/server");

// the whole server up on a free port with a temp repo and state dir
test("http smoke", async () => {
  const srv = await start();
  try {
    const base = `http://127.0.0.1:${srv.port}`;
    // the page
    const page = await fetch(base + "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await page.text()).toContain("<script");
    // this host as a peer's update asks it, from this machine
    const self = await fetch(base + "/api/self");
    expect(self.status).toBe(200);
    const s = await self.json();
    expect(s.host).toBe("testhost");
    expect(s.bootId).toMatch(/^[0-9a-f-]{36}$/);
    // a peer's link is a websocket alone
    expect((await fetch(base + "/api/peer")).status).toBe(404);
    // no login
    const me = await fetch(base + "/api/me");
    expect(me.status).toBe(401);
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(await me.json()).toEqual({ error: "log in", setup: true });
    // a write from another site's page
    const cross = await fetch(base + "/api/login", {
      method: "POST",
      headers: { origin: "https://elsewhere.test" },
      body: "{}",
    });
    expect(cross.status).toBe(403);
    expect(await cross.text()).toBe("forbidden");
    // a host no page may rebind to
    const bound = await fetch(base + "/api/me", { headers: { host: "evil.example.com" } });
    expect(bound.status).toBe(403);
    // an unknown api path, and a peer-only one from the browser side
    expect((await fetch(base + "/api/nope")).status).toBe(404);
    expect((await fetch(base + "/internal/keys")).status).toBe(403);
    // the state, and its poll interval
    const st = await (await fetch(base + "/api/state")).json();
    expect(st.self.host).toBe("testhost");
    expect(typeof st.pollMs).toBe("number");
    // this host's files, shares on by default under the repo
    const fi = await (await fetch(base + "/api/files/testhost/info")).json();
    expect(fi.host).toBe("testhost");
    expect(Array.isArray(fi.shares)).toBe(true);
    // a ping answered here
    expect((await fetch(base + "/api/ping/testhost")).status).toBe(204);
    // the apps page: no native services left on a fresh mesh
    const apps = await (await fetch(base + "/api/apps")).json();
    expect(apps.nativeLeft).toEqual([]);
    expect(apps.services).toBeUndefined();
    expect((await fetch(base + "/api/apps/services/install", { method: "POST", body: "{}" })).status).toBe(404);
    // the installed services: none yet; an install asked for an app the catalogue can't give
    expect(st.stacks).toEqual({});
    const inst = await fetch(base + "/api/stacks/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "casaos", ref: "UptimeKuma", active: "testhost" }),
    });
    expect([inst.status, await inst.json()]).toEqual([404, { error: "no app UptimeKuma in casaos" }]);
    // the catalogue: for a logged-in user alone
    const cat = await fetch(base + "/api/stacks/catalog");
    expect([cat.status, await cat.json()]).toEqual([403, { error: "log in as a user" }]);
    // no chat in the core: its socket and routes are the chat app's, 404 while it isn't running
    const sock = await new Promise<string>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/chat`);
      ws.onopen = () => res("open");
      ws.onerror = () => res("refused");
    });
    expect(sock).toBe("refused");
    expect((await fetch(base + "/api/chat/upload", { method: "POST", body: "x" })).status).toBe(404);
    expect((await fetch(base + "/api/app/chat/upload", { method: "POST", body: "x" })).status).toBe(404);
  } finally {
    srv.stop(true);
  }
}, 60000);
