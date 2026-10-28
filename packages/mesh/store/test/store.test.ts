// the store on its own: versions by the hybrid clock, merging, the digest, the
// log, tombstones and the legacy shape
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-store-"));
process.env.HOME_FS = dir;
process.env.SELF_HOST = "mike";
const store = await import("@phosphorus/store");

const day = 24 * 3600 * 1000;

test("write, read, list, remove, and what reaches the disk", () => {
  store.write("etc/a/one.json", { n: 1 });
  store.write("etc/a/two.json", "two");
  expect(store.read("etc/a/one.json")).toEqual({ n: 1 });
  expect(store.list("etc/a")).toEqual(["one.json", "two.json"]);
  const st = store.stamps()["etc/a/one.json"]!;
  expect(st[1]).toBe("mike");
  expect(st[2]).toHaveLength(16);
  const onDisk = JSON.parse(readFileSync(join(store.Root, "etc/a/one.json"), "utf8"));
  expect(onDisk).toEqual({ t: st[0], h: "mike", c: st[2], data: { n: 1 } });
  store.remove("etc/a/two.json");
  expect(store.read("etc/a/two.json")).toBeUndefined();
  expect(store.list("etc/a")).toEqual(["one.json"]);
  expect(store.stamps()["etc/a/two.json"]![2]).toBe("");
  expect(() => store.write("var/x.json", 1)).toThrow();
});

test("the clock runs past every stamp seen, and a later local write wins", () => {
  const far = Date.now() + 50_000;
  expect(store.merge({ "etc/b/x.json": { t: far, h: "zulu", c: "abc", data: "theirs" } })).toBe(true);
  expect(store.read("etc/b/x.json")).toBe("theirs");
  store.write("etc/b/x.json", "mine");
  const [t, h] = store.stamps()["etc/b/x.json"]!;
  expect(t).toBeGreaterThan(far);
  expect(h).toBe("mike");
  // and so does one made with this clock set back two minutes
  store.setClockSkew(-120_000);
  store.write("etc/b/x.json", "mine again");
  expect(store.stamps()["etc/b/x.json"]![0]).toBeGreaterThan(t);
  store.setClockSkew(0);
  expect(store.read("etc/b/x.json")).toBe("mine again");
});

test("merge: newer wins, a tie by host, the same version by content; older ignored", () => {
  store.write("etc/c/t.json", 1);
  const [t, , c] = store.stamps()["etc/c/t.json"]!;
  expect(store.merge({ "etc/c/t.json": { t: t - 1, h: "zulu", c: "ffff", data: 0 } })).toBe(false);
  expect(store.merge({ "etc/c/t.json": { t, h: "alpha", c: "ffff", data: 0 } })).toBe(false);
  expect(store.merge({ "etc/c/t.json": { t, h: "zulu", c: "0000", data: 2 } })).toBe(true);
  expect(store.read("etc/c/t.json")).toBe(2);
  // the same version, other content: the higher hash, so both sides end alike
  const before = store.digest();
  expect(store.merge({ "etc/c/t.json": { t, h: "zulu", c: "0000", data: 2 } })).toBe(false);
  expect(store.merge({ "etc/c/t.json": { t, h: "zulu", c: "ffff", data: 3 } })).toBe(true);
  expect(store.read("etc/c/t.json")).toBe(3);
  expect(store.digest()).not.toBe(before);
  expect(c).toHaveLength(16);
});

test("wanted: the newer versions, the ones too far ahead counted and left", () => {
  store.write("etc/d/k.json", "here");
  const [t] = store.stamps()["etc/d/k.json"]!;
  const w = store.wanted({
    "etc/d/k.json": [t + 1, "zulu", "aa"],
    "etc/d/old.json": [t - 5, "zulu", "bb"],
    "etc/d/far.json": [Date.now() + store.AheadMs + 5000, "zulu", "cc"],
    "nope/x.json": [t + 1, "zulu", "dd"],
  });
  expect(w).toEqual({ rels: ["etc/d/k.json", "etc/d/old.json"], ahead: 1 });
  expect(store.merge({ "etc/d/far.json": { t: Date.now() + store.AheadMs + 5000, h: "zulu", c: "cc", data: 1 } })).toBe(
    false,
  );
});

test("oldest wins: the first live version stays, an older one from elsewhere replaces it", () => {
  store.oldestWins("etc/e/secret.json");
  store.write("etc/e/secret.json", "first");
  store.write("etc/e/secret.json", "second");
  expect(store.read("etc/e/secret.json")).toBe("first");
  const [t] = store.stamps()["etc/e/secret.json"]!;
  expect(store.merge({ "etc/e/secret.json": { t: t + 10, h: "zulu", c: "x", data: "newer" } })).toBe(false);
  expect(store.merge({ "etc/e/secret.json": { t: t - 10, h: "zulu", c: "x", data: "older" } })).toBe(true);
  expect(store.read("etc/e/secret.json")).toBe("older");
});

test("the legacy shape reads, stamped by nobody, and is rewritten on its next write", () => {
  expect(store.merge({ "etc/f/old.json": { at: 1700000000000, data: { v: 1 } } })).toBe(true);
  expect(store.read("etc/f/old.json")).toEqual({ v: 1 });
  expect(store.stamps()["etc/f/old.json"]!.slice(0, 2)).toEqual([1700000000000, ""]);
  store.write("etc/f/old.json", { v: 2 });
  expect(store.stamps()["etc/f/old.json"]![1]).toBe("mike");
  expect(readFileSync(join(store.Root, "etc/f/old.json"), "utf8")).toContain('"h":"mike"');
});

test("the log: a cursor per peer, what changed after it, nothing for a cursor it never had", async () => {
  const head0 = store.seq();
  store.write("etc/g/a.json", 1);
  store.write("etc/g/b.json", 2);
  store.write("etc/g/a.json", 3);
  const d = store.since(head0)!;
  expect(d.seq).toBe(head0 + 3);
  expect(Object.keys(d.files).sort()).toEqual(["etc/g/a.json", "etc/g/b.json"]);
  expect((d.files["etc/g/a.json"] as any).data).toBe(3);
  expect(store.since(store.seq())).toEqual({ seq: store.seq(), files: {} });
  expect(store.since(store.seq() + 5)).toBeUndefined();
  const seqs: number[] = [];
  store.onDelta((s) => seqs.push(s));
  store.write("etc/g/c.json", 1);
  store.write("etc/g/d.json", 1);
  await Bun.sleep(5);
  expect(seqs).toEqual([store.seq()]);
});

test("tombstones: pruned after their keep, a live file of any age not", () => {
  const old = Date.now() - 91 * day;
  store.merge({
    "etc/h/gone.json": { t: old, h: "zulu", gone: true },
    "etc/h/kept.json": { t: old, h: "zulu", c: "k", data: 1 },
  });
  expect(store.stamps()["etc/h/gone.json"]).toBeDefined();
  expect(existsSync(join(store.Root, "etc/h/gone.json"))).toBe(true);
  store.prune();
  expect(store.stamps()["etc/h/gone.json"]).toBeUndefined();
  expect(existsSync(join(store.Root, "etc/h/gone.json"))).toBe(false);
  expect(store.read("etc/h/kept.json")).toBe(1);
  store.remove("etc/h/kept.json");
  store.prune();
  expect(store.stamps()["etc/h/kept.json"]![2]).toBe("");
});

test("pull runs the syncer once at a time", async () => {
  let runs = 0;
  store.setSyncer(async () => {
    runs++;
    await Bun.sleep(20);
  });
  await Promise.all([store.pull(), store.pull()]);
  expect(runs).toBe(1);
});
