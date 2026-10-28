// this host's vote in the git master election and the git card
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Roster, validRoster } from "@phosphorus/elector";
import { peerGit } from "@phosphorus/peers";
import { ini, localeCompare, marshal, now, obj, peerCall, readFresh, readJSON, SelfHost, sleep, StateDir, writeJSONAtomic } from "@phosphorus/util";

const selfHost = SelfHost;
const claimFile = join(StateDir, "git-claim.json");
const rosterFile = join(StateDir, "git-roster.json");
const handoffFile = join(StateDir, "git-handoff.json");
const forceFile = join(StateDir, "git-force-promote");
const nameRe = /^[A-Za-z0-9-]{1,63}$/;
let started = Date.now();

const leaseCapMS = 10000;
const claimMaxAgeMS = 3000;
const settleMS = 30000;

let holder = "";
let until = 0;
let roster: Roster = { epoch: 0, members: [], prev: null };
let updating = () => false;
let bootID = "";

// Go's truthy: false, nil, 0, NaN and "" are false
const truthy = (v: unknown) => (typeof v === "number" ? v !== 0 && !Number.isNaN(v) : !!v);
// as a JS template literal renders a JSON value
const jsString = (v: unknown): string =>
  v == null ? "null" : Array.isArray(v) ? v.map((e) => (e == null ? "" : jsString(e))).join(",") : typeof v === "object" ? "[object Object]" : String(v);
const str = (v: unknown) => (truthy(v) ? jsString(v) : "");

// with server's updating flag and boot id; startedAt the process start, for tests
export function init(isUpdating: () => boolean, boot: string, startedAt = started) {
  updating = isUpdating;
  bootID = boot;
  started = startedAt;
  roster = validRoster(readJSON(rosterFile)) ?? { epoch: 0, members: [], prev: null };
}

// Linux alone, as the host's own check
const isGitHost = () => process.platform === "linux" && ini("git", "host") === "true";

// a monotonic lease, the newest roster kept
export function vote(p: Record<string, any>): [number, any] {
  const r = validRoster(p.roster);
  const c = p.c;
  const ms = p.ms;
  if (typeof c !== "string" || !nameRe.test(c) || typeof ms !== "number" || !Number.isInteger(ms) || ms < 0 || ms > leaseCapMS || !r)
    return [400, { error: "bad c, ms or roster" }];
  if (r.epoch < roster.epoch) return [200, { granted: false, roster }];
  if (r.epoch > roster.epoch) {
    roster = r;
    writeJSONAtomic(rosterFile, roster);
  }
  if (Date.now() - started < leaseCapMS) return [200, { granted: false, abstaining: true, roster }];
  const t = Date.now();
  if (holder !== "" && holder !== c && t < until) return [200, { granted: false, holder, roster }];
  if (ms === 0) (holder = ""), (until = 0);
  else (holder = c), (until = t + ms);
  return [200, { granted: ms > 0, roster }];
}

// null as Go's nil marshals, the key kept in the snapshot
const claim = (): any => readFresh(claimFile, claimMaxAgeMS) ?? null;

// this host's, published in the mesh snapshot
export function state(): Record<string, any> {
  return { host: selfHost, gitHost: isGitHost(), roster, claim: claim(), updating: updating(), bootId: bootID };
}

// ours and every answering peer's, for the elector
export const view = (): any[] => [state(), ...peerGit()];

// one git host on the card
export type Row = Record<string, any>;

// the rows that moved, ageSec ticking left out
export const rowsFp = (rows: Row[]) => marshal(rows.map((h) => [h.host, h.reachable, h.role, h.master, h.gen, h.eligible, h.updating]));

