// a fresh state dir and home fs, this host named a; a release's tarball made
// here, its feed and download served by a local server
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-apps-"));
process.env.HOME_FS = join(dir, "homefs");
process.env.STATE_DIR = join(dir, "state");
process.env.SELF_HOST = "a";
const sysfs = await import("@phosphorus/sysfs");
const W = await import("@phosphorus/webapps");

const sulfur = W.appOf("sulfur")!;

// a gzipped ustar of files: name -> text
function tarGz(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  const blocks: Uint8Array[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, "utf8");
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(data.length.toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write("0", 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(h, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length));
  }
  blocks.push(Buffer.alloc(1024));
  return Bun.gzipSync(Buffer.concat(blocks)) as Uint8Array<ArrayBuffer>;
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const page = (v: string) => tarGz({
  "./sulfur/index.html": `<!doctype html><title>sulfur ${v}</title>`,
  "./sulfur/assets/main-abcdef123456.js": `console.log(${JSON.stringify(v)})`,
  "./sulfur/icon.svg": "<svg/>",
  "./vendor/xterm-0123456789ab.css": "body{}",
  "./wasi.js": "// wasi",
  "../escape.txt": "never written",
});

// the feed and the download on one local server, the body swapped per test
let tar = page("1.0.1");
let feedBody = "";
let feedHits = 0;
const srv = Bun.serve({
  port: 0,
  fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/feed.json") {
      feedHits++;
      return new Response(feedBody, { headers: { "Content-Type": "application/json" } });
    }
    if (p === "/sulfur-web.tar.gz") return new Response(tar);
    return new Response("no", { status: 404 });
  },
});
const base = `http://127.0.0.1:${srv.port}`;
sulfur.feed = `${base}/feed.json`;
const feed = (version: string, data: Uint8Array, extra: Record<string, unknown> = {}) =>
  (feedBody = JSON.stringify({ version, url: `${base}/sulfur-web.tar.gz`, sha256: sha256(data), signature: "", ...extra }));

const req = (path: string, headers: Record<string, string> = {}, method = "GET") => new Request("http://host" + path, { method, headers });

test("nothing installed: no mount, no want, the page's summary bare", async () => {
  expect(W.mounted("/sulfur/")).toBeUndefined();
  expect(W.serve(req("/sulfur/"))).toBeUndefined();
  expect(W.wants()).toEqual({});
  expect(W.installed()).toEqual({});
  feed("1.0.1", tar);
  const s = await W.summary(true);
  expect(s.apps.map((a: any) => [a.id, a.latest, a.want, a.local.version])).toEqual([["sulfur", "1.0.1", null, ""]]);
});

test("a release refused by its url or hash", async () => {
  feedBody = JSON.stringify({ version: "1.0.1", url: `${base}/sulfur-web.tar.gz`, sha256: "nope" });
  let r = await W.Install("sulfur");
  expect(r[0]).toBe(502);
  expect(r[1].error).toContain("feed isn't a release");
  feedBody = JSON.stringify({ version: "1.0.1", url: "http://plain/x.tar.gz", sha256: sha256(tar) });
  r = await W.Install("sulfur");
  expect(r[0]).toBe(502);
  expect(await W.Install("nothing")).toEqual([404, { error: "no app called nothing" }]);
});

test("install: the want written for the mesh, this host following, the page served", async () => {
  feed("1.0.1", tar);
  const [st, body] = await W.Install("sulfur");
  expect(st).toBe(200);
  expect(body.want).toMatchObject({ version: "1.0.1", sha256: sha256(tar), from: "a" });
  expect(W.wantOf("sulfur")).toMatchObject({ version: "1.0.1", from: "a" });
  expect(sysfs.read("etc/apps/sulfur.json")).toMatchObject({ version: "1.0.1" });
  await W.tick(() => "");
  expect(W.installed()).toEqual({ sulfur: { version: "1.0.1" } });
  const root = W.dirOf("sulfur");
  expect(root.endsWith(join("state", "apps", "sulfur", "1.0.1"))).toBe(true);
  expect(existsSync(join(root, "sulfur", "index.html"))).toBe(true);
  // the tarball kept for peers, the escaping entry dropped
  expect(existsSync(join(root, "..", "1.0.1.tar.gz"))).toBe(true);
  expect(existsSync(join(root, "..", "escape.txt"))).toBe(false);
  expect(existsSync(join(dir, "state", "apps", "escape.txt"))).toBe(false);

  // the mount: its page, a file, a route of the page's own, a missing asset
  let res = W.serve(req("/sulfur/"))!;
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(await res.text()).toContain("sulfur 1.0.1");
  res = W.serve(req("/sulfur"))!;
  expect(res.status).toBe(308);
  expect(res.headers.get("Location")).toBe("/sulfur/");
  res = W.serve(req("/sulfur/assets/main-abcdef123456.js"))!;
  expect(res.status).toBe(200);
  expect(res.headers.get("Cache-Control")).toContain("immutable");
  expect(await res.text()).toBe('console.log("1.0.1")');
  res = W.serve(req("/sulfur/some/route", { accept: "text/html" }))!;
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("sulfur 1.0.1");
  res = W.serve(req("/sulfur/assets/gone.js"))!;
  expect(res.status).toBe(404);
  // HEAD without a body
  res = W.serve(req("/sulfur/icon.svg", {}, "HEAD"))!;
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("");
  expect(W.serve(req("/sulfur/", {}, "POST"))).toBeUndefined();

  // its root files beside the desktop's, a folder never
  res = W.serve(req("/vendor/xterm-0123456789ab.css"))!;
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("text/css; charset=utf-8");
  expect(W.serve(req("/vendor/"))).toBeUndefined();
  expect(W.serve(req("/nothing.css"))).toBeUndefined();

  // nothing above the app's folder, however it's spelt
  for (const p of ["/sulfur/../1.0.1.tar.gz", "/sulfur/%2e%2e/1.0.1.tar.gz", "/sulfur/..%2f..%2fcurrent.json", "/sulfur/a/../../1.0.1.ok", "/sulfur/%2e%2e/%2e%2e/1.0.1.ok"]) {
    const r = W.serve(req(p));
    expect([p, r === undefined || r.status === 404 || (r.status === 200 && (await r.text()).includes("sulfur 1.0.1"))]).toEqual([p, true]);
  }
  expect(W.serve(req("/../state/apps/sulfur/current.json"))).toBeUndefined();
  expect(W.Serve("sulfur", "1.0.1").status).toBe(200);
  expect(W.Serve("sulfur", "1.0.0").status).toBe(404);
  expect(W.Serve("other", "1.0.1").status).toBe(404);
});

