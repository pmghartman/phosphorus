// one group on files, as a service acting on its decisions would keep them: the
// copy's version in, the decision, lease and promoting flag out
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Group } from "@phosphorus/elector";

const state = mkdtempSync(join(tmpdir(), "phos-elector-"));
process.env.PROMOTE_GRACE = "2";
process.env.ADD_AFTER_MS = "0";
process.env.TICK_MS = "50";
process.env.LEASE_MS = "4000";
process.env.LEASE_MARGIN_MS = "1500";
const { Elector: Base, fileStore, validRoster } = await import("@phosphorus/elector");

const files = { local: "local", decision: "decision", lease: "lease", up: "up", promoting: "promoting" };
const at = (f: keyof typeof files) => join(state, files[f]);
const read = (f: string) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
};

// "<gen> <stamp> <inSync> <force>"
function svcGroup(): Group {
  return {
    name: "svc",
    view: "/api/ha/svc/view",
    vote: "/api/ha/svc/vote",
    flag: "candidate",
    ...fileStore(state, "svc"),
    local() {
      const f = read(at("local")).trim().split(/\s+/);
      return { gen: Number(f[0]) || 0, stamp: Number(f[1]) || 0, inSync: f[2] === "1", force: f[3] === "1" };
    },
    up: () => read(at("up")).trim() !== "",
    decide(d) {
      if (d.promoting) writeFileSync(at("promoting"), "");
      else rmSync(at("promoting"), { force: true });
      writeFileSync(at("lease"), `${d.leaseUntil}\n`);
      writeFileSync(at("decision"), `${d.role} ${d.master || "-"} ${d.gen} ${d.at} ${d.from || "-"}\n`);
    },
  };
}

class Elector extends Base {
  constructor(self: string, call: ConstructorParameters<typeof Base>[1]) {
    super(self, call, svcGroup());
  }
}

type Peer = { candidate?: boolean; claim?: Record<string, unknown>; grant?: boolean; roster?: unknown };
type Vote = { host: string; body: any };

// the frontends a tick talks to: self's view of every host, each peer's vote
function mesh(self: string, peers: Record<string, Peer>) {
  const votes: Vote[] = [];
  const call = async (host: string, _method: string, path: string, body?: unknown) => {
    if (path === "/api/ha/svc/view") {
      const states = Object.entries(peers).map(([h, p]) => ({
        host: h,
        candidate: p.candidate ?? true,
        claim: p.claim,
        roster: p.roster,
      }));
      return { pollMs: 50, states: [...states, { host: self, candidate: true }], offlineMs: {} };
    }
    votes.push({ host, body });
    // self's vote comes by its tailnet address, or its name
    return { granted: peers[host]?.grant ?? true };
  };
  return { call, votes, peers };
}

const local = (s: string) => writeFileSync(at("local"), s);
const claim = () => JSON.parse(readFileSync(join(state, "svc-claim.json"), "utf8"));
const roster = () => JSON.parse(readFileSync(join(state, "svc-elector-roster.json"), "utf8"));
const decision = () => read(at("decision"));

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
  expect(Number(read(at("lease")))).toBeGreaterThan(0);
  // the service not up yet: promoting
  expect(existsSync(at("promoting"))).toBe(true);

  // leading: the roster unchanged while the view is
  await e.tick();
  expect([e.role, roster().epoch]).toEqual(["master", 1]);
  // d appears: seen by the probe, voted next, then joined through a joint roster
  m.peers.d = { candidate: false };
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
  writeFileSync(join(state, "svc-handoff.json"), JSON.stringify({ at: Date.now(), to: "b" }));
  await e.tick();
  expect([e.role, e.master, e.handoffTo]).toEqual(["none", "", "b"]);
  expect(claim()).toMatchObject({ role: "none", handoffTo: "b" });
  // the tiebreak passed to b, then every vote released
  expect(roster().members.find((x: any) => x.name === "b").tb).toBe(true);
  expect(m.votes[m.votes.length - 1]!.body.ms).toBe(0);
  expect(existsSync(join(state, "svc-handoff.json"))).toBe(false);
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
