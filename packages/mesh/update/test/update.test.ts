// a fresh state dir, quick polling, this host named a; the agent and peers
// scripted through files and the seams
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Chain, Result } from "@phosphorus/update";

const dir = mkdtempSync(join(tmpdir(), "phos-update-"));
process.env.STATE_DIR = dir;
process.env.VERSION_FILE = join(dir, "VERSION");
process.env.SELF_HOST = "a";
const u = await import("@phosphorus/update");
const { writeJSONAtomic } = await import("@phosphorus/util");
const { seams, testing } = u;

const agentFile = join(dir, "update-agent.json");
const chainFile = join(dir, "update-chain.json");
const http = { askPeer: seams.askPeer, peerState: seams.peerState, peerSelf: seams.peerSelf };

function setup() {
  for (const f of ["update-request.json", "update-agent.json", "update-chain.json"]) rmSync(join(dir, f), { force: true });
  writeFileSync(join(dir, "VERSION"), "1.0\n");
  testing.reset();
  Object.assign(seams, http, { pause: () => Bun.sleep(1), peerAddr: async (h: string) => h });
  testing.startGraceMS = 200;
}

const agent = (id: string, state: string, version = "", error = "", current = false) => writeJSONAtomic(agentFile, { id, state, version, error, current });

async function within(what: string, ok: () => boolean) {
  for (const end = Date.now() + 5000; Date.now() < end; await Bun.sleep(1)) if (ok()) return;
  throw new Error("timed out: " + what);
}

// a promise against a clock: undefined when it hasn't settled in time
const race = <T>(p: Promise<T>, ms: number) => Promise.race([p, Bun.sleep(ms).then(() => undefined)]);

test("newer", () => {
  for (const [a, b, want] of [
    ["0.14", "0.13.1", true], ["0.13.1", "0.13", true], ["0.13", "0.13.1", false],
    ["1.0", "1.0", false], ["1.0.0", "1.0", false], ["2", "10", false], ["1.10", "1.9", true],
  ] as [string, string, boolean][])
    expect(u.newer(a, b)).toBe(want);
});

test("ask joins the update in flight", async () => {
  setup();
  const q1 = u.ask();
  expect(u.ask()).toBe(q1);
  let s = u.status();
  expect([s.state, s.id]).toEqual(["asked", q1.id]);
  agent(q1.id, "running");
  s = u.status();
  expect(s.state).toBe("running");
  expect(u.busy()).toBe(true);
  agent(q1.id, "ok", "1.1");
  const r = await q1.wait();
  expect([r.ok, r.to, r.current]).toEqual([true, "1.1", false]);
  await within("request cleared", () => seams.inFlight() === undefined);
  expect(u.ask()).not.toBe(q1);
});

test("ask ignores another request's verdict", async () => {
  setup();
  agent("stale", "ok", "0.9");
  const q = u.ask();
  expect(await race(q.wait(), 50)).toBeUndefined();
  agent(q.id, "failed", "", "apt broke");
  const r = await q.wait();
  expect([r.ok, r.error]).toEqual([false, "apt broke"]);
});

test("ask failure tells the server", async () => {
  setup();
  let failed = false;
  u.onFailed(() => void (failed = true));
  const q = u.ask();
  agent(q.id, "failed");
  expect((await q.wait()).error).toBe("update failed");
  await within("failure hook", () => failed);
});

test("status idle", () => {
  setup();
  expect(u.status().state).toBe("idle");
  expect(u.busy()).toBe(false);
});

test("settle self", async () => {
  setup();
  let r = await u.settleSelf("");
  expect(r.ok).toBe(false);
  expect(r.error).not.toBe("");
  agent("x", "ok", "1.1");
  r = await u.settleSelf("x");
  expect([r.ok, r.to]).toEqual([true, "1.1"]);
  agent("y", "failed", "", "build failed");
  r = await u.settleSelf("y");
  expect([r.ok, r.error]).toEqual([false, "build failed"]);
});

// a peer's status and self snapshots, scripted
class FakePeer {
  i = 0;
  b = 0;
  constructor(public states: Record<string, any>[], public boots: string[]) {}
  state = async () => this.states[Math.min(this.i++, this.states.length - 1)]!;
  self = async () => ({ bootID: this.boots[Math.min(this.b++, this.boots.length - 1)]!, version: "1.1", platform: "" });
}

const st = (id: string, state: string): Record<string, any> => ({ id, state });

async function watch(f: FakePeer, id: string, boot: string): Promise<[Result, string[]]> {
  setup();
  Object.assign(seams, { peerState: f.state, peerSelf: f.self });
  const stages: string[] = [];
  const r = await u.watchPeer("p", id, "1.0", boot, "asked", (m) => {
    if (m.stage !== undefined) stages.push(m.stage);
  });
  return [r, stages];
}

test("watch peer succeeds on the new boot", async () => {
  const f = new FakePeer([st("old", "ok"), st("u1", "asked"), st("u1", "running"), st("u1", "ok")], ["boot1", "boot2"]);
  const [r, stages] = await watch(f, "u1", "boot1");
  expect([r.ok, r.to]).toEqual([true, "1.1"]);
  expect(stages.slice(0, 2)).toEqual(["asked", "installing"]);
});

test("watch peer ignores another update's verdict", async () => {
  const f = new FakePeer([st("other", "failed"), { ...st("u1", "failed"), error: "pull failed" }], ["b"]);
  const [r] = await watch(f, "u1", "b");
  expect([r.ok, r.error]).toEqual([false, "pull failed"]);
});

test("watch peer already current", async () => {
  const [r] = await watch(new FakePeer([{ ...st("u1", "ok"), current: true }], ["b"]), "u1", "b");
  expect([r.ok, r.current, r.to]).toEqual([true, true, "1.0"]);
});

