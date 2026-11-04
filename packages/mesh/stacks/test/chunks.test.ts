// a standby's copy by chunks: what crosses the network is only what it lacks
// the env (./env.ts) before anything reads it, this file running first in the package
import "./env.ts";
import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Chunk, Chunks, chunkMax } from "@phosphorus/delta";
import { type Manifest, pullInto, type Remote, walk } from "../src/ha/copy.ts";

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

const tmp = () => mkdtempSync(join(tmpdir(), "phos-chunks-"));

// an active's snapshot as a standby reaches it, every chunk fetched counted
function active(root: string) {
  const served = new Chunks(root, join(root, "..", `${Math.random()}.json`));
  const seen = { fetched: 0, lists: 0 };
  const remote: Remote = {
    lists: async (paths) => {
      seen.lists += paths.length;
      const out: Record<string, { v: string; c: Chunk[] }> = {};
      for (const p of paths) {
        const l = await served.list(p);
        if (l) out[p] = l;
      }
      return out;
    },
    blocks: async (want) => {
      const got = await served.read(want.map(([h]) => h));
      const out = want.map(([h]) => got.get(h));
      if (out.some((b) => !b)) return;
      for (const b of out) seen.fetched += b!.length;
      return out as Uint8Array[];
    },
  };
  const man = (): Manifest => ({ token: String(Math.random()), gen: 1, stamp: 1, app: 1, files: walk(root) });
  return { remote, seen, man };
}

function trees() {
  const root = tmp();
  const src = join(root, "src");
  const dst = join(root, "dst");
  mkdirSync(src, { recursive: true });
  return { root, src, dst, pulled: new Chunks(dst, join(root, "pull-chunks.json")) };
}

test("a first pull fetches each chunk once; an unchanged snapshot fetches and lists nothing", async () => {
  const { src, dst, pulled } = trees();
  const db = bytes(1 << 20, 2);
  writeFileSync(join(src, "db"), db);
  // the same bytes twice: fetched once
  writeFileSync(join(src, "db.copy"), db);
  writeFileSync(join(src, "small"), "hi");
  const a = active(src);
  const index: Record<string, string> = {};
  expect(await pullInto(pulled, a.man(), index, a.remote)).toBe(true);
  expect(readFileSync(join(dst, "db"))).toEqual(Buffer.from(db));
  expect(readFileSync(join(dst, "db.copy"))).toEqual(Buffer.from(db));
  expect(a.seen.fetched).toBe(db.length + 2);
  a.seen.fetched = a.seen.lists = 0;
  expect(await pullInto(pulled, a.man(), index, a.remote)).toBe(true);
  expect(a.seen).toEqual({ fetched: 0, lists: 0 });
});

test("an edited database fetches only its changed chunks, a backup rewritten from it none", async () => {
  const { src, dst, pulled } = trees();
  const db = bytes(2 << 20, 3);
  writeFileSync(join(src, "db"), db);
  const a = active(src);
  const index: Record<string, string> = {};
  expect(await pullInto(pulled, a.man(), index, a.remote)).toBe(true);
  a.seen.fetched = 0;
  // one 4KB page written, then the backup the hook makes of the whole database
  const next = db.slice();
  next.set(bytes(4096, 9), 1_000_000);
  writeFileSync(join(src, "db"), next);
  copyFileSync(join(src, "db"), join(src, "db.backup"));
  expect(await pullInto(pulled, a.man(), index, a.remote)).toBe(true);
  expect(readFileSync(join(dst, "db"))).toEqual(Buffer.from(next));
  expect(readFileSync(join(dst, "db.backup"))).toEqual(Buffer.from(next));
  expect(a.seen.fetched).toBeGreaterThan(0);
  expect(a.seen.fetched).toBeLessThanOrEqual(2 * chunkMax);
});

test("a former active's own snapshot gives its chunks, nothing fetched", async () => {
  const { root, src, pulled } = trees();
  const db = bytes(1 << 20, 4);
  writeFileSync(join(src, "db"), db);
  const seedDir = join(root, "seed");
  mkdirSync(seedDir);
  writeFileSync(join(seedDir, "old-name"), db);
  const seed = new Chunks(seedDir, join(root, "seed-chunks.json"));
  await seed.list("old-name");
  const a = active(src);
  expect(await pullInto(pulled, a.man(), {}, a.remote, { seed })).toBe(true);
  expect(a.seen.fetched).toBe(0);
});

test("a chunk whose bytes don't match its name is refused, the file left as it was", async () => {
  const { src, dst, pulled } = trees();
  writeFileSync(join(src, "db"), bytes(100_000, 5));
  const a = active(src);
  const lying: Remote = {
    lists: a.remote.lists,
    blocks: async (want) => want.map(([, n]) => new Uint8Array(n)),
  };
  expect(await pullInto(pulled, a.man(), {}, lying)).toBe(false);
  expect(walk(dst).filter((e) => e.t === "f")).toEqual([]);
});
