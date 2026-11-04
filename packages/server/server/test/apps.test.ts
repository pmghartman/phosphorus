// an installed app's server half: its copy laid out as the installer leaves one,
// loaded, its routes answered and guarded, swapped for a new version, stopped
import "./env.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "@phosphorus/wsock";

const W = await import("@phosphorus/webapps");
const store = await import("@phosphorus/store");
const { allTools } = await import("@phosphorus/mcp");
const A = await import("../src/apps.ts");

W.Catalog.push(
  W.firstParty({
    id: "demo",
    name: "Demo",
    tagline: "",
    about: "",
    features: [],
    category: "",
    server: true,
    key: "x",
  }),
);

const appDir = join(process.env.STATE_DIR!, "data", "apps", "demo");

// the copy the installer would leave: the page, the server half, the stamps
function install(version: string, js: string) {
  const dir = join(appDir, version);
  mkdirSync(join(dir, "app", "demo"), { recursive: true });
  mkdirSync(join(dir, "server"), { recursive: true });
  writeFileSync(join(dir, "app", "demo", "index.html"), "<!doctype html>");
  writeFileSync(join(dir, "server", "index.js"), js);
  writeFileSync(join(appDir, version + ".ok"), "x\n");
  writeFileSync(join(appDir, "current.json"), JSON.stringify({ version, sha256: "x" }));
  W.reset();
}

const mod = (v: string) => `
export function register(ctx) {
  ctx.route("GET", "/hello", (r) => [200, { v: ${JSON.stringify(v)}, id: ctx.id, path: r.path }], { public: true });
  ctx.route("GET", "/files/*", (r) => [200, { path: r.path }], { public: true });
  ctx.route("GET", "/me", (r) => [200, { who: r.who }]);
  ctx.route("POST", "/echo", async (r) => [200, { got: await r.json(), peer: r.peer }], { internal: true });
  ctx.store.write("greeting", { text: "hi" });
  ctx.tools([{ name: "demo_ping", title: "Ping", description: "pong", schema: { type: "object" }, read: true, run: async () => "pong" }]);
  ctx.onStop(() => { globalThis.demoStopped = (globalThis.demoStopped ?? 0) + 1; });
}`;

