// three real hosts on loopback: links, the store converging over them, clock
// skew, tombstones, a dropped link and a host leaving
import { afterAll, beforeAll, test as bunTest, expect } from "bun:test";
import { Mesh, unavailable } from "./mesh-harness.ts";

const names = ["alpha", "bravo", "charlie"];
// a Mac's lo0 has 127.0.0.1 alone until given aliases: the mesh skipped, and why
const why = unavailable(names.length);
if (why) console.log(`[mesh test] skipped, ${why}`);
const test = bunTest.skipIf(!!why);

const m = (why ? undefined : new Mesh(names)) as Mesh;
beforeAll(async () => {
  await m?.start();
}, 60_000);
afterAll(() => m?.stop());

const linked = async (name: string, ...peers: string[]) => {
  const v = await m.view(name);
  return peers.every((p) => v.links[p] === true);
};

test("every pair links, and the devices read as phosphorus hosts", async () => {
  await m.until(() => linked("alpha", "bravo", "charlie"), "alpha's links");
  await m.until(() => linked("bravo", "alpha", "charlie"), "bravo's links");
  await m.until(() => linked("charlie", "alpha", "bravo"), "charlie's links");
  const v = await m.view("alpha");
  expect(v.tailnet.map((d: any) => [d.name, d.phosphorus, d.phosphorusSeen])).toEqual([
    ["alpha", true, true],
    ["bravo", true, true],
    ["charlie", true, true],
  ]);
  expect(v.peerIPs).toEqual({ bravo: "127.0.0.3", charlie: "127.0.0.4" });
  expect(v.peerGit.map((g: any) => g.host)).toEqual(["bravo", "charlie"]);
  expect(v.lock).toBeNull();
}, 20_000);

test("a write on one host is on every other within the moment, digests equal", async () => {
  await m.call("alpha", "store.write", { rel: "etc/test/one.json", data: { from: "alpha" } });
  const t0 = Date.now();
  await m.until(
    async () => (await m.call("charlie", "store.read", { rel: "etc/test/one.json" })).data?.from === "alpha",
    "charlie's copy",
  );
  expect(Date.now() - t0).toBeLessThan(1500);
  await m.until(
    async () => (await m.call("bravo", "store.read", { rel: "etc/test/one.json" })).data?.from === "alpha",
    "bravo's copy",
  );
  const digests = await Promise.all(["alpha", "bravo", "charlie"].map((n) => m.call(n, "store.digest")));
  expect(new Set(digests.map((d) => d.digest)).size).toBe(1);
}, 20_000);

test("a slow clock still wins its later write; a fast one's files wait until it's set right", async () => {
  await m.call("alpha", "clock.skew", { ms: -120_000 });
  await m.call("alpha", "store.write", { rel: "etc/test/one.json", data: { from: "alpha-slow" } });
  await m.until(
    async () => (await m.call("bravo", "store.read", { rel: "etc/test/one.json" })).data?.from === "alpha-slow",
    "bravo takes the slow clock's write",
  );
  await m.call("alpha", "clock.skew", { ms: 0 });
  // charlie two minutes ahead: its write is skipped by the others, taken once its clock is back
  await m.call("charlie", "clock.skew", { ms: 120_000 });
  await m.call("charlie", "store.write", { rel: "etc/test/fast.json", data: 1 });
  await Bun.sleep(1500);
  expect((await m.call("alpha", "store.read", { rel: "etc/test/fast.json" })).data).toBeNull();
  expect(m.logs("alpha")).toContain("stamped over a minute ahead");
  // set right, its next file is taken at once; the one stamped ahead waits for the others' clocks
  await m.call("charlie", "clock.skew", { ms: 0 });
  await m.call("charlie", "store.write", { rel: "etc/test/fast2.json", data: 2 });
  await m.until(
    async () => (await m.call("alpha", "store.read", { rel: "etc/test/fast2.json" })).data === 2,
    "charlie's next write once its clock is right",
  );
  expect((await m.call("alpha", "store.read", { rel: "etc/test/fast.json" })).data).toBeNull();
}, 30_000);

test("a tombstone replicates, and an aged one is pruned everywhere", async () => {
  await m.call("bravo", "store.write", { rel: "etc/test/doomed.json", data: 1 });
  await m.until(
    async () => (await m.call("alpha", "store.read", { rel: "etc/test/doomed.json" })).data === 1,
    "the file on alpha",
  );
  await m.call("bravo", "store.remove", { rel: "etc/test/doomed.json" });
  await m.until(
    async () => (await m.call("alpha", "store.read", { rel: "etc/test/doomed.json" })).data === null,
    "the tombstone on alpha",
  );
  expect((await m.call("alpha", "store.stamps"))["etc/test/doomed.json"][2]).toBe("");
  const old = Date.now() - 100 * 24 * 3600 * 1000;
  await m.call("alpha", "store.merge", { files: { "etc/test/ancient.json": { t: old, h: "nobody", gone: true } } });
  await m.call("alpha", "store.prune");
  expect((await m.call("alpha", "store.stamps"))["etc/test/ancient.json"]).toBeUndefined();
}, 20_000);

