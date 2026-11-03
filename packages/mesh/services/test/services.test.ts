import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-services-"));
const file = join(dir, "services.export");
process.env.SERVICES_FILE = file;
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
  migrateFile,
  nameFrom,
  own,
  pagesOn,
  parse,
  portsOf,
  records,
  refresh,
  removedPorts,
  setPublic,
  setStackRows,
  tunnelID,
} = await import("@phosphorus/services");
const store = await import("@phosphorus/store");

// this host's records as given, every other one gone
function recordsAre(recs: Record<string, unknown>) {
  for (const f of store.list("etc/services/a")) store.remove(`etc/services/a/${f}`);
  for (const [name, r] of Object.entries(recs)) store.write(`etc/services/a/${name}.json`, r);
}

test("parse", () => {
  const [rows, why] = parse(
    [
      "# a comment",
      "; another",
      "[ web ]",
      'port = "8080"',
      "scheme = https",
      "max_body = 10MB",
      "public = true",
      "",
      "[mc]\r",
      "type = game\r",
      "port = 25565\r",
      "start = systemctl start mc",
      "stop = systemctl stop mc",
      "[idle]",
      "type = game",
      "port = 7777",
      "[sub]",
      "port = 3000",
      "public = maybe",
    ].join("\n"),
  );
  expect(why).toBe("[sub] 'maybe' is not true or false");
  expect(rows).toEqual([]);
  const [ok, none, old] = parse(
    "[web]\nport = 8080\nmax_body = 10MB\npublic = true\n[mc]\ntype = game\nport = 25565\nstart = a\nstop = b\n[idle]\ntype = game\nport = 7777\n",
  );
  expect(none).toBe("");
  expect(old).toEqual([]);
  // a game server's section left for the Games app to take
  expect(ok).toEqual([{ name: "web", port: 8080, scheme: "", max_body: "10MB", public: true }]);
});

test("aliases: more names, comma or space separated", () => {
  expect(parse("[forgejo]\nport = 3001\naliases = git, code")[0]).toEqual([
    { name: "forgejo", port: 3001, scheme: "", aliases: ["git", "code"] },
  ]);
  expect(parse("[forgejo]\nport = 3001\naliases =")[0]).toEqual([{ name: "forgejo", port: 3001, scheme: "" }]);
});

test("parse rejects", () => {
  for (const [text, why] of [
    ["port = 1", "line 1: port outside any [section]"],
    ["[a]\nhello", "line 2 is not key = value"],
    ["[a]\nport = 1\ncolour = red", "[a] has an unknown key, colour"],
    ["[a]\nport = 1\n[a]\nport = 2", "[a] is declared twice"],
    ["[a]\nport = 1\nextras = {", "[a] extras is not valid JSON"],
    ["[a]\nport = 1\nextras = [1]", "[a] extras is not a JSON object"],
    ["[a]\nport = 1\nextras = null", "[a] extras is not a JSON object"],
    ['[a]\nport = 1\nextras = {"x": 1}', "[a] extras has an unknown key, x"],
    ["[a]\nscheme = http", "[a] has no port"],
    ["[a]\nport = 1\nmax_body = lots", "[a] 'lots' is not a valid max_body"],
    ["[a]\nport = 1\nstart = x", "[a] has an unknown key, start"],
    ["[a]\nport = 1\nflush_interval = 5", "[a] has an unknown key, flush_interval"],
    ["[a]\nport = 80a", "[a] '80a' is not a valid port"],
    ["[a]\nport = 80\nscheme = ftp", "[a] 'ftp' is not http or https"],
    ["[a]\nport = 80\ntype = db", "[a] has an unknown key, type"],
    ["[a b]\nport = 80", "[a b] 'a b' is not a valid name"],
    ["[a]\nport = 80\naliases = Git", "[a] 'Git' is not a valid alias"],
    ["[a]\nport = 80\naliases = a", "[a] 'a' is not a valid alias"],
  ])
    expect(parse(text!)[1]).toBe(why!);
  expect(parse("")).toEqual([[], "", []]);
});

test("old keys still read", () => {
  // as the live mesh's files have them
  const text = [
    "# media",
    "[jelly]",
    "port = 8096",
    "mode = path",
    "base_path = web",
    'extras = {"max_body": "50MB", "forwarded_proto": "https", "flush_interval": -1}',
    "",
    "[up]\r",
    "port = 3001\r",
    "max_body = 1GB\r",
    'extras = {"max_body": "5MB"}\r',
    "[proto]",
    "port = 9000",
    'extras = {"forwarded_proto": "https"}',
    "",
  ].join("\n");
  const [rows, why, old] = parse(text);
  expect(why).toBe("");
  expect(old).toEqual(["[jelly] mode", "[jelly] base_path", "[jelly] extras", "[up] extras", "[proto] extras"]);
  expect(rows).toEqual([
    // a top-level max_body over extras' own, mode and base_path not read
    { name: "jelly", port: 8096, scheme: "", max_body: "50MB" },
    { name: "up", port: 3001, scheme: "", max_body: "1GB" },
    { name: "proto", port: 9000, scheme: "" },
  ]);
});

