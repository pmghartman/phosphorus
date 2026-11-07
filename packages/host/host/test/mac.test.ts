import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate, parseSecretKey } from "@phosphorus/minisign";

const { knownKeys, maxLine, peerAllowed, respond, sockaddr, sockPath } = await import("../src/mac/ctl.ts");
type Deps = import("../src/mac/ctl.ts").Deps;
const { applyStep, migrationPlan } = await import("../src/mac/migrate.ts");
const { readSigned } = await import("../src/mac/update.ts");

test("the socket answers root and the recorded console user alone", () => {
  expect(peerAllowed(0, undefined)).toBe(true);
  expect(peerAllowed(0, 501)).toBe(true);
  expect(peerAllowed(501, 501)).toBe(true);
  expect(peerAllowed(502, 501)).toBe(false);
  // no one recorded yet: root only
  expect(peerAllowed(501, undefined)).toBe(false);
  expect(peerAllowed(-1, -1)).toBe(false);
});

test("sockaddr_un as Darwin lays it out", () => {
  const a = sockaddr(sockPath);
  expect(a.length).toBe(106);
  expect(a[0]).toBe(sockPath.length + 3);
  expect(a[1]).toBe(1);
  expect(a.subarray(2, 2 + sockPath.length).toString()).toBe(sockPath);
  expect(a[2 + sockPath.length]).toBe(0);
  expect(() => sockaddr("/" + "x".repeat(103))).toThrow();
  // the keys and the request around them fit one line
  expect(maxLine).toBeGreaterThan((1 << 16) + 1000);
});

// fakeDeps what each request did, recorded
function fakeDeps() {
  const did: unknown[][] = [];
  let pending: string | undefined = "upd-1";
  const d: Deps = {
    status: async () => ({ running: true, vpn: false }),
    keys: () => ({ keys: { MESH_KEY: true }, domain: "example.org" }),
    setKeys: (t) => void did.push(["setKeys", t]),
    command: async (args) => {
      did.push(["command", ...args]);
      return { code: args[0] === "stop" ? 1 : 0, output: `[${args[0]}] done\n` };
    },
    takeRequest: () => {
      const id = pending;
      pending = undefined;
      return id;
    },
    report: (...a) => void did.push(["report", ...a]),
    update: async (file, sig, id, uid) => {
      if (sig !== "good") throw new Error("the update's signature doesn't match the release key");
      did.push(["update", file, id, uid]);
    },
  };
  return { d, did };
}

test("requests from a stranger refused before they're read", async () => {
  const { d, did } = fakeDeps();
  const r = await respond(JSON.stringify({ op: "keys-set", text: "MESH_KEY=x" }), 502, 501, d);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not allowed");
  expect(did).toEqual([]);
});

test("the owner's requests handled", async () => {
  const { d, did } = fakeDeps();
  const ask = (req: unknown) => respond(typeof req === "string" ? req : JSON.stringify(req), 501, 501, d);
  expect(await ask({ op: "ping" })).toEqual({ ok: true });
  expect(await ask({ op: "status" })).toEqual({ ok: true, running: true, vpn: false });
  expect(await ask({ op: "keys" })).toEqual({ ok: true, keys: { MESH_KEY: true }, domain: "example.org" });
  expect(await ask({ op: "keys-set", text: "MESH_KEY=abc\n" })).toEqual({ ok: true });
  expect(await ask({ op: "keys-set", text: "x".repeat((1 << 16) + 1) })).toEqual({ ok: false, error: "bad request" });
  expect(await ask({ op: "start" })).toEqual({ ok: true, output: "[start] done\n" });
  expect(await ask({ op: "stop" })).toEqual({ ok: false, output: "[stop] done\n" });
  expect(await ask({ op: "rebuild" })).toEqual({ ok: true, output: "[rebuild] done\n" });
  // a pending request taken once
  expect(await ask({ op: "take-request" })).toEqual({ ok: true, id: "upd-1" });
  expect(await ask({ op: "take-request" })).toEqual({ ok: true });
  expect(await ask({ op: "report", id: "upd-1", state: "ok", current: true, version: "1.2.3" })).toEqual({
    ok: true,
  });
  expect((await ask({ op: "report", id: "upd-1", state: "done" })).ok).toBe(false);
  expect(await ask({ op: "update", file: "/tmp/a.tar.gz", signature: "good", id: "upd-2" })).toEqual({ ok: true });
  expect(await ask({ op: "update", file: "/tmp/a.tar.gz", signature: "bad", id: "upd-3" })).toEqual({
    ok: false,
    error: "the update's signature doesn't match the release key",
  });
  expect((await ask({ op: "update", file: 7, signature: "good", id: "x" })).ok).toBe(false);
  expect(await ask({ op: "rm -rf" })).toEqual({ ok: false, error: "unknown request" });
  expect(await ask("not json")).toEqual({ ok: false, error: "bad request" });
  expect(await ask("null")).toEqual({ ok: false, error: "bad request" });
  expect(did).toEqual([
    ["setKeys", "MESH_KEY=abc\n"],
    ["command", "start"],
    ["command", "stop"],
    ["command", "rebuild"],
    ["report", "upd-1", "ok", true, "1.2.3", ""],
    ["update", "/tmp/a.tar.gz", "upd-2", 501],
  ]);
});

