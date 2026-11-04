import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

process.env.PHOSPHORUS_REPO_DIR = mkdtempSync(join(tmpdir(), "phos-sync-"));
const { HomeSync, TombstoneMs, conflictName } = await import("../src/home.ts");
const { hlc } = await import("@phosphorus/store");
type Sync = import("../src/home.ts").HomeSync;

// a host's home in a temp dir, its index beside it
function host(name: string): Sync {
  const dir = mkdtempSync(join(tmpdir(), `phos-sync-${name}-`));
  mkdirSync(join(dir, "home"));
  const s = new HomeSync({ root: join(dir, "home"), self: name, file: join(dir, "index.json"), caseless: false });
  s.load();
  return s;
}
const put = (s: Sync, rel: string, text: string, mtime?: number) => {
  const abs = join(s.root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  if (mtime) utimesSync(abs, mtime / 1000, mtime / 1000);
};
const get = (s: Sync, rel: string) => (existsSync(join(s.root, rel)) ? readFileSync(join(s.root, rel), "utf8") : null);
const ls = (s: Sync, rel = "ann") => readdirSync(join(s.root, rel)).sort();
// a peer's bytes as the server would stream them
const from = (s: Sync) => async (_h: string, rel: string) => {
  const f = Bun.file(join(s.root, rel));
  return (await f.exists()) ? { body: f.stream(), size: f.size } : undefined;
};
// both ways, twice: what a merge set aside reaches the other too
async function swap(a: Sync, b: Sync) {
  for (let i = 0; i < 2; i++) {
    await a.scan();
    await b.scan();
    await a.merge(b.self, b.stamps(), from(b));
    await b.merge(a.self, a.stamps(), from(a));
  }
  expect(a.digest()).toBe(b.digest());
}

test("a new file, an edit on top and a folder reach the other host", async () => {
  const a = host("alpha"),
    b = host("bravo");
  put(a, "ann/notes.txt", "one");
  mkdirSync(join(a.root, "ann", "empty"));
  await swap(a, b);
  expect(get(b, "ann/notes.txt")).toBe("one");
  expect(existsSync(join(b.root, "ann", "empty"))).toBe(true);
  put(b, "ann/notes.txt", "one, then two");
  await swap(a, b);
  expect(get(a, "ann/notes.txt")).toBe("one, then two");
  expect(ls(a)).toEqual(["empty", "notes.txt"]);
});

test("two edits neither saw: the newest stays, the other kept as a conflict copy on both", async () => {
  const a = host("alpha"),
    b = host("bravo");
  put(a, "ann/plan.md", "base");
  await swap(a, b);
  put(a, "ann/plan.md", "alpha's edit");
  await a.scan();
  put(b, "ann/plan.md", "bravo's later edit");
  await b.scan();
  await swap(a, b);
  const copy = conflictName("ann/plan.md", "alpha", a.get("ann/plan.md")!.t, () => false);
  for (const s of [a, b]) {
    expect(get(s, "ann/plan.md")).toBe("bravo's later edit");
    expect(ls(s)).toEqual([basename(copy), "plan.md"]);
    expect(get(s, copy)).toBe("alpha's edit");
  }
});

test("a delete reaches the other host's trash; a tombstone is kept 90 days, then pruned", async () => {
  const a = host("alpha"),
    b = host("bravo");
  put(a, "ann/old.txt", "bye");
  await swap(a, b);
  rmSync(join(a.root, "ann", "old.txt"));
  await swap(a, b);
  expect(get(b, "ann/old.txt")).toBeNull();
  expect(get(b, "ann/.trash/old.txt")).toBe("bye");
  expect(b.get("ann/old.txt")?.gone).toBe(true);
  // an edit alongside the delete is kept rather than lost
  put(a, "ann/kept.txt", "v1");
  await swap(a, b);
  put(b, "ann/kept.txt", "v1, edited");
  await b.scan();
  rmSync(join(a.root, "ann", "kept.txt"));
  await a.scan();
  await b.merge("alpha", a.stamps(), from(a));
  expect(b.get("ann/kept.txt")?.gone).toBe(true);
  expect(ls(b).some((n) => n.startsWith("kept (conflict bravo"))).toBe(true);
  // past its keep: pruned here, and a peer's stale one never taken
  b.prune(hlc.wall() + TombstoneMs + 1);
  expect(b.get("ann/old.txt")).toBeUndefined();
  const c = host("charlie");
  put(c, "ann/old.txt", "back");
  await c.scan();
  await c.merge(
    "bravo",
    { "ann/old.txt": { t: hlc.wall() - TombstoneMs - 1, h: "bravo", c: "", s: 0, gone: true } },
    from(b),
  );
  expect(get(c, "ann/old.txt")).toBe("back");
});

test("a rename moves the file on the other host, copied there, nothing fetched or trashed", async () => {
  const a = host("alpha"),
    b = host("bravo");
  put(a, "ann/draft.txt", "words");
  await swap(a, b);
  renameSync(join(a.root, "ann", "draft.txt"), join(a.root, "ann", "final.txt"));
  await a.scan();
  let fetched = 0;
  const counting = async (h: string, rel: string) => {
    fetched++;
    return from(a)(h, rel);
  };
  await b.merge("alpha", a.stamps(), counting);
  expect(fetched).toBe(0);
  expect(ls(b)).toEqual(["final.txt"]);
  expect(get(b, "ann/final.txt")).toBe("words");
  expect(a.digest()).toBe(b.digest());
});

test("the first sync merges homes kept apart: alike files once, a clash by its times", async () => {
  const a = host("alpha"),
    b = host("bravo");
  const now = Date.now();
  put(a, "ann/same.txt", "same");
  put(b, "ann/same.txt", "same");
  put(a, "ann/only-a.txt", "a");
  put(b, "bob/only-b.txt", "b");
  put(a, "ann/todo.txt", "older", now - 3600_000);
  put(b, "ann/todo.txt", "newer", now - 60_000);
  await swap(a, b);
  for (const s of [a, b]) {
    expect(get(s, "ann/only-a.txt")).toBe("a");
    expect(get(s, "bob/only-b.txt")).toBe("b");
    expect(get(s, "ann/todo.txt")).toBe("newer");
    expect(ls(s).filter((n) => n.includes("conflict"))).toEqual([
      `todo (conflict alpha ${new Date(now - 3600_000).toISOString().slice(0, 10)}).txt`,
    ]);
    expect(ls(s).filter((n) => n.startsWith("same"))).toEqual(["same.txt"]);
  }
});

test("the index survives a restart, an unchanged home no new versions", async () => {
  const a = host("alpha");
  put(a, "ann/x.txt", "x");
  await a.scan();
  const d = a.digest();
  a.stop();
  const again = new HomeSync({ root: a.root, self: "alpha", file: a.file, caseless: false });
  again.load();
  expect(await again.scan()).toEqual([]);
  expect(again.digest()).toBe(d);
});

test("upload temps and trash never sync", async () => {
  const a = host("alpha");
  put(a, "ann/.phosphorus-upload-abc", "half");
  put(a, "ann/.trash/gone.txt", "t");
  put(a, "ann/real.txt", "r");
  expect((await a.scan()).sort()).toEqual(["ann", "ann/real.txt"]);
});

test("a home that can't be read takes nothing as gone", async () => {
  const a = host("alpha");
  put(a, "ann/keep.txt", "k");
  await a.scan();
  const away = `${a.root}-away`;
  renameSync(a.root, away);
  expect(await a.scan()).toEqual([]);
  expect(a.get("ann/keep.txt")?.gone).toBeUndefined();
  renameSync(away, a.root);
});
