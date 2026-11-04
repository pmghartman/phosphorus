// chunks cut by content, a file rebuilt from what a host holds, and the sender's side of the ask
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Chunk,
  Chunks,
  chunkFile,
  chunkMax,
  chunkMin,
  rebuild,
  serveChunks,
  splitChunks,
} from "@phosphorus/delta";

// the same pseudo-random bytes every run
function bytes(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    b[i] = s >>> 24;
  }
  return b;
}

const tmp = () => mkdtempSync(join(tmpdir(), "phos-delta-"));

async function cut(b: Uint8Array): Promise<Chunk[]> {
  const f = join(tmp(), "f");
  writeFileSync(f, b);
  return chunkFile(f);
}

test("cut where the bytes say: an edit moves the chunks around it, an insert finds the rest again", async () => {
  const b = bytes(1 << 20);
  const a = await cut(b);
  expect(a.reduce((n, [, l]) => n + l, 0)).toBe(b.length);
  for (const [, n] of a.slice(0, -1)) {
    expect(n).toBeGreaterThanOrEqual(chunkMin);
    expect(n).toBeLessThanOrEqual(chunkMax);
  }
  expect(await cut(b)).toEqual(a);
  const names = new Set(a.map(([h]) => h));
  const edited = b.slice();
  edited.fill(7, 500_000, 500_100);
  expect((await cut(edited)).filter(([h]) => !names.has(h)).length).toBeLessThanOrEqual(2);
  const inserted = new Uint8Array(b.length + 10);
  inserted.set(b.subarray(0, 300_000));
  inserted.set(b.subarray(300_000), 300_010);
  expect((await cut(inserted)).filter(([h]) => !names.has(h)).length).toBeLessThanOrEqual(3);
  expect(await cut(new Uint8Array(0))).toEqual([]);
});

test("a file rebuilt from a folder's chunks fetches only the edit, the sender's answer split back", async () => {
  const dir = tmp();
  const old = bytes(2 << 20, 2);
  writeFileSync(join(dir, "db"), old);
  const here = new Chunks(dir, join(dir, "..", `${Math.random()}.json`));
  await here.list("db");
  // the sender's folder: the file with one page written
  const theirs = tmp();
  const next = old.slice();
  next.set(bytes(4096, 9), 1_000_000);
  writeFileSync(join(theirs, "db"), next);
  const sender = new Chunks(theirs, join(theirs, "..", `${Math.random()}.json`));
  const list = (await sender.list("db"))!.c;
  let moved = 0;
  const out = join(dir, "db.next");
  const ok = await rebuild(
    out,
    list,
    [here],
    async (want) => {
      const all = await serveChunks(sender, want);
      return all && splitChunks(all, want);
    },
    (n) => (moved += n),
  );
  expect(ok).toBe(true);
  expect(readFileSync(out)).toEqual(Buffer.from(next));
  expect(moved).toBeGreaterThan(0);
  expect(moved).toBeLessThanOrEqual(2 * chunkMax);
});

test("a chunk whose bytes don't match its name is refused; an ask the sender can't fill is none", async () => {
  const dir = tmp();
  writeFileSync(join(dir, "f"), bytes(100_000, 5));
  const tree = new Chunks(dir, join(dir, "..", `${Math.random()}.json`));
  const list = (await tree.list("f"))!.c;
  const out = join(tmp(), "f");
  expect(await rebuild(out, list, [], async (want) => want.map(([, n]) => new Uint8Array(n)))).toBe(false);
  expect(await serveChunks(tree, [["0".repeat(32), 10]])).toBeUndefined();
  expect(await serveChunks(tree, "nonsense")).toBeUndefined();
  expect(splitChunks(new Uint8Array(5), [["a", 3]])).toBeUndefined();
});
