import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-elector-"));
process.env.STATE_DIR = dir;
for (const [k, f] of [
  ["LOCAL_FILE", "local"],
  ["DECISION_FILE", "decision"],
  ["LEASE_UNTIL_FILE", "lease"],
  ["FORGEJO_PID_FILE", "forgejo"],
  ["PROMOTING_FILE", "promoting"],
])
  process.env[k!] = join(dir, f!);
process.env.PROMOTE_GRACE = "2";
process.env.ADD_AFTER_MS = "0";
process.env.TICK_MS = "50";
const { Elector, validRoster } = await import("@phosphorus/elector");
// util may already be loaded with another test's STATE_DIR when every suite runs in one process
const state = (await import("@phosphorus/util")).StateDir;
mkdirSync(state, { recursive: true });

type Peer = { gitHost?: boolean; claim?: Record<string, unknown>; grant?: boolean; roster?: unknown };
type Vote = { host: string; body: any };

// the frontends a tick talks to: self's view of every host, each peer's vote
function mesh(self: string, peers: Record<string, Peer>) {
  const votes: Vote[] = [];
  const call = async (host: string, _method: string, path: string, body?: unknown) => {
    if (path === "/api/git/view") {
      const states = Object.entries(peers).map(([h, p]) => ({
        host: h,
        gitHost: p.gitHost ?? true,
        claim: p.claim,
        roster: p.roster,
      }));
      return { pollMs: 50, states: [...states, { host: self, gitHost: true }], offlineMs: {} };
    }
    votes.push({ host, body });
    // self's vote comes by its tailnet address, or its name
    return { granted: peers[host]?.grant ?? true };
  };
  return { call, votes, peers };
}

const local = (s: string) => writeFileSync(process.env.LOCAL_FILE!, s);
const claim = () => JSON.parse(readFileSync(join(state, "git-claim.json"), "utf8"));
const roster = () => JSON.parse(readFileSync(join(state, "git-elector-roster.json"), "utf8"));
const decision = () => readFileSync(process.env.DECISION_FILE!, "utf8");

test("boots as master on a majority, then grows the roster jointly", async () => {
  local("1 7 1 0");
  const m = mesh("a", { b: {}, c: {} });
  const e = new Elector("a", m.call);
  e.start();
  expect(claim()).toEqual({
    host: "a",
    role: "none",
    master: "",
    gen: 1,
    stamp: 7,
    eligible: true,
    roster: 0,
    handoffTo: "",
  });
  // one tick of grace, then the campaign
  await e.tick();
  expect([e.role, m.votes.length]).toEqual(["none", 0]);
  await e.tick();
  expect([e.role, e.master, e.gen]).toEqual(["master", "a", 2]);
  const members = [
    { name: "a", git: true, tb: true },
    { name: "b", git: true, tb: false },
    { name: "c", git: true, tb: false },
  ];
  expect(roster()).toEqual({ epoch: 1, members, prev: null });
  expect(m.votes.map((v) => v.host).sort()).toEqual(
    ["b", "c", m.votes.find((v) => v.host !== "b" && v.host !== "c")!.host].sort(),
  );
  expect(m.votes[0]!.body).toEqual({ c: "a", ms: 4000, roster: { epoch: 1, members, prev: null } });
  expect(claim()).toEqual({
    host: "a",
    role: "master",
    master: "a",
    gen: 2,
    stamp: 7,
    eligible: true,
    roster: 1,
    handoffTo: "",
  });
  expect(decision()).toMatch(/^master a 2 \d+ -\n$/);
  expect(Number(readFileSync(process.env.LEASE_UNTIL_FILE!, "utf8"))).toBeGreaterThan(0);
  // no forgejo yet: promoting
  expect(existsSync(process.env.PROMOTING_FILE!)).toBe(true);

  // leading: the roster unchanged while the view is
  await e.tick();
  expect([e.role, roster().epoch]).toEqual(["master", 1]);
  // d appears: seen by the probe, voted next, then joined through a joint roster
  m.peers.d = { gitHost: false };
  await e.tick();
  await e.tick();
  expect(roster().epoch).toBe(1);
  await e.tick();
  const joint = roster();
  expect(joint.epoch).toBe(2);
  expect(joint.members.map((x: any) => x.name + (x.git ? "*" : ""))).toEqual(["a*", "b*", "c*", "d"]);
  expect(joint.prev).toEqual(members);
  await e.tick();
  expect(roster()).toMatchObject({ epoch: 3, prev: null });
  expect(e.role).toBe("master");

  // a servant in sync takes over when asked from the frontend
  m.peers.b = { claim: { role: "servant", master: "a", gen: 2, stamp: 1, eligible: true, handoffTo: "" } };
  await e.tick();
  expect(e.successor()).toBe("b");
  writeFileSync(join(state, "git-handoff.json"), JSON.stringify({ at: Date.now(), to: "b" }));
  await e.tick();
  expect([e.role, e.master, e.handoffTo]).toEqual(["none", "", "b"]);
  expect(claim()).toMatchObject({ role: "none", handoffTo: "b" });
  // the tiebreak passed to b, then every vote released
  expect(roster().members.find((x: any) => x.name === "b").tb).toBe(true);
  expect(m.votes[m.votes.length - 1]!.body.ms).toBe(0);
  expect(existsSync(join(state, "git-handoff.json"))).toBe(false);
});

