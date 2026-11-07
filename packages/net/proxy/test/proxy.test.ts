import { expect, test } from "bun:test";

process.env.BASE_DOMAIN = "mulab.dev";
const { frameable, reverseLocation } = await import("@phosphorus/proxy");

test("settle", async () => {
  const { settle } = await import("@phosphorus/proxy");
  const row = (host: string, name: string, mode: string, auto?: boolean) => ({
    host,
    name,
    port: 1,
    scheme: "http",
    mode,
    ...(auto ? { auto } : {}),
  });
  // an asked-for subdomain keeps its name; of two picked ones the first host's does
  expect(
    settle([
      row("a", "lab", "subdomain", true),
      row("b", "lab", "subdomain"),
      row("a", "sun", "subdomain", true),
      row("b", "sun", "subdomain", true),
      row("c", "own", "path"),
    ]).map((r) => `${r.host}/${r.name}:${r.mode}`),
  ).toEqual(["a/lab:path", "b/lab:subdomain", "a/sun:subdomain", "b/sun:path", "c/own:path"]);
});

test("unrebindable follows the mesh's DNS zone", async () => {
  const { unrebindable } = await import("@phosphorus/proxy");
  const { noteMagicDNS } = await import("@phosphorus/util");
  expect(unrebindable("100.64.0.3:8090")).toBe(true);
  expect(unrebindable("vps")).toBe(true);
  expect(unrebindable("vps.mesh.mulab.dev")).toBe(false);
  noteMagicDNS("mesh.mulab.dev.");
  expect(unrebindable("vps.mesh.mulab.dev")).toBe(true);
  expect(unrebindable("VPS.mesh.mulab.dev.:80")).toBe(true);
  expect(unrebindable("evil.example")).toBe(false);
  expect(unrebindable("vps.tail1234.ts.net")).toBe(false);
});

test("frameable", () => {
  expect(frameable("frame-ancestors 'none';")).toBe("frame-ancestors 'self' https://mulab.dev");
  expect(frameable("default-src 'self'; FRAME-ANCESTORS 'none'; img-src *")).toBe(
    "default-src 'self'; img-src *; frame-ancestors 'self' https://mulab.dev",
  );
  // an X-Frame-Options alone, dropped: the policy that replaces it
  expect(frameable("")).toBe("frame-ancestors 'self' https://mulab.dev");
});

test("reverse location", () => {
  const prefix = "/torus/sunshine",
    host = "mulab.dev",
    svc = "100.105.120.33:47990";
  for (const [loc, want] of [
    ["/welcome", "/torus/sunshine/welcome"],
    ["/", "/torus/sunshine/"],
    ["/apps?x=1#top", "/torus/sunshine/apps?x=1#top"],
    ["/a%2Fb", "/torus/sunshine/a%2Fb"],
    ["https://mulab.dev/welcome", "https://mulab.dev/torus/sunshine/welcome"],
    ["https://MULAB.dev", "https://MULAB.dev/torus/sunshine/"],
    ["https://100.105.120.33:47990/pin", "https://100.105.120.33:47990/torus/sunshine/pin"],
    // already under the prefix, relative, or elsewhere: as they are
    ["/torus/sunshine/welcome", "/torus/sunshine/welcome"],
    ["/torus/sunshine", "/torus/sunshine"],
    ["/torus/sunshinex", "/torus/sunshine/torus/sunshinex"],
    ["welcome", "welcome"],
    ["./welcome", "./welcome"],
    ["?q=1", "?q=1"],
    ["//evil.example/x", "//evil.example/x"],
    ["https://accounts.example/login", "https://accounts.example/login"],
    ["mailto:a@b", "mailto:a@b"],
  ])
    expect(reverseLocation(loc!, prefix, host, svc)).toBe(want!);
  expect(reverseLocation("/welcome", "", host)).toBe("/welcome");
});

