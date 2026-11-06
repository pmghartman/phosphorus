import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-services-"));
// the store under it, this host named a
process.env.PHOSPHORUS_REPO_DIR = dir;
process.env.SELF_HOST = "a";
process.env.STATE_DIR = join(dir, "state");
process.env.IDLE_POLL_INTERVAL_MS = "20";
// no scan of this machine's ports in the background
process.env.SERVICES_FIND_MS = "0";
// proxy's domain is fixed on its first import: the one its own test expects
process.env.BASE_DOMAIN ??= "mulab.dev";
mkdirSync(process.env.STATE_DIR);
const {
  adopt,
  editService,
  health,
  listed,
  nameFrom,
  own,
  pagesOn,
  portsOf,
  records,
  refresh,
  removedPorts,
  setPublic,
  setStackRows,
} = await import("@phosphorus/services");
const store = await import("@phosphorus/store");

// this host's records as given, every other one gone
function recordsAre(recs: Record<string, unknown>) {
  for (const f of store.list("etc/services/a")) store.remove(`etc/services/a/${f}`);
  for (const [name, r] of Object.entries(recs)) store.write(`etc/services/a/${name}.json`, r);
}

test("editService creates, edits, rejects and removes a record", () => {
  recordsAre({});
  expect(editService("Web", { port: 1 }, false, false)).toEqual(["'Web' is not a valid name", ""]);
  expect(editService("web", {}, false, false)).toEqual(["web has no port", ""]);
  expect(editService("w".repeat(64), { port: 1 }, false, false)).toEqual(["a name is at most 63 characters", ""]);
  expect(editService("web", {}, true, false)).toEqual(["no service web", ""]);
  // dry: the change alone, nothing written
  expect(editService("web", { port: 8080 }, false, true)).toEqual(["", "+ web :8080"]);
  expect(store.read("etc/services/a/web.json")).toBeUndefined();
  expect(editService("web", { port: 8080, public: true }, false, false)).toEqual(["", "+ web :8080 public"]);
  expect(store.read("etc/services/a/web.json")).toEqual({ port: 8080, public: true });
  // what isn't given kept
  expect(editService("web", { port: 8081 }, false, false)).toEqual(["", "- web :8080 public\n+ web :8081 public"]);
  expect(editService("web", { public: false }, false, false)).toEqual(["", "- web :8081 public\n+ web :8081"]);
  expect(store.read("etc/services/a/web.json")).toEqual({ port: 8081 });
  expect(listed()).toEqual([{ name: "web", port: 8081 }]);
  // the same again: no change
  expect(editService("web", { port: 8081 }, false, false)).toEqual(["", ""]);
  // a bad edit never written
  expect(editService("web", { port: 70000 }, false, false)[0]).toBe("'70000' is not a valid port");
  expect(store.read<{ port: number }>("etc/services/a/web.json")!.port).toBe(8081);
  // an installed service's page the wizard's
  store.write("etc/stacks/kuma.json", { def: {} });
  expect(editService("kuma", { port: 1 }, false, false)[0]).toBe(
    "kuma is an installed service, its page set in the service wizard",
  );
  store.remove("etc/stacks/kuma.json");
  expect(editService("web", {}, true, true)).toEqual(["", "- web :8081"]);
  expect(editService("web", {}, true, false)[0]).toBe("");
  expect(store.read("etc/services/a/web.json")).toBeUndefined();
  // its port remembered, a found page there not written back; forgotten once named again
  expect(removedPorts().has(8081)).toBe(true);
  expect(editService("site", { port: 8081 }, false, false)[0]).toBe("");
  expect(removedPorts().has(8081)).toBe(false);
});

test("set public, on any host's record", () => {
  recordsAre({ web: { port: 8080 } });
  expect(setPublic("a", "web", true)).toEqual([200, { public: true }]);
  expect(store.read("etc/services/a/web.json")).toEqual({ port: 8080, public: true });
  expect(setPublic("a", "web", false)).toEqual([200, { public: false }]);
  expect(store.read("etc/services/a/web.json")).toEqual({ port: 8080 });
  expect(setPublic("a", "nope", true)).toEqual([404, { error: "a declares no service called nope" }]);
  store.write("etc/services/b/db.json", { port: 5432 });
  expect(setPublic("b", "db", true)).toEqual([200, { public: true }]);
  expect(store.read("etc/services/b/db.json")).toEqual({ port: 5432, public: true });
  // another host's not this one's
  expect(records().map((r) => r.name)).toEqual(["web"]);
  // a record that won't check not published
  store.write("etc/services/a/bad.json", { port: "x" });
  expect(records().map((r) => r.name)).toEqual(["web"]);
  store.remove("etc/services/a/bad.json");
});

