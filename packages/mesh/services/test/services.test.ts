import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-services-"));
const file = join(dir, "services.export");
process.env.SERVICES_FILE = file;
process.env.STATE_DIR = join(dir, "state");
process.env.IDLE_POLL_INTERVAL_MS = "20";
// no scan of this machine's ports in the background
process.env.SERVICES_FIND_MS = "0";
// proxy's domain is fixed on its first import: the one its own test expects
process.env.BASE_DOMAIN ??= "mulab.dev";
mkdirSync(process.env.STATE_DIR);
const { adopt, health, migrate, nameFrom, own, pagesOn, parse, portsOf, refresh, removedPorts, setPublic, tunnelID } =
  await import("@phosphorus/services");
// util's StateDir is fixed on its first import, another test's in a whole run
const { StateDir } = await import("@phosphorus/util");

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
  ])
    expect(parse(text!)[1]).toBe(why!);
  expect(parse("")).toEqual([[], "", []]);
});

test("old keys still read, dropped on a rewrite", () => {
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
    "[rl]",
    "type = game",
    "port = 25565",
    "start = systemctl start rl",
    "stop = systemctl stop rl",
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
  const clean = migrate(text);
  expect(clean).toBe(
    [
      "# media",
      "[jelly]",
      "port = 8096",
      "max_body = 50MB",
      "",
      "[up]\r",
      "port = 3001\r",
      "max_body = 1GB\r",
      "[proto]",
      "port = 9000",
      "[rl]",
      "type = game",
      "port = 25565",
      "start = systemctl start rl",
      "stop = systemctl stop rl",
      "",
    ].join("\n"),
  );
  expect(parse(clean)).toEqual([rows, "", []]);
  expect(migrate(clean)).toBe(clean);
  // a rewrite takes them out
  writeFileSync(file, text);
  expect(setPublic("proto", true)).toEqual([200, { public: true }]);
  expect(readFileSync(file, "utf8")).toBe(clean.replace("port = 9000\n", "port = 9000\npublic = true\n"));
  // bad extras still refused
  expect(parse("[a]\nport = 1\nextras = {")[1]).toBe("[a] extras is not valid JSON");
});

test("set public", () => {
  writeFileSync(file, "[web]\nport = 8080\n# keep\n\n[mc]\ntype = game\nport = 25565\n");
  expect(setPublic("web", true)).toEqual([200, { public: true }]);
  expect(readFileSync(file, "utf8")).toBe(
    "[web]\nport = 8080\n# keep\npublic = true\n\n[mc]\ntype = game\nport = 25565\n",
  );
  expect(setPublic("web", true)).toEqual([200, { public: true }]);
  expect(readFileSync(file, "utf8")).toBe(
    "[web]\nport = 8080\n# keep\npublic = true\n\n[mc]\ntype = game\nport = 25565\n",
  );
  expect(setPublic("web", false)).toEqual([200, { public: false }]);
  expect(readFileSync(file, "utf8")).toBe("[web]\nport = 8080\n# keep\n\n[mc]\ntype = game\nport = 25565\n");
  expect(setPublic("nope", true)).toEqual([404, { error: "this host declares no service called nope" }]);
  writeFileSync(file, "[web]\nport = 8080\n[bad]\nport = x\n");
  expect(setPublic("web", true)[0]).toBe(400);
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
  writeFileSync(file, `[web]\nport = ${srv.port}\n[gone]\nport = ${deadPort}\n[mc]\ntype = game\nport = ${deadPort}\n`);
  // a game server's section not served
  const want = ["web"];
  // probes answer in the background: nothing on the first pass
  const first = await refresh("127.0.0.1");
  expect(first.map((r) => r.name)).toEqual([]);
  for (let i = 0; i < 150 && own().length < want.length; i++) {
    await Bun.sleep(20);
    await refresh("127.0.0.1");
  }
  const rows = own();
  expect(rows.map((r) => r.name)).toEqual(want);
  // the scheme sniffed, the mode a path while *.<domain> isn't known to answer
  expect(rows[0]).toEqual({ name: "web", port: srv.port, scheme: "http", mode: "path", auto: true });
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
  expect(await health("mc", "127.0.0.1")).toBeUndefined();
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
  writeFileSync(
    file,
    `[web]
port = 1
`,
  );
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
  writeFileSync(file, "[web]\nport = 1\n");
  await refresh("127.0.0.1");
  const jelly = { port: 9101, scheme: "http", title: "Jelly", name: "jelly" };
  expect(adopt([jelly])).toEqual([jelly]);
  expect(readFileSync(file, "utf8")).toBe("[web]\nport = 1\n\n# found by phosphorus: Jelly\n[jelly]\nport = 9101\n");
  await refresh("127.0.0.1");
  // taken out: remembered, not written back, and forgotten once named again
  writeFileSync(file, "[web]\nport = 1\n");
  await refresh("127.0.0.1");
  expect(removedPorts().has(9101)).toBe(true);
  expect(adopt([jelly])).toEqual([]);
  expect(readFileSync(file, "utf8")).toBe("[web]\nport = 1\n");
  writeFileSync(file, "[web]\nport = 1\n[mine]\nport = 9101\n");
  await refresh("127.0.0.1");
  expect(removedPorts().has(9101)).toBe(false);
});

test("tunnel id", () => {
  const id = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
  expect(tunnelID(Buffer.from(JSON.stringify({ a: "acct", t: id, s: "secret" })).toString("base64"))).toBe(id);
  expect(tunnelID("not a token")).toBe("");
  expect(tunnelID("")).toBe("");
});
