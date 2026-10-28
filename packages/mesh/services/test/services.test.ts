import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-services-"));
const file = join(dir, "services.export");
process.env.SERVICES_FILE = file;
process.env.STATE_DIR = join(dir, "state");
process.env.IDLE_POLL_INTERVAL_MS = "20";
// proxy's domain is fixed on its first import: the one its own test expects
process.env.BASE_DOMAIN ??= "mulab.dev";
mkdirSync(process.env.STATE_DIR);
const { health, own, parse, portsOf, refresh, setPending, setPublic } = await import("@phosphorus/services");
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
      "base_path = app",
      'extras = {"max_body": "10MB", "flush_interval": -1}',
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
      "mode = subdomain",
      "public = maybe",
    ].join("\n"),
  );
  expect(why).toBe("[sub] 'maybe' is not true or false");
  expect(rows).toEqual([]);
  const [ok, none] = parse(
    '[web]\nport = 8080\nextras = {"max_body": "10MB"}\npublic = true\n[mc]\ntype = game\nport = 25565\nstart = a\nstop = b\n[idle]\ntype = game\nport = 7777\n',
  );
  expect(none).toBe("");
  expect(ok).toEqual([
    { max_body: "10MB", name: "web", port: 8080, scheme: "http", mode: "path", base_path: "", public: true },
    { name: "mc", port: 25565, type: "game", mode: "game", controllable: true },
    { name: "idle", port: 7777, type: "game", mode: "game", controllable: false },
  ]);
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
    ["[a]\nscheme = http", "[a] 'undefined' is not a valid port"],
    ["[a]\nport = 80a", "[a] '80a' is not a valid port"],
    ["[a]\nport = 80\nscheme = ftp", "[a] 'ftp' is not http or https"],
    ["[a]\nport = 80\ntype = db", "[a] 'db' is not a service type"],
    ["[a b]\nport = 80", "[a b] 'a b' is not a valid name"],
  ])
    expect(parse(text!)[1]).toBe(why!);
  expect(parse("")).toEqual([[], ""]);
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
  expect(setPublic("mc", true)).toEqual([400, { error: "public is for web services only" }]);
  expect(setPublic("nope", true)).toEqual([404, { error: "this host declares no service called nope" }]);
  expect(setPublic("mc", false)).toEqual([400, { error: "public is for web services only" }]);
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
  let git = false;
  try {
    mkdirSync(StateDir, { recursive: true });
    writeFileSync(
      join(StateDir, "git-role"),
      JSON.stringify({ publish: true, name: "git", port: srv.port, mode: "subdomain", master: true }),
    );
    git = true;
  } catch {}
  const want = git ? ["web", "mc", "git"] : ["web", "mc"];
  // probes answer in the background: nothing on the first pass
  const first = await refresh("127.0.0.1");
  expect(first.map((r) => r.name)).toEqual(["mc"]);
  for (let i = 0; i < 150 && own().length < want.length; i++) {
    await Bun.sleep(20);
    await refresh("127.0.0.1");
  }
  const rows = own();
  expect(rows.map((r) => r.name)).toEqual(want);
  expect(rows[1]!.status).toBe("offline");
  if (git)
    expect(rows[2]).toEqual({
      name: "git",
      port: srv.port,
      scheme: "http",
      mode: "subdomain",
      base_path: "",
      master: true,
    });
  setPending("mc", "start");
  expect((await refresh("127.0.0.1")).find((r) => r.name === "mc")!.status).toBe("starting");
  setPending("mc", "");
  expect((await refresh("127.0.0.1")).find((r) => r.name === "mc")!.status).toBe("offline");

  expect(await health("nope", "127.0.0.1")).toBeUndefined();
  expect(await health("web", "127.0.0.1")).toEqual({
    name: "web",
    port: srv.port,
    type: "web",
    published: true,
    listening: true,
    httpStatus: 200,
    why: "answering",
  });
  expect(await health("gone", "127.0.0.1")).toEqual({
    name: "gone",
    port: deadPort,
    type: "web",
    published: false,
    listening: false,
    why: `not published: nothing on :${deadPort}`,
  });
  expect(await health("mc", "127.0.0.1")).toEqual({
    name: "mc",
    port: deadPort,
    type: "game",
    published: true,
    listening: false,
    why: `nothing listening on :${deadPort}, start it with game_power`,
  });
  srv.stop(true);
});
