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

// --- services: a checkout per host, the ssh start, the host's own side and GitHub faked ----

import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const circuit = W.serviceOf("circuit")!;
const tavern = W.serviceOf("tavern")!;
type Ran = { host: string; user: string; script: string };
const ran: Ran[] = [];
const published: [string, Record<string, string> | null][] = [];
let launchExit = 0;
let publishStatus = 200;
const routes: { host: string; name: string; port: number; mode: string; scheme: string; base_path: string }[] = [];
// the logins' homes on this host, a, under the temp dir
const homes = join(dir, "homes");
const homeOf = (login: string) => join(homes, login);
const jobsDir = (login: string) => join(homeOf(login), ".phosphorus", "services", ".jobs");
// what GitHub says main is past each commit, and the icon it serves
const ahead: Record<string, number> = {};
let iconBytes: Uint8Array | undefined = new TextEncoder().encode("PNG!");
let iconHits = 0;
W.svcSeams.tailnet = () => [{ name: "a", os: "linux", phosphorus: true }, { name: "b", os: "linux", phosphorus: true }, { name: "w", os: "windows", phosphorus: true }, { name: "phone", os: "ios", phosphorus: false }];
W.svcSeams.routes = () => routes;
W.svcSeams.homeOf = homeOf;
W.svcSeams.hostInfo = (h) => (h === "a" ? { services: W.svcProgress() } : undefined);
W.svcSeams.run = async (host, login, script, onOut) => {
  ran.push({ host, user: login.user, script });
  onOut("started as the user unit phos-svc-x\n");
  return launchExit;
};
W.svcSeams.publishLocal = async (name, fields) => {
  published.push([name, fields]);
  if (publishStatus !== 200) return [publishStatus, { error: "nope" }];
  if (fields) routes.push({ host: "a", name, port: Number(fields.port), mode: fields.mode ?? "path", scheme: "http", base_path: "" });
  else routes.splice(0, routes.length, ...routes.filter((r) => r.name !== name));
  return [200, { ok: true, outcome: { published: true } }];
};
W.svcSeams.fetchJSON = async (url) => {
  const m = /compare\/([0-9a-f]+)\.\.\.main$/.exec(url);
  if (!m || !(m[1]! in ahead)) throw new Error("404");
  return { ahead_by: ahead[m[1]!] };
};
W.svcSeams.fetchBytes = async () => {
  iconHits++;
  return iconBytes && { data: iconBytes, type: "image/png" };
};
process.env.APPS_ICON_DIR = join(dir, "icons");

// the unit on the host ended: its log, exit and commit left for the host to find
function ended(login: string, id: string, exit: number, log: string, commit = "") {
  mkdirSync(jobsDir(login), { recursive: true });
  writeFileSync(join(jobsDir(login), id + ".log"), log);
  writeFileSync(join(jobsDir(login), id + ".exit"), exit + "\n");
  if (commit) writeFileSync(join(jobsDir(login), id + ".commit"), commit + "\n");
}

test("the catalogue: circuit and tavern as services, their scripts in the login's own checkout", () => {
  expect(W.Services.map((s) => [s.id, s.port, s.mode, s.os, s.data])).toEqual([["circuit", 8099, "path", ["linux"], []], ["tavern", 8484, "path", ["linux"], ["data", ".env"]]]);
  expect(W.svcRepoOf(circuit)).toEqual({ owner: "pmghartman", name: "circuit" });
  const inst = W.svcScript(circuit, "install");
  expect(inst).toContain('dir="$HOME/.phosphorus/services/circuit"');
  expect(inst).toContain("git clone -q https://github.com/pmghartman/circuit.git");
  expect(inst).toContain("PORT=8099 scripts/install.sh");
  expect(inst.startsWith("set -e\n")).toBe(true);
  expect(inst).not.toContain("restored");
  // tavern's data back into a fresh checkout, aside on a remove that keeps it
  expect(W.svcScript(tavern, "install")).toContain('mv "$keep/$p" "$dir/$p"');
  expect(W.svcScript(tavern, "update")).toContain("scripts/update.sh");
  expect(W.svcScript(tavern, "update")).toContain("install first");
  const rm = W.svcScript(tavern, "remove");
  expect(rm).toContain("systemctl --user disable --now tavern");
  expect(rm).toContain('rm -rf "$dir"');
  expect(rm).not.toContain("kept $p");
  const keep = W.svcScript(tavern, "remove", true);
  expect(keep).toContain("for p in data .env; do");
  expect(keep).toContain('mv "$dir/$p" "$keep/$p"');
  expect(keep.indexOf("kept $p")).toBeLessThan(keep.indexOf('rm -rf "$dir"'));
  // the start: the script written under .jobs, run as a transient unit with the step's time
  const l = W.svcLaunch(circuit, "install");
  expect(l).toContain('cat > "$j/circuit.sh" <<');
  expect(l).toContain(inst);
  expect(l).toContain("systemd-run --user --quiet --collect --unit=phos-svc-circuit -p RuntimeMaxSec=2700");
  expect(l).toContain("nohup setsid");
  expect(l).toContain("loginctl enable-linger");
  expect(l).toContain('git -C "$4" rev-parse HEAD >"$5"');
});

