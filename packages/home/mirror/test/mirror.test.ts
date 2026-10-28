import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME_FS = mkdtempSync(join(tmpdir(), "phos-mirror-"));
process.env.SELF_HOST = "tshost";
const F = await import("@phosphorus/files");
const store = await import("@phosphorus/store");
const M = await import("@phosphorus/mirror");
F.init();
M.load();

const home = (rel: string) => join(F.HomeRoot, rel);
const appliedFile = join(store.Root, "var", "mirror-applied.json");
const applied = () => JSON.parse(readFileSync(appliedFile, "utf8")) as Record<string, { at: number; path: string }>;

test("ids and entry paths as Go made them", () => {
  const want = createHash("sha256").update("ann/notes.txt").digest("hex").slice(0, 24);
  expect(M.idOf("ann/notes.txt")).toBe(want);
  expect(M.idOf("ann/notes.txt")).toMatch(/^[0-9a-f]{24}$/);
  expect(M.entryRel(want)).toBe(`etc/mirror/${want}.json`);
  expect(store.validRel(M.entryRel(want))).toBe(true);
});

test("mark, unmark, touched", async () => {
  expect(M.Mark("ann/notes.txt")).toEqual([404, { error: "no such file" }]);
  await Bun.write(home("ann/notes.txt"), "hello");
  expect(M.Mark("ann/notes.txt")).toEqual([200, { ok: true, all: true }]);
  expect(M.IsMirrored("ann/notes.txt")).toBe(true);
  const id = M.idOf("ann/notes.txt");
  expect(store.read(M.entryRel(id))).toEqual({ path: "ann/notes.txt", size: 5, from: "tshost" });
  // this host's own mark counts as applied at the entry's stamp
  expect(applied()[id]).toEqual({ at: store.stamp(M.entryRel(id)), path: "ann/notes.txt" });

  // a rename follows the file
  await Bun.write(home("ann/moved.txt"), "hello");
  M.Touched("rename", "ann/notes.txt", "ann/moved.txt");
  expect(M.IsMirrored("ann/notes.txt")).toBe(false);
  expect(M.IsMirrored("ann/moved.txt")).toBe(true);
  // a write to a mirrored file that's gone unmarks it
  M.Touched("write", "ann/moved.txt", "");
  expect(M.IsMirrored("ann/moved.txt")).toBe(true);
  await Bun.file(home("ann/moved.txt")).delete();
  M.Touched("write", "ann/moved.txt", "");
  expect(M.IsMirrored("ann/moved.txt")).toBe(false);

  // a folder's delete takes every entry under it, not a sibling with the prefix
  for (const p of ["docs/a.txt", "docs/sub/b.txt", "docs2/c.txt"]) {
    await Bun.write(home(p), p);
    expect(M.Mark(p)[0]).toBe(200);
  }
  M.Touched("delete", "docs", "");
  expect(["docs/a.txt", "docs/sub/b.txt", "docs2/c.txt"].map(M.IsMirrored)).toEqual([false, false, true]);
  expect(M.Unmark("docs2/c.txt")).toEqual([200, { ok: true, all: false }]);
  expect(store.list("etc/mirror")).toEqual([]);
});

test("serve this host's copies only", async () => {
  await Bun.write(home("shared/pic.bin"), new Uint8Array([1, 2, 3, 0, 4]));
  expect(M.Mark("shared/pic.bin")[0]).toBe(200);
  const res = M.Serve(M.idOf("shared/pic.bin"));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  expect(res.headers.get("Content-Length")).toBe("5");
  expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 0, 4]));
  expect(M.Serve("nope").status).toBe(404);
  expect(M.Serve(M.idOf("shared/none.bin")).status).toBe(404);
  // a peer's file is theirs to serve
  const id = M.idOf("shared/theirs.bin");
  store.write(M.entryRel(id), { path: "shared/theirs.bin", size: 1, from: "peer" });
  expect(M.Serve(id).status).toBe(404);
  store.remove(M.entryRel(id));
  M.Unmark("shared/pic.bin");
});

test("tick pulls a peer's file and drops it once unmarked", async () => {
  const id = M.idOf("shared/from-peer.txt");
  const bad = M.idOf("shared/missing.txt");
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => (new URL(req.url).pathname === `/internal/mirror/${id}` ? new Response("peer's bytes") : new Response(null, { status: 404 })),
  });
  try {
    const port = srv.port!;
    const ipOf = (host: string) => (host === "peer" ? "127.0.0.1" : "");
    store.write(M.entryRel(id), { path: "shared/from-peer.txt", size: 12, from: "peer" });
    store.write(M.entryRel(bad), { path: "shared/missing.txt", size: 1, from: "peer" });
    store.write(M.entryRel(M.idOf("shared/unknown.txt")), { path: "shared/unknown.txt", size: 1, from: "nowhere" });
    await M.tick(ipOf, port);
    expect(readFileSync(home("shared/from-peer.txt"), "utf8")).toBe("peer's bytes");
    expect(applied()[id]).toEqual({ at: store.stamp(M.entryRel(id)), path: "shared/from-peer.txt" });
    // a failed fetch leaves no temp file and nothing applied, retried next tick
    expect(existsSync(home("shared/.phosphorus-upload-mirror-" + bad))).toBe(false);
    expect(Object.keys(applied())).toEqual([id]);
    expect(existsSync(home("shared/missing.txt"))).toBe(false);

    // an unchanged entry isn't fetched again
    await Bun.write(home("shared/from-peer.txt"), "edited here");
    await M.tick(ipOf, port);
    expect(readFileSync(home("shared/from-peer.txt"), "utf8")).toBe("edited here");

    // the entry removed, the copy goes with it
    store.remove(M.entryRel(id));
    await M.tick(ipOf, port);
    expect(existsSync(home("shared/from-peer.txt"))).toBe(false);
    expect(applied()).toEqual({});
  } finally {
    srv.stop(true);
    for (const r of store.list("etc/mirror")) store.remove("etc/mirror/" + r);
  }
});
