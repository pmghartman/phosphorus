import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-git-"));
process.env.STATE_DIR = dir;
process.env.SELF_HOST = "self";
process.env.PHOSPHORUS_INI_FILE = join(dir, "phosphorus.ini");
const git = await import("@phosphorus/git");
// util may already be loaded with another test's STATE_DIR when every suite runs in one process
const state = (await import("@phosphorus/util")).StateDir;
mkdirSync(state, { recursive: true });

const roster = (epoch: number, ...gits: string[]) => ({ epoch, members: gits.map((name) => ({ name, git: true })), prev: null });
const writeClaim = (c: Record<string, unknown>) => writeFileSync(join(state, "git-claim.json"), JSON.stringify(c));

test("vote validates c, ms and roster", () => {
  git.init(() => false, "b1");
  for (const p of [
    {},
    { c: "a", ms: 100 },
    { c: "bad host", ms: 100, roster: roster(1, "a") },
    { c: "a", ms: 100.5, roster: roster(1, "a") },
    { c: "a", ms: -1, roster: roster(1, "a") },
    { c: "a", ms: 10001, roster: roster(1, "a") },
    { c: "a", ms: "100", roster: roster(1, "a") },
    { c: "a", ms: 100, roster: { epoch: 1, members: [] } },
  ])
    expect(git.vote(p)).toEqual([400, { error: "bad c, ms or roster" }]);
});

test("vote abstains for the first 10s, still adopting the newest roster", () => {
  git.init(() => false, "b1", Date.now());
  expect(git.vote({ c: "a", ms: 4000, roster: roster(2, "a", "b") })).toEqual([200, { granted: false, abstaining: true, roster: roster(2, "a", "b") }]);
  expect(JSON.parse(readFileSync(join(state, "git-roster.json"), "utf8"))).toEqual(roster(2, "a", "b"));
  // an older epoch refused, the newer one sent back
  expect(git.vote({ c: "a", ms: 4000, roster: roster(1, "a") })).toEqual([200, { granted: false, roster: roster(2, "a", "b") }]);
  // the saved roster reloaded on init
  git.init(() => false, "b1");
  expect(git.state().roster).toEqual(roster(2, "a", "b"));
});

test("vote leases to one candidate at a time", async () => {
  git.init(() => false, "b1", Date.now() - 20000);
  const r = roster(3, "a", "b");
  expect(git.vote({ c: "a", ms: 200, roster: r })).toEqual([200, { granted: true, roster: r }]);
  expect(git.vote({ c: "b", ms: 200, roster: r })).toEqual([200, { granted: false, holder: "a", roster: r }]);
  // the holder renews, and releases with ms 0
  expect(git.vote({ c: "a", ms: 200, roster: r })).toEqual([200, { granted: true, roster: r }]);
  expect(git.vote({ c: "a", ms: 0, roster: r })).toEqual([200, { granted: false, roster: r }]);
  expect(git.vote({ c: "b", ms: 50, roster: r })).toEqual([200, { granted: true, roster: r }]);
  // the lease expires
  await Bun.sleep(80);
  expect(git.vote({ c: "a", ms: 200, roster: r })).toEqual([200, { granted: true, roster: r }]);
});

test("state carries claim null while none is fresh", () => {
  git.init(() => true, "boot-7");
  const s = git.state();
  expect(s).toEqual({ host: "self", gitHost: false, roster: s.roster, claim: null, updating: true, bootId: "boot-7" });
  writeClaim({ host: "self", role: "master", master: "self", gen: 3, stamp: 100, eligible: true, handoffTo: "" });
  expect(git.state().claim.role).toBe("master");
  expect(JSON.stringify(git.view()[0])).toContain('"claim":{');
});

