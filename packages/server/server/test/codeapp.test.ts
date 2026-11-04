// the Code app as a host takes it: built by appbuild from optional/code with
// a key of the test's own, its signature checked, unpacked, its server half loaded
// and its api answering a logged in user; its page served at its mount
import "./env.ts";
import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Ctx } from "@phosphorus/wsock";

const M = await import("@phosphorus/minisign");
const W = await import("@phosphorus/webapps");
const users = await import("@phosphorus/users");
const { marshal } = await import("@phosphorus/util");
const { websocket } = await import("@phosphorus/wsock");
const A = await import("../src/apps.ts");

const root = resolve(import.meta.dir, "../../../..");
const out = join(process.env.STATE_DIR!, "..", "appbuild");

const ctx = (path: string, method = "GET", headers: Record<string, string> = {}, body?: unknown): Ctx => {
  const url = new URL("http://127.0.0.1" + path);
  const req = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { req, url, ip: "127.0.0.1", ingress: false, server: undefined as never };
};

test("the code app: built, signed, verified, loaded, answering", async () => {
  const pair = M.generate();
  const build = Bun.spawnSync(["bun", "scripts/appbuild.ts", "code", out, "1.0.0"], {
    cwd: root,
    env: { ...process.env, UPDATE_SIGNING_KEY: pair.secret, APPS_FEED_BASE: "https://example.test/feed" },
  });
  expect(build.exitCode, build.stderr.toString()).toBe(0);
  const rel = JSON.parse(readFileSync(join(out, "code.json"), "utf8"));
  const data = readFileSync(join(out, "code-1.0.0.tar.gz"));
  const app = W.appOf("code")!;
  expect(app.server).toBe(true);

  // the release key pinned: another key's signature refused, its own taken
  process.env.APPS_PUBKEY = M.generate().public;
  expect(() => W.verify(app, rel, data)).toThrow(/signature/);
  process.env.APPS_PUBKEY = pair.public;
  W.verify(app, rel, data);
  W.unpack(app, { ...rel, from: "testhost", at: 0 }, data);
  W.reset();
  await A.settleApp("code");
  expect(A.runningApps()).toEqual([{ id: "code", version: "1.0.0" }]);

  // its page at its mount, its icon beside it
  const page = W.serve(new Request("http://127.0.0.1/app/code/"))!;
  expect(page.status).toBe(200);
  expect(await page.text()).toContain('id="view-code"');
  expect(W.serve(new Request("http://127.0.0.1/app/code/icon.svg"))!.status).toBe(200);

  // a user with no host login: nowhere to run, nothing listed
  const admin = { user: "root", admin: true, boot: false, token: "", e: 0 };
  expect((await users.Create(admin, { name: "cody", pass: "pw-cody" })).status).toBe(200);
  const login = await users.Login({ user: "cody", pass: "pw-cody" }, ctx("/api/login", "POST"));
  const cookie = "phosphorus-user=" + /^phosphorus-user=([^;]+)/.exec(login.cookie![0]!)![1]!;
  const call = async (path: string, method = "GET", body?: unknown, h: Record<string, string> = { cookie }) => {
    const c = ctx(path, method, h, body);
    const res = (await A.appRoute(c, c.url.pathname))!;
    return [res.status, await res.json()];
  };
  expect((await call("/api/app/code/options", "GET", undefined, {}))[0]).toBe(401);
  const [st, o] = await call("/api/app/code/options");
  expect(st).toBe(200);
  expect(o).toMatchObject({ hosts: [], offline: [], anthropic: false, blocked: "no saved login on any computer" });
  expect(o.harnesses.map((h: any) => h.id)).toEqual(["claude", "opencode"]);
  expect(await call("/api/app/code/sessions")).toEqual([200, { sessions: [] }]);
  expect(await call("/api/app/code/ls?host=testhost&dir=~")).toEqual([
    403,
    { error: "no saved login on any computer" },
  ]);

  // a login saved: offered while the host is up, Anthropic's models once the token is in
  const s = users.Of(ctx("/", "GET", { cookie }))!;
  const store = await import("@phosphorus/store");
  store.write(
    users.vaultFile("cody"),
    users.Seal(s.key!, marshal({ hosts: { testhost: { user: "cody", pass: "x" } }, pages: {} })),
  );
  expect((await call("/api/app/code/anthropic", "POST", { token: "sk-ant-oat01-abc" }))[1]).toEqual({
    anthropic: true,
  });
  const [, o2] = await call("/api/app/code/options");
  expect([o2.hosts, o2.blocked, o2.models.map((m: any) => m.id)]).toEqual([
    ["testhost"],
    undefined,
    ["mesh", "opus", "sonnet", "haiku"],
  ]);
  expect((await call("/api/app/code/sessions/abcdefabcdef"))[0]).toBe(404);
  const [, md] = await call("/api/app/code/md", "POST", { texts: ["**hi**", "<script>x</script>"] });
  expect(md.html[0]).toContain("<strong>hi</strong>");
  expect(md.html[1]).not.toContain("<script>");

  // its socket: a session not the user's closed at once
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    websocket,
    fetch(req, server) {
      const url = new URL(req.url);
      return A.appSocket({ req, url, ip: "127.0.0.1", ingress: false, server }, url.pathname) || undefined;
    },
  });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/app/code/ws/abcdefabcdef?since=0`, {
      headers: { cookie },
    } as any);
    const code = await new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
    expect(code).toBe(4000);
  } finally {
    server.stop(true);
  }

  // gone as the installer drops it: its folder locked while loaded, on windows
  rmSync(join(process.env.STATE_DIR!, "data", "apps", "code", "current.json"));
  W.reset();
  await A.settleApp("code");
  expect(A.runningApps()).toEqual([]);
  delete process.env.APPS_PUBKEY;
}, 120000);