const ctx = (path: string, method = "GET", body?: unknown): Ctx => {
  const url = new URL("http://127.0.0.1" + path);
  const req = new Request(url, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { req, url, ip: "127.0.0.1", ingress: false, server: undefined as never };
};
const call = async (path: string, method = "GET", body?: unknown) => {
  const res = await A.appRoute(ctx(path, method, body), path);
  return res ? [res.status, await res.json().catch(() => null)] : undefined;
};

test("an app's server half: loaded, its routes guarded, its store its own, swapped, stopped", async () => {
  expect(await call("/api/files/x/list")).toBeUndefined();
  expect(await call("/api/app/demo/hello")).toEqual([404, { error: "demo isn't running here" }]);

  install("1.0.0", mod("1"));
  await A.settleApp("demo");
  expect(A.runningApps()).toEqual([{ id: "demo", version: "1.0.0" }]);
  expect(await call("/api/app/demo/hello")).toEqual([200, { v: "1", id: "demo", path: "/hello" }]);
  expect(await call("/api/app/demo/files/a/b")).toEqual([200, { path: "/files/a/b" }]);
  // no login, no route but a public one; an internal one never from a page
  expect((await call("/api/app/demo/me"))![0]).toBe(401);
  expect((await call("/api/app/demo/echo", "POST", { a: 1 }))![0]).toBe(404);
  expect(await call("/internal/app/demo/echo", "POST", { a: 1 })).toEqual([200, { got: { a: 1 }, peer: "testhost" }]);
  expect((await call("/api/app/demo/nothing"))![0]).toBe(404);
  expect(store.read("etc/appdata/demo/greeting.json")).toEqual({ text: "hi" });
  expect(allTools().some((t) => t.name === "demo_ping")).toBe(true);
  expect(existsSync(A.appDataDir("demo"))).toBe(true);

  install("1.0.1", mod("2"));
  await A.settleApp("demo");
  expect((globalThis as any).demoStopped).toBe(1);
  expect(await call("/api/app/demo/hello")).toEqual([200, { v: "2", id: "demo", path: "/hello" }]);
  expect(allTools().filter((t) => t.name === "demo_ping").length).toBe(1);

  rmSync(appDir, { recursive: true, force: true });
  W.reset();
  await A.settleApp("demo");
  expect((globalThis as any).demoStopped).toBe(2);
  expect(A.runningApps()).toEqual([]);
  expect(allTools().some((t) => t.name === "demo_ping")).toBe(false);
  expect(existsSync(A.appDataDir("demo"))).toBe(false);
});

test("a module that throws or exports no register() never runs", async () => {
  install("2.0.0", "export const nothing = 1;");
  await A.settleApp("demo");
  expect(A.runningApps()).toEqual([]);
  install("2.0.1", "export function register() { throw new Error('boom'); }");
  await A.settleApp("demo");
  expect(A.runningApps()).toEqual([]);
  rmSync(appDir, { recursive: true, force: true });
  W.reset();
});

// a person's vault as an app may use it: opened by the Who a route of its own was
// handed, never one it made up
test("an app's vault: the person's own logins and token, through their request alone", async () => {
  const users = await import("@phosphorus/users");
  const { marshal } = await import("@phosphorus/util");
  const admin = { user: "root", admin: true, boot: false, token: "", e: 0 };
  expect((await users.Create(admin, { name: "ann", pass: "pw-ann" })).status).toBe(200);
  const login = await users.Login({ user: "ann", pass: "pw-ann" }, ctx("/api/login", "POST"));
  const cookie = "phosphorus-user=" + /^phosphorus-user=([^;]+)/.exec(login.cookie![0]!)![1]!;
  const s = users.Of({ ...ctx("/"), req: new Request("http://127.0.0.1/", { headers: { cookie } }) })!;
  store.write(
    users.vaultFile("ann"),
    users.Seal(s.key!, marshal({ hosts: { razer: { user: "ann", pass: "x" } }, pages: {} })),
  );

  install(
    "3.0.0",
    `
export function register(ctx) {
  ctx.route("GET", "/vault", async (r) => [200, {
    ready: await ctx.vault.ready(r.who),
    hosts: await ctx.vault.hosts(r.who),
    razer: await ctx.vault.login(r.who, "razer"),
    pi: (await ctx.vault.login(r.who, "pi")) ?? null,
  }]);
  ctx.route("POST", "/token", async (r) => {
    await ctx.vault.setAnthropic(r.who, (await r.json()).token);
    return [200, { token: await ctx.vault.anthropic(r.who) }];
  });
  ctx.route("GET", "/forged", async (r) => [200, { hosts: await ctx.vault.hosts({ ...r.who }) }]);
}`,
  );
  await A.settleApp("demo");
  const as = async (path: string, method = "GET", body?: unknown) => {
    const c = ctx(path, method, body);
    const req = new Request(c.url, {
      method,
      headers: { cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = (await A.appRoute({ ...c, req }, path))!;
    return [res.status, await res.json()];
  };
  expect(await as("/api/app/demo/vault")).toEqual([
    200,
    { ready: true, hosts: ["razer"], razer: { user: "ann", pass: "x" }, pi: null },
  ]);
  expect(await as("/api/app/demo/token", "POST", { token: "sk-ant-oat01-abc" })).toEqual([
    200,
    { token: "sk-ant-oat01-abc" },
  ]);
  expect(await users.AnthropicToken(s)).toBe("sk-ant-oat01-abc");
  expect((await as("/api/app/demo/token", "POST", { token: "not a token\n" }))[0]).toBe(500);
  // a Who copied, not handed, opens nothing
  expect(await as("/api/app/demo/forged")).toEqual([500, { error: "not a person this app was handed" }]);
  rmSync(appDir, { recursive: true, force: true });
  W.reset();
  await A.settleApp("demo");
});

// the chat's own bundle, built and signed as the release builds it, checked and
// unpacked as the installer does, run; the history the core kept handed over
test("the chat app's signed bundle loads, takes over the core's chat, and is refused unsigned", async () => {
  const { generate } = await import("@phosphorus/minisign");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const key = generate();
  const out = mkdtempSync(join(tmpdir(), "phos-chat-"));
  const root = join(import.meta.dir, "..", "..", "..", "..");
  const build = Bun.spawnSync(["bun", "scripts/appbuild.ts", "chat", out, "1.0.0"], {
    cwd: root,
    env: { ...process.env, UPDATE_SIGNING_KEY: key.secret, APPS_FEED_BASE: "http://127.0.0.1:1" },
  });
  expect(build.exitCode).toBe(0);
  const data = new Uint8Array(readFileSync(join(out, "chat-1.0.0.tar.gz")));
  const rel = JSON.parse(readFileSync(join(out, "chat.json"), "utf8"));
  const chat = W.appOf("chat")!;
  process.env.APPS_PUBKEY = key.public;
  expect(() => W.verify(chat, { ...rel, signature: "" }, data)).toThrow();
  process.env.APPS_PUBKEY = generate().public;
  expect(() => W.verify(chat, rel, data)).toThrow();
  process.env.APPS_PUBKEY = key.public;
  W.verify(chat, rel, data);

  // what the core kept: this host's lines, and a channel's topic in the store
  mkdirSync(join(store.Root, "var", "chat"), { recursive: true });
  const old = { host: "testhost", seq: 7, timestamp: Date.now(), name: "ann", color: "#4f9eff", text: "from before" };
  writeFileSync(join(store.Root, "var", "chat", "own.json"), JSON.stringify([old]));
  writeFileSync(join(store.Root, "var", "chat", "merged.json"), JSON.stringify([old]));
  store.write("etc/chat/ch/ops.json", { created: 1, topic: "the ops room" });

  W.unpack(chat, { ...rel, from: "testhost", at: Date.now() }, data);
  W.reset();
  await A.settleApp("chat");
  expect(A.runningApps()).toEqual([{ id: "chat", version: "1.0.0" }]);
  expect(store.read("etc/appdata/chat/ch/ops.json")).toEqual({ created: 1, topic: "the ops room" });
  expect(store.read("etc/chat/ch/ops.json")).toBeUndefined();
  expect(existsSync(join(store.Root, "var", "chat"))).toBe(false);
  expect(JSON.parse(readFileSync(join(A.appDataDir("chat"), "own.json"), "utf8"))[0].text).toBe("from before");

  // its tools, on a key, as that user
  const tool = (n: string) => allTools().find((t) => t.name === n)!;
  const m = { caller: { user: "ann", admin: false, via: "claude" }, local: false };
  const rows = (await tool("chat_history").run({}, m)) as any[];
  expect(rows.map((r) => [r.ref, r.text])).toEqual([["testhost:7", "from before"]]);
  const sent = (await tool("send_message").run({ text: "hello from an agent" }, m)) as any;
  expect(sent.seq).toBe(8);
  const after = (await tool("chat_history").run({ limit: 1 }, m)) as any[];
  expect(after[0]).toMatchObject({ ref: "testhost:8", name: "ann", via: "claude", text: "hello from an agent" });
  await expect(tool("send_message").run({ text: "x", to: "nobody" }, m)).rejects.toMatchObject({ code: "not_found" });
  expect((await tool("chat_edit").run({ ref: "testhost:8", action: "delete" }, m)) as any).toMatchObject({ ok: true });
  expect(((await tool("chat_history").run({}, m)) as any[]).length).toBe(1);

  // the page served, its routes behind the login
  expect(W.serve(new Request("http://127.0.0.1/app/chat/"))?.status).toBe(200);
  expect((await call("/api/app/chat/upload", "POST"))![0]).toBe(401);

  rmSync(join(process.env.STATE_DIR!, "data", "apps", "chat"), { recursive: true, force: true });
  W.reset();
  await A.settleApp("chat");
  expect(allTools().some((t) => t.name === "chat_history")).toBe(false);
}, 60_000);