test("ingress forwards http and websockets", async () => {
  const { serve, handler, swap } = await import("@phosphorus/proxy");
  const back = Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return;
      const u = new URL(req.url);
      return new Response(`${u.pathname}${u.search} ${req.headers.get("x-forwarded-proto")}`, {
        headers: { "X-Frame-Options": "DENY" },
      });
    },
    websocket: { message: (ws, m) => void ws.send("echo:" + m) },
  });
  swap([{ host: "box", name: "web", port: back.port, scheme: "http", mode: "path", public: true }], () => "127.0.0.1");
  const front = serve(
    0,
    handler(() => new Response("app"), { pass: () => false, issuers: () => [] }),
    true,
  );
  const base = `http://127.0.0.1:${front.port}`;
  const r = await fetch(`${base}/box/web/hi?x=1`);
  expect(await r.text()).toBe("/hi?x=1 http");
  // from a peer's edge over the tailnet, it saying https: kept, with no forwarded_proto to set
  const t = await fetch(`${base}/box/web/hi`, { headers: { "X-Forwarded-Proto": "https" } });
  expect(await t.text()).toBe("/hi https");
  expect(r.headers.get("content-security-policy")).toBe("frame-ancestors 'self' https://mulab.dev");
  const got = await new Promise<string>((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${front.port}/box/web/sock`);
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (e) => (res(String(e.data)), ws.close());
    ws.onerror = () => rej(new Error("ws failed"));
  });
  expect(got).toBe("echo:ping");
  front.stop(true);
  back.stop(true);
});

test("the hub's relay upgrades with no login, other frontend upgrades still gated", async () => {
  const { serve, handler } = await import("@phosphorus/proxy");
  const front = serve(
    0,
    handler((c) => new Response(`app ${c.url.pathname}`), { pass: () => false, issuers: () => [] }),
    true,
  );
  const up = (path: string) =>
    fetch(`http://127.0.0.1:${front.port}${path}`, {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
  const r = await up("/mesh/relay");
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("app /mesh/relay");
  expect((await up("/api/terminal")).status).toBe(401);
  expect((await up("/mesh/relay/x")).status).toBe(401);
  front.stop(true);
});

test("a path link to a service now on a subdomain is sent there", async () => {
  const { serve, handler, swap } = await import("@phosphorus/proxy");
  swap([{ host: "box", name: "media", port: 1, scheme: "http", mode: "subdomain", public: true }], () => "127.0.0.1");
  const front = serve(
    0,
    handler(() => new Response("app"), { pass: () => true, issuers: () => [] }),
    true,
  );
  const r = await fetch(`http://127.0.0.1:${front.port}/box/media/web/?x=1`, {
    headers: { Host: "mulab.dev" },
    redirect: "manual",
  });
  expect(r.status).toBe(302);
  expect(r.headers.get("location")).toBe("https://media.mulab.dev/web/?x=1");
  // the tailnet's own address keeps its paths
  const t = await fetch(`http://127.0.0.1:${front.port}/box/media/web/`, { redirect: "manual" });
  expect(t.status).toBe(200);
  expect(await t.text()).toBe("app");
  front.stop(true);
});

test("an alias answers for its route's winning copy, and yields to a route of its own", async () => {
  const { serve, handler, swap } = await import("@phosphorus/proxy");
  const back = (tag: string) =>
    Bun.serve({ port: 0, fetch: (req) => new Response(`${tag} ${new URL(req.url).pathname}`) });
  const [old, cur, other] = [back("old"), back("cur"), back("other")];
  const row = (host: string, name: string, port: number | undefined, more: Record<string, unknown> = {}) => ({
    host,
    name,
    port,
    scheme: "http",
    mode: "subdomain",
    public: true,
    ...more,
  });
  const ips: Record<string, string> = { a: "127.0.0.1", b: "127.0.0.1" };
  // a former active's copy and the master one: git follows the master
  swap(
    [
      row("a", "forgejo", old.port, { aliases: ["git"] }),
      row("b", "forgejo", cur.port, { aliases: ["git"], master: true }),
    ],
    (h) => ips[h]!,
  );
  const front = serve(
    0,
    handler(() => new Response("app"), { pass: () => true, issuers: () => [] }),
    true,
  );
  const get = async (host: string) =>
    (await fetch(`http://127.0.0.1:${front.port}/x`, { headers: { Host: host } })).text();
  expect(await get("forgejo.mulab.dev")).toBe("cur /x");
  expect(await get("git.mulab.dev")).toBe("cur /x");
  // a service really called git takes its name back
  swap([row("b", "forgejo", cur.port, { aliases: ["git"] }), row("a", "git", other.port)], (h) => ips[h]!);
  expect(await get("git.mulab.dev")).toBe("other /x");
  expect(await get("forgejo.mulab.dev")).toBe("cur /x");
  for (const s of [front, old, cur, other]) s.stop(true);
});