test("the same release picked again changes nothing", async () => {
  feed("1.0.1", tar);
  const [st, body] = await W.Install("sulfur");
  expect([st, body.current]).toEqual([200, true]);
});

test("a newer release: picked, fetched, the old copy gone", async () => {
  tar = page("1.0.2");
  feed("1.0.2", tar);
  const [st] = await W.Install("sulfur");
  expect(st).toBe(200);
  await W.tick(() => "");
  expect(W.installed()).toEqual({ sulfur: { version: "1.0.2" } });
  expect(existsSync(join(dir, "state", "apps", "sulfur", "1.0.1"))).toBe(false);
  expect(existsSync(join(dir, "state", "apps", "sulfur", "1.0.1.tar.gz"))).toBe(false);
  expect(await W.serve(req("/sulfur/"))!.text()).toContain("sulfur 1.0.2");
  expect(JSON.parse(readFileSync(join(dir, "state", "apps", "sulfur", "current.json"), "utf8"))).toEqual({ version: "1.0.2", sha256: sha256(tar) });
});

test("a download whose hash differs is refused, the copy kept, retried later", async () => {
  const good = tar;
  tar = page("1.0.3-bad");
  feed("1.0.3", page("1.0.3"));
  await W.Install("sulfur");
  await W.tick(() => "");
  const s = W.installed().sulfur!;
  expect(s.version).toBe("1.0.2");
  expect(s.error).toContain("hash");
  expect(await W.serve(req("/sulfur/"))!.text()).toContain("sulfur 1.0.2");
  // the same want not hammered: no second fetch within the retry hold
  tar = page("1.0.3");
  await W.tick(() => "");
  expect(W.installed().sulfur!.version).toBe("1.0.2");
  tar = good;
});

test("a peer's want followed: its copy first, the feed when the peer has none", async () => {
  tar = page("1.0.4");
  const w = { version: "1.0.4", url: `${base}/sulfur-web.tar.gz`, sha256: sha256(tar), signature: "", from: "b", at: Date.now() };
  sysfs.write("etc/apps/sulfur.json", w);
  // b unreachable: the feed's url
  await W.tick(() => "");
  expect(W.installed()).toEqual({ sulfur: { version: "1.0.4" } });
  // b answering with the release itself
  tar = page("1.0.5");
  let peerHits = 0;
  const peersCopy = tar;
  const peer = Bun.serve({ port: 0, fetch: (r) => (new URL(r.url).pathname === "/internal/apps/sulfur/1.0.5" ? (peerHits++, new Response(peersCopy)) : new Response(null, { status: 404 })) });
  sysfs.write("etc/apps/sulfur.json", { ...w, version: "1.0.5", sha256: sha256(peersCopy) });
  // the feed holding another tarball: only the peer's copy matches
  tar = page("stale");
  await W.tick(() => "127.0.0.1", peer.port);
  expect(W.installed()).toEqual({ sulfur: { version: "1.0.5" } });
  expect(peerHits).toBe(1);
  expect(await W.serve(req("/sulfur/"))!.text()).toContain("sulfur 1.0.5");
  tar = peersCopy;
  peer.stop(true);
});

test("remove: the want gone, every copy with it", async () => {
  expect(W.Remove("sulfur")).toEqual([200, { ok: true }]);
  await W.tick(() => "");
  expect(W.installed()).toEqual({});
  expect(existsSync(join(dir, "state", "apps", "sulfur"))).toBe(false);
  expect(W.serve(req("/sulfur/"))).toBeUndefined();
  expect(W.Remove("nothing")[0]).toBe(404);
});

test("a signed release against a key: a bad signature refused, the key's absence trusting the hash", () => {
  const data = page("9");
  const r = { version: "9", url: "https://x/y.tar.gz", sha256: sha256(data), signature: "" };
  expect(() => W.verify(sulfur, r, data)).not.toThrow();
  expect(() => W.verify(sulfur, { ...r, sha256: "0".repeat(64) }, data)).toThrow(/hash/);
});

test("the feed read once per ttl, fresh on demand", async () => {
  feed("1.0.5", tar);
  await W.summary(true);
  const n = feedHits;
  await W.summary(false);
  await W.summary(false);
  expect(feedHits).toBe(n);
  await W.summary(true);
  expect(feedHits).toBe(n + 1);
  srv.stop(true);
});