test("ports of", () => {
  const ss =
    "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 128 [::]:80 [::]:*\nLISTEN 0 128 100.64.0.5:7777 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:631 0.0.0.0:*\nLISTEN 0 128 *:9000 *:*\n";
  const addrs = ss.split("\n").map((l) => l.split(/\s+/)[3]!);
  expect([...portsOf(addrs, "100.64.0.5")].sort()).toEqual([22, 7777, 80, 9000]);
  expect([...portsOf(["[::1]:5000", "::"], "100.64.0.5")]).toEqual([]);
});

test("refresh and health", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("ok") });
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
  const deadPort = dead.port;
  dead.stop(true);
  recordsAre({ web: { port: srv.port }, gone: { port: deadPort }, kuma: { port: deadPort } });
  // an installed service's row its want's, a record of its name left out
  setStackRows(() => [{ name: "kuma", port: srv.port!, scheme: "", public: true }]);
  const want = ["kuma", "web"];
  // probes answer in the background: nothing on the first pass
  const first = await refresh("127.0.0.1");
  expect(first.map((r) => r.name)).toEqual([]);
  for (let i = 0; i < 150 && own().length < want.length; i++) {
    await Bun.sleep(20);
    await refresh("127.0.0.1");
  }
  const rows = own();
  expect(rows.map((r) => r.name)).toEqual(want);
  expect(rows[0]).toMatchObject({ name: "kuma", port: srv.port, public: true });
  // the scheme sniffed, the mode a path while *.<domain> isn't known to answer
  expect(rows[1]).toEqual({ name: "web", port: srv.port, scheme: "http", mode: "path", auto: true });
  expect(await health("nope", "127.0.0.1")).toBeUndefined();
  expect(await health("web", "127.0.0.1")).toEqual({
    name: "web",
    port: srv.port,
    published: true,
    listening: true,
    scheme: "http",
    mode: "path",
    httpStatus: 200,
    why: "answering",
  });
  expect(await health("gone", "127.0.0.1")).toEqual({
    name: "gone",
    port: deadPort,
    published: false,
    listening: false,
    scheme: "http",
    mode: "path",
    why: `not published: nothing on :${deadPort}`,
  });
  setStackRows(() => []);
  srv.stop(true);
});

test("name from title", () => {
  expect(nameFrom("Jellyfin")).toBe("jellyfin");
  expect(nameFrom("Home Assistant")).toBe("home-assistant");
  expect(nameFrom("Dashboard - Grafana")).toBe("dashboard");
  expect(nameFrom("qBittorrent v4.6 Web UI")).toBe("qbittorrent-v4-6-web-ui");
  expect(nameFrom("日本")).toBe("");
});

test("pages on ports", async () => {
  const page = Bun.serve({
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === "/"
        ? Response.redirect("/web/", 302)
        : new Response("<html><head><title> Jelly &amp; Fin </title></head></html>", {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          }),
  });
  const api = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true }) });
  const bare = Bun.serve({
    port: 0,
    fetch: () => new Response("<h1>hi</h1>", { headers: { "Content-Type": "text/html" } }),
  });
  const taken = Bun.serve({
    port: 0,
    fetch: () => new Response("<title>web</title>", { headers: { "Content-Type": "text/html" } }),
  });
  const failing = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("<title>Service Unavailable</title>", { status: 503, headers: { "Content-Type": "text/html" } }),
  });
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
  const deadPort = dead.port;
  dead.stop(true);
  recordsAre({ web: { port: 1 } });
  await refresh("127.0.0.1");
  const got = await pagesOn("127.0.0.1", [api.port!, page.port!, bare.port!, deadPort!, taken.port!, failing.port!]);
  // the HTML pages with titles alone, error pages left out, a name already declared given its port
  expect(got.sort((a, b) => a.port - b.port)).toEqual(
    [
      { port: page.port!, scheme: "http", title: "Jelly & Fin", name: "jelly-fin" },
      { port: taken.port!, scheme: "http", title: "web", name: `web-${taken.port}` },
    ].sort((a, b) => a.port - b.port),
  );
  for (const s of [page, api, bare, taken, failing]) s.stop(true);
});

test("found pages written in, a removed one left alone", async () => {
  recordsAre({ web: { port: 1 } });
  await refresh("127.0.0.1");
  const jelly = { port: 9101, scheme: "http", title: "Jelly", name: "jelly" };
  expect(adopt([jelly])).toEqual([jelly]);
  expect(store.read("etc/services/a/jelly.json")).toEqual({ port: 9101 });
  // a name taken since not written over
  expect(adopt([{ ...jelly, port: 9102 }])).toEqual([]);
  // removed: remembered, not written back
  expect(editService("jelly", {}, true, false)[0]).toBe("");
  expect(removedPorts().has(9101)).toBe(true);
  expect(adopt([jelly])).toEqual([]);
  expect(store.read("etc/services/a/jelly.json")).toBeUndefined();
});