test("rows from a view, roster git members unreachable until they answer", () => {
  git.init(() => false, "b1", Date.now() - 20000);
  git.vote({ c: "a", ms: 0, roster: roster(9, "zed", "alpha", "beta") });
  const states = [
    { host: "beta", gitHost: true, updating: 1, claim: { role: "servant", master: "alpha", gen: 4, stamp: 95, eligible: true, handoffTo: "" } },
    { host: "alpha", gitHost: true, claim: { role: "master", master: "alpha", gen: 4, stamp: 101, eligible: true, handoffTo: "gamma" } },
    // a claim alone counts; a bad name, a plain host and a non-object are left out
    { host: "gamma", claim: {} },
    { host: "bad name", gitHost: true },
    { host: "zed", gitHost: false },
    "junk",
    { host: "delta", gitHost: true, claim: null },
  ];
  const rows = git.rowsOf(states, 100);
  expect(rows.map((r) => r.host)).toEqual(["alpha", "beta", "delta", "gamma"]);
  expect(rows[0]).toEqual({ host: "alpha", reachable: true, role: "master", master: "alpha", gen: 4, ageSec: 0, eligible: true, updating: false, handoffTo: "gamma" });
  expect(rows[1]).toEqual({ host: "beta", reachable: true, role: "servant", master: "alpha", gen: 4, ageSec: 5, eligible: true, updating: true, handoffTo: "" });
  expect(rows[2]).toEqual({ host: "delta", reachable: true, role: "starting", master: "", gen: null, ageSec: null, eligible: false, updating: false, handoffTo: "" });
  expect(rows[3].role).toBe("starting");
  // the fingerprint, missing keys null, ageSec left out
  expect(git.rowsFp(git.rowsOf([{ host: "zed", gitHost: true, claim: null }], 100))).toBe('[["alpha",false,null,null,null,null,null],["beta",false,null,null,null,null,null],["zed",true,"starting","",null,false,false]]');
  expect(git.rowsFp(rows)).not.toContain("5");
});

test("promote: handoff from the master only, take on a git host only", () => {
  git.init(() => false, "b1");
  expect(git.promote({})).toEqual([400, { error: "op must be handoff or take" }]);
  writeClaim({ host: "self", role: "servant", master: "x", gen: 1, stamp: 1, eligible: true, handoffTo: "" });
  expect(git.promote({ op: "handoff", to: "x" })).toEqual([409, { error: "self isn't the git master" }]);
  writeClaim({ host: "self", role: "master", master: "self", gen: 1, stamp: 1, eligible: true, handoffTo: "" });
  expect(git.promote({ op: "handoff", to: "bad name" })).toEqual([400, { error: "bad target" }]);
  expect(git.promote({ op: "handoff" })).toEqual([400, { error: "bad target" }]);
  const before = Date.now();
  expect(git.promote({ op: "handoff", to: "x" })).toEqual([200, { ok: true }]);
  const h = JSON.parse(readFileSync(join(state, "git-handoff.json"), "utf8"));
  expect(h.to).toBe("x");
  expect(h.at).toBeGreaterThanOrEqual(before);
  expect(git.promote({ op: "take" })).toEqual([409, { error: "self isn't a git host" }]);
});

test("force refuses what can't work, from this host's own state", async () => {
  git.init(() => false, "b1");
  expect(await git.force("nobody")).toEqual([409, { error: "nobody isn't a reachable git host" }]);
  writeClaim({ host: "self", role: "master", master: "self", gen: 1, stamp: 1, eligible: true, handoffTo: "" });
  expect(await git.force("self")).toEqual([409, { error: "self is already master" }]);
  expect(await git.makeMaster("self")).toEqual([200, { master: "self", note: "already master" }]);
  writeClaim({ host: "self", role: "servant", master: "", gen: 1, stamp: 1, eligible: true, handoffTo: "x" });
  expect(await git.force("self")).toEqual([409, { error: "self is already handing off to x" }]);
  writeClaim({ host: "self", gen: 1, stamp: 1 });
  expect(await git.force("self")).toEqual([409, { error: "a git host is still starting, try once it settles" }]);
  // no master: a take, refused here as self isn't a git host
  writeClaim({ host: "self", role: "servant", master: "", gen: 1, stamp: 1, eligible: true, handoffTo: "" });
  expect(await git.force("self")).toEqual([409, { error: "self isn't a git host" }]);
  expect(await git.makeMaster("self")).toEqual([409, { error: "self isn't a git host" }]);
  if (process.platform !== "linux") return;
  // a git host: the force-promote file dropped, a second request told it's under way
  writeFileSync(process.env.PHOSPHORUS_INI_FILE!, "[git]\nhost = true\n");
  expect(await git.force("self")).toEqual([200, { ok: true }]);
  expect(existsSync(join(state, "git-force-promote"))).toBe(true);
  expect(await git.force("self")).toEqual([409, { error: "making self master is already under way" }]);
});