// the card's rows from a view, nowSec the wall clock ageSec counts from
export function rowsOf(states: unknown[], nowSec: number): Row[] {
  const out = new Map<string, Row>();
  const order: string[] = [];
  const set = (h: string, r: Row) => {
    if (!out.has(h)) order.push(h);
    out.set(h, r);
  };
  for (const m of roster.members) if (m.git) set(m.name, { host: m.name, reachable: false });
  for (const s of states) {
    const sm = obj(s);
    if (!sm) continue;
    const h = sm.host;
    if (typeof h !== "string" || !nameRe.test(h)) continue;
    if (!(truthy(sm.gitHost) || truthy(sm.claim))) {
      out.delete(h);
      continue;
    }
    const c = obj(sm.claim) ?? {};
    const st = c.stamp;
    const age = typeof st === "number" && st !== 0 ? Math.max(0, nowSec - st) : null;
    set(h, {
      host: h,
      reachable: true,
      role: str(c.role) || "starting",
      master: str(c.master),
      gen: c.gen ?? null,
      ageSec: age,
      eligible: truthy(c.eligible),
      updating: truthy(sm.updating),
      handoffTo: str(c.handoffTo),
    });
  }
  const rows: Row[] = [];
  for (const h of order) {
    const r = out.get(h);
    if (r) rows.push(r);
  }
  return rows.sort((a, b) => localeCompare(a.host, b.host));
}

// ours and every peer's git state, sorted by host
export const rows = () => rowsOf(view(), Math.trunc(now() / 1000));

// the peer end of make master
export function promote(body: Record<string, any>): [number, any] {
  switch (body.op) {
    case "handoff": {
      const c = obj(claim());
      if (!c || c.role !== "master") return [409, { error: selfHost + " isn't the git master" }];
      const to = body.to;
      if (typeof to !== "string" || !nameRe.test(to)) return [400, { error: "bad target" }];
      writeJSONAtomic(handoffFile, { to, at: now() });
      return [200, { ok: true }];
    }
    case "take":
      if (!isGitHost()) return [409, { error: selfHost + " isn't a git host" }];
      try {
        writeFileSync(forceFile, "", { mode: 0o644 });
      } catch {}
      return [200, { ok: true }];
  }
  return [400, { error: "op must be handoff or take" }];
}

function hop(host: string, body: Record<string, any>): Promise<[number, any]> {
  if (host !== selfHost) return peerCall(host, { host, method: "POST", path: "/api/git/promote", body, timeoutMs: 5000 });
  return Promise.resolve(promote(body));
}

let inFlight: { to: string; until: number } | undefined;

const leads = (host: string) => rows().some((h) => h.host === host && h.reachable === true && h.role === "master");

// with a live master a hand-off, without one a force-promote
export async function force(target: string): Promise<[number, any]> {
  const all = rows();
  const find = (f: (h: Row) => boolean) => all.find(f);
  const t = find((h) => h.host === target);
  if (!t || t.reachable !== true) return [409, { error: target + " isn't a reachable git host" }];
  if (t.role === "master") return [409, { error: target + " is already master" }];
  const m = find((h) => h.reachable === true && truthy(h.handoffTo));
  if (m) return [409, { error: `${m.host} is already handing off to ${m.handoffTo}` }];
  if (inFlight && now() < inFlight.until && !leads(inFlight.to)) return [409, { error: "making " + inFlight.to + " master is already under way" }];
  const master = find((h) => h.role === "master" && h.reachable === true);
  if (!master && find((h) => h.reachable === true && h.role === "starting")) return [409, { error: "a git host is still starting, try once it settles" }];
  if (master && (!truthy(t.eligible) || t.master !== master.host)) return [409, { error: `${target} isn't in sync with ${master.host} yet` }];
  const [st, out] = master ? await hop(master.host, { op: "handoff", to: target }) : await hop(target, { op: "take" });
  if (st === 200) inFlight = { to: target, until: now() + settleMS };
  return [st, out];
}

// done only once the target leads
export async function makeMaster(target: string): Promise<[number, any]> {
  if (leads(target)) return [200, { master: target, note: "already master" }];
  const start = now();
  const [st, out] = await force(target);
  if (st !== 200 && !(inFlight && inFlight.to === target)) return [st, out];
  while (now() - start < settleMS) {
    if (leads(target)) return [200, { master: target, tookS: Math.trunc((now() - start + 500) / 1000) }];
    await sleep(500);
  }
  return [504, { error: `${target} didn't take over in ${settleMS / 1000}s, the git tool shows where it stands` }];
}