test("a dropped link comes back, and the writes made meanwhile arrive", async () => {
  await m.call("alpha", "link.drop", { host: "bravo" });
  await m.until(async () => (await m.view("alpha")).links.bravo === false, "alpha sees bravo down", 7000);
  await m.call("bravo", "store.write", { rel: "etc/test/meanwhile.json", data: "b" });
  await m.until(() => linked("alpha", "bravo"), "the link back", 10_000);
  await m.until(
    async () => (await m.call("alpha", "store.read", { rel: "etc/test/meanwhile.json" })).data === "b",
    "bravo's write on alpha",
  );
  const v = await m.view("alpha");
  expect(v.tailnet.find((d: any) => d.name === "bravo").phosphorus).toBe(true);
}, 30_000);

test("chat lines cross the links, and a host away gets what it missed on its hello", async () => {
  await m.call("alpha", "chat.post", { name: "ann", text: "hello mesh" });
  await m.until(
    async () => (await m.call("charlie", "chat.lines")).some((l: any) => l.host === "alpha" && l.text === "hello mesh"),
    "alpha's line on charlie",
  );
  await m.call("charlie", "link.drop", { host: "alpha" });
  await m.until(async () => (await m.view("charlie")).links.alpha === false, "charlie sees alpha down", 7000);
  await m.call("alpha", "chat.post", { name: "ann", text: "while away" });
  await m.until(() => linked("charlie", "alpha"), "the link back", 10_000);
  await m.until(
    async () => (await m.call("charlie", "chat.lines")).some((l: any) => l.text === "while away"),
    "the missed line on charlie",
  );
}, 30_000);

test("a home file marked for every host is on every other within the moment, follows its changes, and goes when unmarked", async () => {
  await m.call("alpha", "home.write", { rel: "shared/note.txt", text: "from alpha" });
  expect((await m.call("alpha", "mirror.mark", { rel: "shared/note.txt" })).res[0]).toBe(200);
  const t0 = Date.now();
  await m.until(
    async () => (await m.call("charlie", "home.read", { rel: "shared/note.txt" })).text === "from alpha",
    "charlie's copy",
  );
  expect(Date.now() - t0).toBeLessThan(1500);
  await m.until(
    async () => (await m.call("bravo", "home.read", { rel: "shared/note.txt" })).text === "from alpha",
    "bravo's copy",
  );
  // the file changed and marked again: the new bytes everywhere
  await m.call("alpha", "home.write", { rel: "shared/note.txt", text: "from alpha, again" });
  await m.call("alpha", "mirror.mark", { rel: "shared/note.txt" });
  await m.until(
    async () => (await m.call("bravo", "home.read", { rel: "shared/note.txt" })).text === "from alpha, again",
    "bravo's new copy",
  );
  // a copy's host away while it's marked: fetched once its link is back
  await m.call("charlie", "link.drop", { host: "alpha" });
  await m.until(async () => (await m.view("charlie")).links.alpha === false, "charlie sees alpha down", 7000);
  await m.call("alpha", "home.write", { rel: "shared/late.txt", text: "late" });
  await m.call("alpha", "mirror.mark", { rel: "shared/late.txt" });
  await m.until(() => linked("charlie", "alpha"), "the link back", 10_000);
  await m.until(
    async () => (await m.call("charlie", "home.read", { rel: "shared/late.txt" })).text === "late",
    "the late copy on charlie",
  );
  // unmarked: the copies go, the original stays
  await m.call("alpha", "mirror.mark", { rel: "shared/note.txt", on: false });
  await m.until(
    async () => (await m.call("charlie", "home.read", { rel: "shared/note.txt" })).text === null,
    "charlie's copy gone",
  );
  expect((await m.call("alpha", "home.read", { rel: "shared/note.txt" })).text).toBe("from alpha, again");
}, 40_000);

test("tailscale's offline flag alone keeps a link; a host removed is let go", async () => {
  m.setOnline("charlie", false);
  await m.until(async () => "charlie" in (await m.view("alpha")).offline, "alpha reads charlie offline", 10_000);
  await Bun.sleep(1500);
  expect((await m.view("alpha")).links.charlie).toBe(true);
  m.setOnline("charlie", true);
  m.remove("charlie");
  await m.until(
    async () => !(await m.view("alpha")).tailnet.some((d: any) => d.name === "charlie"),
    "charlie gone from alpha",
    15_000,
  );
  expect((await m.view("alpha")).links.charlie).toBeUndefined();
  expect(m.logs("alpha")).toContain("charlie left the tailnet");
}, 30_000);