test("follows a master, refuses one with older data", async () => {
  local("3 1 1 0");
  const m = mesh("a", {
    b: { claim: { role: "master", master: "b", gen: 5, stamp: 1, eligible: true, handoffTo: "" } },
    c: {},
  });
  const e = new Elector("a", m.call);
  await e.tick();
  expect([e.role, e.master, m.votes.length]).toEqual(["servant", "b", 0]);
  expect(decision()).toMatch(/^servant b 3 \d+ -\n$/);
  local("9 1 1 0");
  await e.tick();
  expect([e.role, e.master, e.refused]).toEqual(["none", "", "b"]);
});

test("stalls without a majority, out of sync, or behind newer data", async () => {
  local("1 1 1 0");
  const m = mesh("a", { b: { grant: false }, c: { grant: false } });
  const e = new Elector("a", m.call);
  await e.tick();
  await e.tick();
  expect([e.role, e.skip]).toEqual(["none", 1]);
  // every vote released after the lost campaign
  expect(m.votes.filter((v) => v.body.ms === 0).length).toBe(3);
  // not in sync and b never seen claiming: no campaign at all
  local("1 1 0 0");
  const m2 = mesh("a", { b: {}, c: {} });
  const e2 = new Elector("a", m2.call);
  await e2.tick();
  await e2.tick();
  expect([e2.role, m2.votes.length]).toEqual(["none", 0]);
  // b holds newer data: waited on
  local("1 1 1 0");
  const m3 = mesh("a", { b: { claim: { role: "none", master: "", gen: 4, stamp: 0, eligible: true, handoffTo: "" } } });
  const e3 = new Elector("a", m3.call);
  await e3.tick();
  await e3.tick();
  expect([e3.role, m3.votes.length]).toEqual(["none", 0]);
  // forced: campaigns regardless
  local("1 1 0 1");
  await e3.tick();
  expect([e3.role, e3.gen]).toEqual(["master", 5]);
});

test("rosters as JSON", () => {
  expect(validRoster({ epoch: 2, members: [{ name: "a", git: true }], prev: null })).toEqual({
    epoch: 2,
    members: [{ name: "a", git: true }],
    prev: null,
  });
  expect(
    validRoster({ epoch: 2, members: [{ name: "a", git: true, tb: true }], prev: [{ name: "b", git: false }] }),
  ).toEqual({
    epoch: 2,
    members: [{ name: "a", git: true, tb: true }],
    prev: [{ name: "b", git: false }],
  });
  for (const bad of [
    null,
    { epoch: 1, members: [] },
    { epoch: 1.5, members: [], prev: null },
    { epoch: -1, members: [], prev: null },
    { epoch: 1, members: [{ name: "a b", git: true }], prev: null },
    { epoch: 1, members: [{ name: "a", git: "yes" }], prev: null },
    { epoch: 1, members: [{ name: "a", git: true, tb: 1 }], prev: null },
    { epoch: 1, members: [], prev: {} },
  ])
    expect(validRoster(bad)).toBeUndefined();
});