test("services.export moved into the store once, games and bad sections kept, then gone", () => {
  recordsAre({ kept: { port: 1 } });
  // the wizard's own, its route its want's
  store.write("etc/stacks/forgejo.json", { def: {} });
  writeFileSync(
    file,
    '# media\n[jelly]\nport = 8096\nmode = path\nextras = {"max_body": "50MB"}\n\n' +
      "[forgejo]\nport = 3001\naliases = git\n\n[retro]\nport = 8080\nscheme = https\npublic = true\naliases = games, arcade\n" +
      "[kept]\nport = 2\n[rl]\r\ntype = game\r\nport = 25565\r\n[bad]\nport = x\n",
  );
  migrateFile();
  expect(store.read("etc/services/a/jelly.json")).toEqual({ port: 8096, max_body: "50MB" });
  expect(store.read("etc/services/a/retro.json")).toEqual({
    port: 8080,
    scheme: "https",
    public: true,
    aliases: ["games", "arcade"],
  });
  // one already in the store left as it is, an installed one not made a record
  expect(store.read("etc/services/a/kept.json")).toEqual({ port: 1 });
  expect(store.read("etc/services/a/forgejo.json")).toBeUndefined();
  const rest = "[rl]\r\ntype = game\r\nport = 25565\r\n[bad]\nport = x\n";
  expect(readFileSync(file, "utf8")).toBe(rest);
  // again: nothing new; once the Games app and an admin take the rest, the file goes
  migrateFile();
  expect(readFileSync(file, "utf8")).toBe(rest);
  writeFileSync(file, "# found by phosphorus: Web\n[web]\nport = 9\n");
  migrateFile();
  expect(existsSync(file)).toBe(false);
  expect(store.read("etc/services/a/web.json")).toEqual({ port: 9 });
  store.remove("etc/stacks/forgejo.json");
});

test("editService creates, edits, rejects and removes a record", () => {
  recordsAre({});
  expect(editService("Web", { port: "1" }, false, false)).toEqual(["[Web] 'Web' is not a valid name", ""]);
  expect(editService("web", { nope: "1" }, false, false)).toEqual([
    "no field nope, only port, scheme, max_body, public, aliases",
    "",
  ]);
  expect(editService("web", { mode: "path" }, false, false)[0]).toBe(
    "no field mode, only port, scheme, max_body, public, aliases",
  );
  expect(editService("web", {}, false, false)).toEqual(["[web] has no port", ""]);
  expect(editService("web", { port: "1\n[x]" }, false, false)).toEqual(["one line only", ""]);
  expect(editService("w".repeat(64), { port: "1" }, false, false)).toEqual(["a name is at most 63 characters", ""]);
  expect(editService("web", {}, true, false)).toEqual(["no service web", ""]);
  // dry: the diff alone, nothing written
  expect(editService("web", { port: " 8080 " }, false, true)).toEqual(["", "+ [web]\n+ port = 8080"]);
  expect(store.read("etc/services/a/web.json")).toBeUndefined();
  expect(editService("web", { port: "8080", scheme: "https" }, false, false)).toEqual([
    "",
    "+ [web]\n+ port = 8080\n+ scheme = https",
  ]);
  expect(editService("web", { scheme: "", max_body: "50MB", aliases: "www  site" }, false, false)).toEqual([
    "",
    "- scheme = https\n+ max_body = 50MB\n+ aliases = www, site",
  ]);
  expect(store.read("etc/services/a/web.json")).toEqual({ port: 8080, max_body: "50MB", aliases: ["www", "site"] });
  expect(listed()).toEqual([{ name: "web", port: "8080", max_body: "50MB", aliases: "www, site" }]);
  // the same again: no change
  expect(editService("web", { port: "8080" }, false, false)).toEqual(["", ""]);
  // a bad edit never written
  expect(editService("web", { port: "nope" }, false, false)[0]).toBe("[web] 'nope' is not a valid port");
  expect(store.read<{ port: number }>("etc/services/a/web.json")!.port).toBe(8080);
  // an installed service's page the wizard's
  store.write("etc/stacks/kuma.json", { def: {} });
  expect(editService("kuma", { port: "1" }, false, false)[0]).toBe(
    "kuma is an installed service, its page set in the service wizard",
  );
  store.remove("etc/stacks/kuma.json");
  expect(editService("web", {}, true, true)).toEqual([
    "",
    "- [web]\n- port = 8080\n- max_body = 50MB\n- aliases = www, site",
  ]);
  expect(editService("web", {}, true, false)[0]).toBe("");
  expect(store.read("etc/services/a/web.json")).toBeUndefined();
  // its port remembered, a found page there not written back; forgotten once named again
  expect(removedPorts().has(8080)).toBe(true);
  expect(editService("site", { port: "8080" }, false, false)[0]).toBe("");
  expect(removedPorts().has(8080)).toBe(false);
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

test("tunnel id", () => {
  const id = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
  expect(tunnelID(Buffer.from(JSON.stringify({ a: "acct", t: id, s: "secret" })).toString("base64"))).toBe(id);
  expect(tunnelID("not a token")).toBe("");
  expect(tunnelID("")).toBe("");
});
