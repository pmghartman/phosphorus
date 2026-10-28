import { expect, test } from "bun:test";
import { accepts, serveStatic } from "@phosphorus/webstatic";

const get = (path: string, headers: Record<string, string> = {}) =>
  serveStatic(new Request(`http://x${path}`, { headers }));

test("accepts", () => {
  const r = (ae: string) => accepts(new Request("http://x/", { headers: { "Accept-Encoding": ae } }), "gzip");
  expect(r("gzip, deflate")).toBe(true);
  expect(r("br;q=1, gzip;q=0")).toBe(false);
  expect(r("identity")).toBe(false);
});

test("the page, raw and gzipped, with etags", async () => {
  const raw = await get("/");
  expect(raw.status).toBe(200);
  expect(raw.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(raw.headers.get("content-encoding")).toBeNull();
  const html = await raw.text();
  expect(html).toContain('<script type="module" src="/assets/main-');
  const gz = await get("/index.html", { "Accept-Encoding": "gzip" });
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(gz.headers.get("etag")).toBe(raw.headers.get("etag"));
  expect((await get("/", { "If-None-Match": raw.headers.get("etag")! })).status).toBe(304);
  const asset = html.match(/src="(\/assets\/main-[^"]+)"/)![1]!;
  // a hashed file lives only as .gz, served inflated to a browser without gzip
  const a = await get(asset);
  expect(a.headers.get("cache-control")).toContain("immutable");
  expect((await a.text()).length).toBeGreaterThan(1000);
  expect((await get(asset + ".gz")).status).toBe(404);
  expect((await get("/nope.js")).status).toBe(404);
});