test("the socket sets the form's keys alone, never root's env", () => {
  const text = ["MESH_KEY=phos.x", "PATH=/tmp/evil", "DYLD_INSERT_LIBRARIES=/tmp/x.dylib", "BASE_DOMAIN=example.org"];
  expect(knownKeys(text.join("\n"))).toEqual({ MESH_KEY: "phos.x" });
  expect(knownKeys("")).toEqual({});
});

test("root's request through the same handling", async () => {
  const { d } = fakeDeps();
  expect(await respond(JSON.stringify({ op: "status" }), 0, undefined, d)).toEqual({
    ok: true,
    running: true,
    vpn: false,
  });
});

test("a bundle installed only when the release key signed it", () => {
  const dir = mkdtempSync(join(tmpdir(), "phos-mac-sig-"));
  const k = generate(),
    other = generate();
  const file = join(dir, "phosphorus-macos-arm64.app.tar.gz");
  const data = Buffer.from("the app bundle");
  writeFileSync(file, data);
  const sig = parseSecretKey(k.secret, "").sign(data, "phosphorus-macos-arm64.app.tar.gz");
  const uid = process.getuid?.() ?? 0;
  expect(readSigned(file, sig, uid, k.public).equals(data)).toBe(true);
  expect(() => readSigned(file, parseSecretKey(other.secret, "").sign(data, "x"), uid, k.public)).toThrow(/signature/);
  writeFileSync(file, "the app bundle, changed");
  expect(() => readSigned(file, sig, uid, k.public)).toThrow(/signature/);
  // no release key in a dev build: nothing installed
  expect(() => readSigned(file, sig, uid, "")).toThrow(/release key/);
  expect(() => readSigned("relative.tar.gz", sig, uid, k.public)).toThrow(/full path/);
  expect(() => readSigned(dir, sig, uid, k.public)).toThrow(/plain file/);
  expect(() => readSigned(join(dir, "gone"), sig, uid, k.public)).toThrow(/can't read/);
});

test.skipIf(process.platform === "win32")("another user's file refused even when signed", () => {
  const dir = mkdtempSync(join(tmpdir(), "phos-mac-own-"));
  const k = generate();
  const file = join(dir, "a.tar.gz");
  writeFileSync(file, "x");
  const sig = parseSecretKey(k.secret, "").sign(Buffer.from("x"), "a.tar.gz");
  const me = process.getuid!();
  expect(() => readSigned(file, sig, me + 1, k.public)).toThrow(/asking user/);
});

// a user's account as the user agent left it
function oldAccount() {
  const root = mkdtempSync(join(tmpdir(), "phos-mac-mig-"));
  const user = join(root, "Users", "pat");
  const agent = join(user, "Library", "LaunchAgents", "dev.phosphorus.host.plist");
  const old = join(user, "Library", "Phosphorus");
  mkdirSync(join(old, "state", "log"), { recursive: true });
  mkdirSync(join(old, "bin"), { recursive: true });
  mkdirSync(join(user, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(old, ".env"), "MESH_KEY=k\n");
  writeFileSync(join(old, ".phosphorus-installed"), "1.0.0\n");
  writeFileSync(join(old, "state", "log", "phosphorus.log"), "log\n");
  writeFileSync(agent, "<plist/>");
  return { root, user, agent, old, to: join(root, "Library", "Phosphorus") };
}

async function apply(steps: ReturnType<typeof migrationPlan>) {
  const booted: string[] = [];
  for (const s of steps)
    await applyStep(s, async (...a) => {
      booted.push(a.join(" "));
      return true;
    });
  return booted;
}

test("migration: the agent booted out, the home moved, then nothing left to do", async () => {
  const a = oldAccount();
  const plan = migrationPlan(501, a.user, a.to);
  expect(plan).toEqual([
    { do: "bootout", target: "gui/501/dev.phosphorus.host" },
    { do: "remove", path: a.agent },
    { do: "move", from: a.old, to: a.to },
  ]);
  expect(await apply(plan)).toEqual(["bootout gui/501/dev.phosphorus.host"]);
  expect(existsSync(a.agent)).toBe(false);
  expect(existsSync(a.old)).toBe(false);
  expect(readFileSync(join(a.to, ".env"), "utf8")).toBe("MESH_KEY=k\n");
  expect(readFileSync(join(a.to, "state", "log", "phosphorus.log"), "utf8")).toBe("log\n");
  // run again: safe, nothing to do
  expect(migrationPlan(501, a.user, a.to)).toEqual([]);
});

test("migration: a bare root home takes the old one's files, nothing overwritten", async () => {
  const a = oldAccount();
  mkdirSync(join(a.to, "state", "run"), { recursive: true });
  writeFileSync(join(a.to, "state", "run", "holding"), "");
  rmSync(a.agent);
  const plan = migrationPlan(501, a.user, a.to);
  expect(plan).toEqual([{ do: "merge", from: a.old, to: a.to }]);
  await apply(plan);
  expect(readFileSync(join(a.to, ".env"), "utf8")).toBe("MESH_KEY=k\n");
  expect(existsSync(join(a.to, "bin"))).toBe(true);
  expect(existsSync(join(a.to, "state", "run", "holding"))).toBe(true);
  // the old state/ clashed: kept aside, never lost
  expect(existsSync(a.old)).toBe(false);
  const aside = readdirSync(join(a.user, "Library")).filter((n) => n.startsWith("Phosphorus.old-"));
  expect(aside.length).toBe(1);
  expect(readFileSync(join(a.user, "Library", aside[0]!, "state", "log", "phosphorus.log"), "utf8")).toBe("log\n");
  expect(migrationPlan(501, a.user, a.to)).toEqual([]);
});

test("migration: a root home in use never overwritten, the old one kept aside", async () => {
  const a = oldAccount();
  mkdirSync(a.to, { recursive: true });
  writeFileSync(join(a.to, ".env"), "MESH_KEY=root\n");
  const plan = migrationPlan(501, a.user, a.to, Date.UTC(2026, 10, 6));
  expect(plan.at(-1)).toEqual({
    do: "aside",
    from: a.old,
    to: `${a.old}.old-2026-11-06-${Date.UTC(2026, 10, 6) % 100000}`,
  });
  await apply(plan);
  expect(readFileSync(join(a.to, ".env"), "utf8")).toBe("MESH_KEY=root\n");
  expect(existsSync(a.old)).toBe(false);
  expect(readFileSync(join(`${a.old}.old-2026-11-06-${Date.UTC(2026, 10, 6) % 100000}`, ".env"), "utf8")).toBe(
    "MESH_KEY=k\n",
  );
  expect(migrationPlan(501, a.user, a.to)).toEqual([]);
});

test("migration: an empty root home dir replaced by the moved one", async () => {
  const a = oldAccount();
  mkdirSync(a.to, { recursive: true });
  const plan = migrationPlan(501, a.user, a.to);
  expect(plan.at(-1)).toEqual({ do: "move", from: a.old, to: a.to });
  await apply(plan);
  expect(readFileSync(join(a.to, ".phosphorus-installed"), "utf8")).toBe("1.0.0\n");
});
