// the Games app as a host takes it: built by appbuild from optional/games with a
// key of the test's own, verified, unpacked and loaded; the games the core kept
// in services.export and game-control taken over, its list, form and presses
// answering as the asker may
import "./env.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "@phosphorus/wsock";

const M = await import("@phosphorus/minisign");
const W = await import("@phosphorus/webapps");
const users = await import("@phosphorus/users");
const store = await import("@phosphorus/store");
const { allTools } = await import("@phosphorus/mcp");
const A = await import("../src/apps.ts");

const root = resolve(import.meta.dir, "../../../..");
const out = join(process.env.STATE_DIR!, "..", "gamesbuild");
const services = join(process.env.PHOSPHORUS_HOME!, "config", "services.export");
const gameControl = join(process.env.STATE_DIR!, "game-control");

const ctx = (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown): Ctx => {
  const url = new URL("http://127.0.0.1" + path);
  const req = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { req, url, ip: "127.0.0.1", ingress: false, server: undefined as never };
};

async function cookieOf(name: string, admin: boolean) {
  const boss = { user: "root", admin: true, boot: false, token: "", e: 0 };
  expect((await users.Create(boss, { name, pass: `pw-${name}`, admin })).status).toBe(200);
  const login = await users.Login({ user: name, pass: `pw-${name}` }, ctx("/api/login", "POST"));
  return "phosphorus-user=" + /^phosphorus-user=([^;]+)/.exec(login.cookie![0]!)![1]!;
}

test("the games app: built, loaded, the core's games taken over, answering", async () => {
  // what the core kept: two games beside a web service, game-control's account
  mkdirSync(join(services, ".."), { recursive: true });
  writeFileSync(
    services,
    "[web]\nport = 8080\n\n[mc]\nport = 25565\ntype = game\nstart = ./start.sh\nstop = ./stop.sh\n\n[idle]\ntype = game\nport = 7777\n",
  );
  mkdirSync(gameControl, { recursive: true });
  // a name no account has: nothing written to a real authorized_keys
  writeFileSync(join(gameControl, "user"), "-nobody\n");

  const pair = M.generate();
  const build = Bun.spawnSync(["bun", "scripts/appbuild.ts", "games", out, "1.0.0"], {
    cwd: root,
    env: { ...process.env, UPDATE_SIGNING_KEY: pair.secret, APPS_FEED_BASE: "https://example.test/feed" },
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const rel = JSON.parse(readFileSync(join(out, "games.json"), "utf8"));
  const data = readFileSync(join(out, "games-1.0.0.tar.gz"));
  const app = W.appOf("games")!;
  expect(app.server).toBe(true);
  process.env.APPS_PUBKEY = pair.public;
  W.verify(app, rel, data);
  W.unpack(app, { ...rel, from: "testhost", at: 0 }, data);
  W.reset();
  await A.settleApp("games");
  expect(A.runningApps()).toEqual([{ id: "games", version: "1.0.0" }]);
  expect(W.serve(new Request("http://127.0.0.1/app/games/"))!.status).toBe(200);
  expect(allTools().some((t) => t.name === "game_power")).toBe(true);

  // taken over: the games in its store, services.export left the web service
  for (let i = 0; i < 50 && existsSync(gameControl); i++) await Bun.sleep(20);
  expect(store.read("etc/appdata/games/game/testhost/mc.json")).toEqual({
    port: 25565,
    start: "./start.sh",
    stop: "./stop.sh",
  });
  expect(store.read("etc/appdata/games/game/testhost/idle.json")).toEqual({ port: 7777, start: "", stop: "" });
  expect(readFileSync(services, "utf8")).toBe("[web]\nport = 8080\n");
  expect(existsSync(gameControl)).toBe(false);

  const admin = await cookieOf("gamer", true);
  const player = await cookieOf("player", false);
  const call = async (cookie: string, path: string, method = "GET", body?: unknown) => {
    const c = ctx(path, method, cookie ? { cookie } : {}, body);
    const res = (await A.appRoute(c, c.url.pathname))!;
    return [res.status, await res.json().catch(() => null)] as [number, any];
  };

  expect((await call("", "/api/app/games/games"))[0]).toBe(401);
  const [st, l] = await call(player, "/api/app/games/games");
  expect(st).toBe(200);
  expect(l.admin).toBe(false);
  expect(l.games.map((g: any) => [g.name, g.status, g.controllable, g.address, g.start])).toEqual([
    ["idle", "offline", false, "testhost:7777", undefined],
    ["mc", "offline", true, "testhost:25565", undefined],
  ]);

  // play/stop before a login's allowed, a game with no lines, one not there
  expect(await call(player, "/api/app/games/press", "POST", { host: "testhost", name: "mc", action: "start" })).toEqual(
    [503, { error: "play/stop isn't set up on testhost: an admin allows it with a login there" }],
  );
  expect(
    (await call(player, "/api/app/games/press", "POST", { host: "testhost", name: "idle", action: "start" }))[0],
  ).toBe(409);
  expect(
    (await call(player, "/api/app/games/press", "POST", { host: "testhost", name: "no", action: "start" }))[0],
  ).toBe(404);

  // the form: admins only, a game moved and renamed, removed
  expect((await call(player, "/api/app/games/game", "POST", { host: "testhost", name: "x", port: 1 }))[0]).toBe(403);
  expect(
    await call(admin, "/api/app/games/game", "POST", {
      host: "testhost",
      name: "minecraft",
      port: "25566",
      start: "a",
      stop: "b",
      was: { host: "testhost", name: "mc" },
    }),
  ).toEqual([200, { ok: true }]);
  expect(await call(admin, "/api/app/games/game", "POST", { host: "testhost", name: "idle", port: 1 })).toEqual([
    409,
    { error: "testhost has a game called idle already" },
  ]);
  const [, la] = await call(admin, "/api/app/games/games");
  expect(la.admin).toBe(true);
  expect(la.logins).toEqual({ testhost: "" });
  expect(la.games.map((g: any) => [g.name, g.port, g.start])).toEqual([
    ["idle", 7777, ""],
    ["minecraft", 25566, "a"],
  ]);
  expect(await call(admin, "/api/app/games/remove", "POST", { host: "testhost", name: "idle" })).toEqual([
    200,
    { ok: true },
  ]);
  expect(store.read("etc/appdata/games/game/testhost/idle.json")).toBeUndefined();
  // allowing needs the admin's own saved login there
  expect((await call(admin, "/api/app/games/allow", "POST", { host: "testhost" }))[0]).toBe(403);

  // the users gone again, the next test's host still awaiting its first admin
  const boss = { user: "root", admin: true, boot: false, token: "", e: 0 };
  for (const name of ["gamer", "player"]) expect(users.Remove(boss, { name }).status).toBe(200);
  rmSync(services);

  rmSync(join(process.env.STATE_DIR!, "apps", "games", "current.json"));
  W.reset();
  await A.settleApp("games");
  expect(A.runningApps()).toEqual([]);
  delete process.env.APPS_PUBKEY;
}, 120000);
