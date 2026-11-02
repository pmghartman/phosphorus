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

const sulfur = W.appOf("sulfur")!;
W.Catalog.push({ ...sulfur, id: "demo", name: "Demo", mount: "/app/demo/", agents: [], server: true, key: "x" });

const appDir = join(process.env.STATE_DIR!, "apps", "demo");

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
