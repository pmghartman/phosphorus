import { expect, test } from "bun:test";

process.env.BASE_DOMAIN = "mulab.dev";
const { frameable, reverseLocation } = await import("@phosphorus/proxy");

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
