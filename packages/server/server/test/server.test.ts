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
    expect((await fetch(base + "/api/sys/stamps")).status).toBe(403);
    expect((await fetch(base + "/internal/keys")).status).toBe(403);
    // the state, and its poll interval
    const st = await (await fetch(base + "/api/state")).json();
    expect(st.self.host).toBe("testhost");
    expect(typeof st.pollMs).toBe("number");
    expect(st.gameZone).toBe("phosphorus");
    // this host's files, shares on by default under the repo
    const fi = await (await fetch(base + "/api/files/testhost/info")).json();
    expect(fi.host).toBe("testhost");
    expect(Array.isArray(fi.shares)).toBe(true);
    // a ping answered here
    expect((await fetch(base + "/api/ping/testhost")).status).toBe(204);
    // the apps page: services beside the apps; a service's step needs a login, admin or not
    const apps = await (await fetch(base + "/api/apps")).json();
    expect(apps.services.map((x: any) => x.id)).toEqual(["circuit", "tavern"]);
    const svc = await fetch(base + "/api/apps/services/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "circuit", host: "testhost" }),
    });
    expect(svc.status).toBe(403);
    expect(await svc.json()).toEqual({ error: "log in as a user" });
    expect((await fetch(base + "/api/apps/services/dance", { method: "POST", body: "{}" })).status).toBe(404);
    // the chat socket: a join's history and presence
    const got = await new Promise<any[]>((res, rej) => {
      const out: any[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/chat`);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", name: "tester" }));
      ws.onmessage = (e) => {
        out.push(JSON.parse(String(e.data)));
        if (out.some((m) => m.type === "history") && out.filter((m) => m.type === "presence").length >= 2) {
          ws.close();
          res(out);
        }
      };
      ws.onerror = () => rej(new Error("ws failed"));
      setTimeout(() => rej(new Error("no history")), 5000);
    });
    expect(got[0].type).toBe("presence");
    const h = got.find((m) => m.type === "history");
    expect(h.messages).toEqual([]);
    expect(got.at(-1).people).toEqual([{ name: "tester", color: expect.stringMatching(/^#/), host: "testhost" }]);
  } finally {
    srv.stop(true);
  }
}, 60000);
