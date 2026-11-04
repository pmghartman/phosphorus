// host desktop's routes: a user's alone, an admin's switch, a host refused until
// enabled, the saved login asked for before anything opens
import "./env.ts";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ctx } from "@phosphorus/wsock";

const users = await import("@phosphorus/users");
const store = await import("@phosphorus/store");
const { marshal } = await import("@phosphorus/util");
const { hostdeskRoute } = await import("../src/hostdesk.ts");

const ctx = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Ctx => {
  const url = new URL(`http://127.0.0.1${path}`);
  const req = new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { req, url, ip: "127.0.0.1", ingress: false, server: undefined as never };
};

async function call(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const c = ctx(path, method, body, headers);
  const res = await hostdeskRoute(c, c.url.pathname, method, c.url.searchParams);
  return res ? [res.status, await res.json().catch(() => null)] : undefined;
}

async function signIn(name: string, admin: boolean): Promise<string> {
  const root = { user: "root", admin: true, boot: false, token: "", e: 0 };
  expect((await users.Create(root, { name, pass: `pw-${name}`, admin })).status).toBe(200);
  const login = await users.Login({ user: name, pass: `pw-${name}` }, ctx("/api/login", "POST"));
  return `phosphorus-user=${/^phosphorus-user=([^;]+)/.exec(login.cookie![0]!)![1]!}`;
}

test("host desktop: users only, enabled by an admin, the saved login first", async () => {
  expect(await call("/api/hostdesk")).toEqual([401, { error: "log in as a user" }]);
  const dina = await signIn("dina", false);
  const deskadmin = await signIn("deskadmin", true);
  expect(await call("/api/hostdesk", "GET", undefined, { cookie: dina })).toEqual([200, { hosts: {} }]);
  // not an admin, not a host on the tailnet, another site's page
  const no = await call("/api/hostdesk/enable", "POST", { host: "testhost", on: true }, { cookie: dina });
  expect(no![0]).toBe(403);
  expect((await call("/api/hostdesk/enable", "POST", { host: "nowhere", on: true }, { cookie: deskadmin }))![0]).toBe(
    404,
  );
  const cross = { cookie: deskadmin, origin: "https://elsewhere.test" };
  expect((await call("/api/hostdesk/enable", "POST", { host: "testhost", on: true }, cross))![0]).toBe(403);
  // a host on the tailnet but not enabled refuses to open
  const shut = await call("/api/hostdesk/testhost/desktop", "GET", undefined, { cookie: dina });
  expect(shut![0]).toBe(403);
  expect(shut![1].enable).toBe(true);
  expect((await call("/api/hostdesk/nowhere/desktop", "GET", undefined, { cookie: dina }))![0]).toBe(404);
  // enabled by the admin, for everyone
  expect(await call("/api/hostdesk/enable", "POST", { host: "testhost", on: true }, { cookie: deskadmin })).toEqual([
    200,
    { host: "testhost", on: true },
  ]);
  // the switch in the audit log, as the desktop's
  const { LogDir } = await import("@phosphorus/util");
  const rows = readFileSync(join(LogDir, "mcp-audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(rows.at(-1)).toMatchObject({
    user: "deskadmin",
    via: "desktop",
    tool: "host_desktop_enable",
    args: { host: "testhost", on: true },
    ok: true,
  });
  const list = await call("/api/hostdesk", "GET", undefined, { cookie: dina });
  expect(Object.keys(list![1].hosts)).toEqual(["testhost"]);
  // still nothing opened without dina's own saved login
  const nologin = await call("/api/hostdesk/testhost/desktop?cached=1", "GET", undefined, { cookie: dina });
  expect(nologin![0]).toBe(403);
  expect(nologin![1].error).toContain("save a login");
  // with it, the cache answers at once: nothing kept yet
  const s = users.Of({ ...ctx("/"), req: new Request("http://127.0.0.1/", { headers: { cookie: dina } }) })!;
  store.write(
    users.vaultFile("dina"),
    users.Seal(s.key!, marshal({ hosts: { testhost: { user: "dina", pass: "x" } }, pages: {} })),
  );
  expect(await call("/api/hostdesk/testhost/desktop?cached=1", "GET", undefined, { cookie: dina })).toEqual([
    200,
    { cached: false },
  ]);
  // switched off again
  expect(
    (await call("/api/hostdesk/enable", "POST", { host: "testhost", on: false }, { cookie: deskadmin }))![1].on,
  ).toBe(false);
  expect((await call("/api/hostdesk/testhost/desktop?cached=1", "GET", undefined, { cookie: dina }))![0]).toBe(403);
  // gone again, the smoke test after still a fresh mesh's setup
  const root = { user: "root", admin: true, boot: false, token: "", e: 0 };
  for (const name of ["dina", "deskadmin"]) expect(users.Remove(root, { name }).status).toBe(200);
});