test("an op refused: no such service, a bad op, a host that isn't one, the wrong os, no login", async () => {
  const login = { user: "pat", pass: "x" };
  expect((await W.ServiceOp("install", "nothing", "a", login, "pat"))[0]).toBe(404);
  expect((await W.ServiceOp("dance", "circuit", "a", login, "pat"))[0]).toBe(400);
  expect((await W.ServiceOp("install", "circuit", "phone", login, "pat"))[0]).toBe(404);
  expect((await W.ServiceOp("install", "circuit", "zzz", login, "pat"))[0]).toBe(404);
  const [st, b] = await W.ServiceOp("install", "circuit", "w", login, "pat");
  expect([st, b.error]).toEqual([400, "Circuit runs on linux hosts; w is windows"]);
  expect((await W.ServiceOp("install", "circuit", "a", { user: "", pass: "" }, "pat"))[0]).toBe(400);
  expect(ran).toEqual([]);
  // the start itself failing: no job noted
  launchExit = 255;
  const r = await W.ServiceOp("install", "circuit", "a", login, "pat");
  expect(r[0]).toBe(502);
  expect(r[1].error).toContain("couldn't start it");
  expect(W.svcJobOf("circuit", "a")).toBeUndefined();
  launchExit = 0;
  ran.length = 0;
});

test("install: started on the host as the login, the job noted for the mesh, this host finishing it", async () => {
  const [st, b] = await W.ServiceOp("install", "circuit", "a", { user: "pat", pass: "x" }, "pmh");
  expect(st).toBe(200);
  expect(b.job).toMatchObject({ id: "circuit", host: "a", op: "install", login: "pat", by: "pmh", from: "a", done: 0 });
  expect(ran.map((r) => [r.host, r.user])).toEqual([["a", "pat"]]);
  expect(ran[0]!.script).toBe(W.svcLaunch(circuit, "install"));
  expect(sysfs.read("etc/services/circuit/jobs/a.json")).toMatchObject({ op: "install", login: "pat" });
  // the same host again while it runs
  expect((await W.ServiceOp("update", "circuit", "a", { user: "pat", pass: "x" }, "pmh"))[0]).toBe(409);
  // under way: the log's tail in this host's info, nothing published yet
  mkdirSync(jobsDir("pat"), { recursive: true });
  writeFileSync(join(jobsDir("pat"), "circuit.log"), "cloning\nbuilding\n");
  await W.svcTick();
  expect(W.svcProgress()).toEqual({ circuit: { log: "cloning\nbuilding\n" } });
  expect(published).toEqual([]);
  let s = (await W.svcSummary()).find((x: any) => x.id === "circuit")!;
  expect(s.hosts.a.job).toMatchObject({ op: "install", done: 0, log: "cloning\nbuilding\n" });
  expect(s.icon).toBe("/api/apps/services/circuit/icon");
  // ended: published here, recorded with the checkout's commit, the job done
  ended("pat", "circuit", 0, "cloning\nbuilding\ndone\n", "abcdef0123456789");
  ahead.abcdef0123456789 = 3;
  await W.svcTick();
  expect(published).toEqual([["circuit", { port: "8099", mode: "path" }]]);
  expect(W.svcRecordOf("circuit", "a")).toMatchObject({ login: "pat", by: "pmh", commit: "abcdef0123456789" });
  const j = W.svcJobOf("circuit", "a")!;
  expect([j.ok, j.error, j.done > 0]).toEqual([true, "", true]);
  expect(W.svcProgress().circuit).toMatchObject({ exit: 0 });
  s = (await W.svcSummary()).find((x: any) => x.id === "circuit")!;
  expect(s.hosts.a).toMatchObject({ published: true, record: { login: "pat", commit: "abcdef0123456789" }, behind: 3 });
  expect(s.hosts.a.job).toMatchObject({ ok: true, exit: 0 });
  expect(s.checkout).toBe("~/.phosphorus/services/circuit");
  // the page's summary carries them beside the apps
  const all = await W.summary(false);
  expect(all.services.map((x: any) => x.id)).toEqual(["circuit", "tavern"]);
});

