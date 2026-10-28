import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Share } from "@phosphorus/files";
import type { Session } from "../src/collab.ts";

process.env.HOME_FS = mkdtempSync(join(tmpdir(), "phos-collab-home-"));
const { Client, keyOf, mu, newSession, sessions } = await import("../src/collab.ts");
const { diskDiff, diskStat, observeDisk, readDisk, resolveDisk } = await import("../src/disk.ts");
const { Apply, Parse } = await import("../src/ot.ts");

// Run with bun test packages/collab; these tests do not need a UI or watcher.
// The lock held for the test as Go's did, timers waiting their turn.
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0)) f();
});

async function diskFixture(text: string): Promise<[Session, string]> {
  const dir = mkdtempSync(join(tmpdir(), "phos-collab-"));
  const real = realpathSync.native(dir);
  const path = join(dir, "App.cs");
  writeDiskFixture(path, text);
  const share: Share = { id: dir, label: dir, perms: "rw", root: dir, real, ok: true };
  const release = await mu.lock();
  const s = newSession(keyOf(share, "App.cs"), share, "App.cs", text, 0);
  s.diskInfo = diskStat(share, "App.cs");
  cleanups.push(() => {
    clearTimeout(s.autosave);
    sessions.delete(s.key);
    release();
    rmSync(dir, { recursive: true, force: true });
  });
  return [s, path];
}

function writeDiskFixture(path: string, text: string) {
  writeFileSync(path, text, { mode: 0o600 });
  const quiet = new Date(Date.now() - 1000);
  utimesSync(path, quiet, quiet);
}

const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

test("disk reload uses OT and retains CRLF", async () => {
  const [s, path] = await diskFixture("class C\r\n{\r\n}\r\n");
  const before = s.text;
  const c = new Client({ pos: s.text.length });
  s.order.push(c);
  writeDiskFixture(path, "class Cat\r\n{\r\n    Run();\r\n}\r\n");
  observeDisk(s, await readDisk(s.share, s.rel));
  expect([s.diskConflict, s.version, s.saved, s.eol]).toEqual([false, 1, 1, "\r\n"]);
  const got = Apply(before, s.history[0]!);
  expect(got).toBe(s.text);
  expect(c.pos).toBe(s.text.length);
  expect(read(path)).toBe(s.onDisk());
});

test("disk conflict blocks save and rejects stale review", async () => {
  const [s, path] = await diskFixture("old");
  s.text = "editor draft";
  s.version = 1;
  writeDiskFixture(path, "disk version");
  const [status] = await s.saveNow("");
  expect([status, s.diskConflict]).toEqual([409, true]);
  const revision = s.diskRevision;
  writeDiskFixture(path, "newer disk version");
  await resolveDisk(s, new Client(), { choice: "keep", revision });
  expect([read(path), s.text, s.diskConflict]).toEqual(["newer disk version", "editor draft", true]);
  await resolveDisk(s, new Client(), { choice: "reload", revision: s.diskRevision });
  expect([s.text, s.saved === s.version, s.diskConflict]).toEqual(["newer disk version", true, false]);
});

test("disk keep can recreate a deleted file and honors read-only", async () => {
  const [s, path] = await diskFixture("editor version");
  unlinkSync(path);
  observeDisk(s, await readDisk(s.share, s.rel));
  expect(s.diskConflict && s.diskProblem !== "").toBe(true);
  s.share.perms = "r";
  await resolveDisk(s, new Client(), { choice: "keep", revision: s.diskRevision });
  expect(existsSync(path)).toBe(false);
  s.share.perms = "rw";
  await resolveDisk(s, new Client(), { choice: "keep", revision: s.diskRevision });
  expect([read(path), s.diskConflict]).toEqual(["editor version", false]);
});

test("disk incomplete snapshot and matching draft", async () => {
  const [s, path] = await diskFixture("old");
  s.text = "draft";
  s.version = 1;
  observeDisk(s, { valid: false, text: "", problem: "" });
  expect([s.text, s.diskConflict]).toEqual(["draft", false]);
  writeDiskFixture(path, "draft");
  observeDisk(s, await readDisk(s.share, s.rel));
  expect([s.saved === s.version, s.diskText, s.diskConflict]).toEqual([true, "draft", false]);
});

test("disk diff survives JSON for unicode", () => {
  for (const [from, to] of [
    ["😀x", "😁x"],
    ["x😀", "x😈"],
    ["😀", "🌀"],
    ["a\n", ""],
    ["", "café 😀"],
  ] as const) {
    const data = JSON.stringify(diskDiff(from, to));
    const decoded = Parse(JSON.parse(data));
    expect(decoded).toBeDefined();
    expect(Apply(from, decoded!)).toBe(to);
  }
});

test("eol change writes the file with its new line ending", async () => {
  const [s, path] = await diskFixture("a\nb\n");
  expect((await s.saveNow(""))[0]).toBe(200);
  await s.onMessage(new Client(), { type: "eol", eol: "\r\n" });
  expect([read(path), s.eol, s.eolPending, s.saved === s.version]).toEqual(["a\r\nb\r\n", "\r\n", false, true]);
  // the session's text should stay LF
  expect(s.text).toBe("a\nb\n");
  // a file written this second reads as still changing: aged, as a later save would find it
  const quiet = new Date(Date.now() - 1000);
  utimesSync(path, quiet, quiet);
  await s.onMessage(new Client(), { type: "eol", eol: "\n" });
  expect(read(path)).toBe("a\nb\n");
});

test("eol change refused on a read-only share", async () => {
  const [s, path] = await diskFixture("a\nb\n");
  s.share.perms = "r";
  await s.onMessage(new Client(), { type: "eol", eol: "\r\n" });
  expect([read(path), s.eol]).toEqual(["a\nb\n", "\n"]);
});