test("watch peer ok without a restart waits", async () => {
  // ok, but the boot never changes: not a success until the swap deadline
  const f = new FakePeer([st("u1", "ok")], ["b"]);
  setup();
  Object.assign(seams, { peerState: f.state, peerSelf: f.self });
  expect(await race(u.watchPeer("p", "u1", "1.0", "b", "asked", () => {}), 100)).toBeUndefined();
});

test("call peer update", async () => {
  const f = new FakePeer([st("u9", "ok")], ["b1", "b2"]);
  setup();
  Object.assign(seams, { peerState: f.state, peerSelf: f.self, askPeer: async (): Promise<[string, Result]> => ["u9", u.result()] });
  let got: Record<string, string> = {};
  const r = await u.callPeerUpdate("p", (m) => {
    if (m.id) got = m;
  });
  expect(r.ok).toBe(true);
  expect([got.id, got.boot, got.from]).toEqual(["u9", "b1", "1.1"]);
  seams.askPeer = async () => ["", u.result({ unreachable: true, error: "no route" })];
  const r2 = await u.callPeerUpdate("p", () => {});
  expect([r2.ok, r2.unreachable]).toEqual([false, true]);
});

test("brief", () => {
  for (const [r, want] of [
    [u.result({ error: "pull failed: x" }), "pull failed"], [u.result({ error: "the restart never landed" }), "restart failed"],
    [u.result({ error: "update timed out" }), "timed out"], [u.result({ unreachable: true, error: "x" }), "unreachable"],
    [u.result({ error: "x" }), "failed"],
  ] as [Result, string][])
    expect(u.brief(r)).toBe(want);
});

const savedChain = (results: Record<string, string>, versions: Record<string, Record<string, string>> = {}): Chain => ({
  id: "00000000-0000", order: Object.keys(results), results, versions, errors: {}, target: "", cancelled: false, done: false, startedAt: "", finishedAt: 0, savedAt: Date.now(),
});

async function restored(c: Chain): Promise<Chain> {
  writeJSONAtomic(chainFile, c);
  const done = new Promise<Chain>((res) => u.onFinish(res));
  u.restoreChain();
  const got = await race(done, 5000);
  if (!got) throw new Error("restored chain never finished");
  return got;
}

test("restore takes this host's verdict from its agent", async () => {
  setup();
  agent("u1", "ok", "1.1");
  const c = await restored(savedChain({ a: "running" }, { a: { id: "u1", from: "1.0" } }));
  expect([c.results.a, c.done]).toEqual(["ok", true]);
});

test("restore never assumes a success", async () => {
  setup();
  // a restart with no request on record is a failure, not an update
  let c = await restored(savedChain({ a: "running" }, { a: { from: "1.0" } }));
  expect(c.results.a).toBe("fail");
  expect(c.errors.a).not.toBe("");
  setup();
  agent("u1", "failed", "", "install failed");
  c = await restored(savedChain({ a: "running" }, { a: { id: "u1" } }));
  expect([c.results.a, c.details?.a]).toEqual(["fail", "install failed"]);
});

test("restore watches peers again", async () => {
  setup();
  const f = new FakePeer([st("p1", "ok")], ["new"]);
  Object.assign(seams, { peerState: f.state, peerSelf: f.self });
  agent("u1", "ok", "1.1");
  const c = await restored(savedChain({ a: "running", p: "running", q: "ok" }, { a: { id: "u1" }, p: { id: "p1", boot: "old", from: "1.0", stage: "installing" } }));
  expect([c.results.a, c.results.p, c.results.q]).toEqual(["ok", "ok", "ok"]);
});

test("restore leaves finished and stale chains alone", () => {
  setup();
  writeJSONAtomic(chainFile, { ...savedChain({ a: "ok" }), done: true });
  u.restoreChain();
  writeJSONAtomic(chainFile, { ...savedChain({ a: "running" }), savedAt: Date.now() - u.chainMaxAgeMS - 1000 });
  u.restoreChain();
  expect(testing.chain()).toBeUndefined();
});

test("restore finishes when nothing is running", async () => {
  setup();
  const c = await restored(savedChain({ a: "ok", b: "pending" }));
  expect([c.results.b, c.done]).toEqual(["skipped", true]);
});

test("start and cancel in the grace", async () => {
  setup();
  const done = new Promise<Chain>((res) => u.onFinish(res));
  const r = u.start([], []);
  expect(r.chainId).toBeString();
  expect(u.start([], []).locked).toBe("a");
  expect(u.chainStatus()).not.toBeNull();
  expect(u.ownLock()).not.toBeNull();
  expect(u.cancel()).toBe(true);
  const c = await race(done, 5000);
  if (!c) throw new Error("cancelled chain never finished");
  expect([c.cancelled, c.results.a]).toEqual([true, "skipped"]);
  expect(u.cancel()).toBe(false);
  expect(u.ownLock()).toBeNull();
});

test("start over only the named hosts", () => {
  setup();
  expect(u.start([], ["nowhere"]).error).toBeString();
});

test("the chain file keeps Go's shape", async () => {
  setup();
  const done = new Promise<Chain>((res) => u.onFinish(res));
  u.start([], []);
  const saved = JSON.parse(await Bun.file(chainFile).text());
  expect(Object.keys(saved)).toEqual(["id", "order", "results", "versions", "errors", "target", "cancelled", "done", "startedAt", "savedAt"]);
  expect(saved.startedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  u.cancel();
  await done;
  expect(JSON.parse(await Bun.file(chainFile).text()).finishedAt).toBeNumber();
});