test("a failing script: the job failed with the exit, nothing published; tried again once done", async () => {
  ran.length = published.length = 0;
  expect((await W.ServiceOp("install", "tavern", "a", { user: "pat", pass: "x" }, "pmh"))[0]).toBe(200);
  ended("pat", "tavern", 2, "npm ci failed\n");
  await W.svcTick();
  const j = W.svcJobOf("tavern", "a")!;
  expect([j.ok, j.error]).toEqual([false, "the install script exited 2"]);
  expect(published).toEqual([]);
  expect(W.svcRecordOf("tavern", "a")).toBeUndefined();
  expect((await W.ServiceOp("install", "tavern", "a", { user: "pat", pass: "x" }, "pmh"))[0]).toBe(200);
  expect(W.svcJobOf("tavern", "a")!.done).toBe(0);
  ended("pat", "tavern", 0, "ok\n", "1234567");
  await W.svcTick();
  expect(W.svcJobOf("tavern", "a")!.ok).toBe(true);
  expect(W.svcRecordOf("tavern", "a")).toMatchObject({ login: "pat", commit: "1234567" });
});

test("a step past its time with no exit: failed", async () => {
  rmSync(join(jobsDir("pat"), "circuit.exit"), { force: true });
  expect((await W.ServiceOp("update", "circuit", "a", { user: "pat", pass: "x" }, "pmh"))[0]).toBe(200);
  const j = W.svcJobOf("circuit", "a")!;
  sysfs.write("etc/services/circuit/jobs/a.json", { ...j, at: Date.now() - W.svcTimeoutMS.update - 120000 });
  await W.svcTick();
  expect(W.svcJobOf("circuit", "a")!.error).toContain("ran past 30 minutes");
});

test("publishing refused: the job failed, the record kept as it was", async () => {
  publishStatus = 500;
  expect((await W.ServiceOp("update", "circuit", "a", { user: "pat", pass: "x" }, "pmh"))[0]).toBe(200);
  ended("pat", "circuit", 0, "pulled\n", "abcdef0123456789");
  await W.svcTick();
  const j = W.svcJobOf("circuit", "a")!;
  expect([j.op, j.ok]).toEqual(["update", false]);
  expect(j.error).toContain("publishing: nope");
  publishStatus = 200;
});

test("remove, its data kept: the start asked with keep, the entry dropped, the record gone", async () => {
  ran.length = published.length = 0;
  expect((await W.ServiceOp("remove", "tavern", "a", { user: "pat", pass: "x" }, "pmh", true))[0]).toBe(200);
  expect(ran[0]!.script).toBe(W.svcLaunch(tavern, "remove", true));
  expect(ran[0]!.script).toContain("kept $p");
  expect(W.svcJobOf("tavern", "a")!.keep).toBe(true);
  ended("pat", "tavern", 0, "removed\n");
  await W.svcTick();
  expect(published).toEqual([["tavern", null]]);
  expect(W.svcRecordOf("tavern", "a")).toBeUndefined();
  expect(routes.some((r) => r.name === "tavern")).toBe(false);
  const s = (await W.svcSummary()).find((x: any) => x.id === "tavern")!;
  expect(s.hosts.a.published).toBe(false);
  expect(s.hosts.a.job).toMatchObject({ op: "remove", keep: true, ok: true });
  // keep means nothing to an install
  expect(W.svcJobOf("circuit", "a")!.keep).toBe(false);
});

test("main moved: GitHub's compare an hour at a time, nothing for a commit it can't place", async () => {
  expect(await W.svcBehindMain(circuit, "abcdef0123456789")).toBe(3);
  ahead.abcdef0123456789 = 9;
  expect(await W.svcBehindMain(circuit, "abcdef0123456789")).toBe(3);
  expect(await W.svcBehindMain(circuit, "ffffffff")).toBeNull();
  expect(await W.svcBehindMain(circuit, "not a commit")).toBeNull();
});

test("the icon off the repository, kept a day, the kept copy when the fetch fails", async () => {
  const ic = (await W.svcIcon("circuit"))!;
  expect([ic.type, new TextDecoder().decode(ic.data), iconHits]).toEqual(["image/png", "PNG!", 1]);
  expect(iconHits).toBe(1);
  await W.svcIcon("circuit");
  expect(iconHits).toBe(1);
  expect(await W.svcIcon("nothing")).toBeUndefined();
  W.svcReset();
});

test("a web app's icon off its repository, for the page before any host serves it", async () => {
  const hits = iconHits;
  const ic = (await W.AppIcon("sulfur"))!;
  expect([ic.type, new TextDecoder().decode(ic.data), iconHits - hits]).toEqual(["image/svg+xml", "PNG!", 1]);
  expect(await W.AppIcon("nothing")).toBeUndefined();
});
