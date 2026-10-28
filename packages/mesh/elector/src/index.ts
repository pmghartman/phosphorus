// git master election, every host's frontend voting, a majority lease making
// one master, joint rosters keeping quorums overlapping, acted on by
// git-daemon.sh
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  env,
  envInt,
  logf as log,
  marshal,
  obj,
  readJSON,
  readJSONMap,
  requestJSON,
  StateDir,
  sleep,
  writeFileAtomic,
} from "@phosphorus/util";

const frontendPort = envInt("FRONTEND_PORT", 8090);
const claimFile = join(StateDir, "git-claim.json");
const rosterFile = join(StateDir, "git-elector-roster.json");
const handoffFile = join(StateDir, "git-handoff.json");
const localFile = env("LOCAL_FILE", "/run/phosphorus/git-local");
const decisionFile = env("DECISION_FILE", "/run/phosphorus/git-decision");
const leaseFile = env("LEASE_UNTIL_FILE", "/run/phosphorus/git-lease-until");
const forgejoPidFile = env("FORGEJO_PID_FILE", "/run/phosphorus/git-forgejo-pid");
const promotingFile = env("PROMOTING_FILE", "/run/phosphorus/git-promoting");

const tickMS = envInt("TICK_MS", 500);
const probeTimeoutMs = envInt("PROBE_TIMEOUT_MS", 500);
const leaseMS = envInt("LEASE_MS", 4000);
const leaseMarginMS = envInt("LEASE_MARGIN_MS", 1500);
const promoteGrace = envInt("PROMOTE_GRACE", 2);
const addAfterMS = envInt("ADD_AFTER_MS", 3000);
const removeAfterMS = envInt("REMOVE_AFTER_MS", 300000);
const holdMS = envInt("HOLD_MS", 15000);
const witnessMS = envInt("WITNESS_MS", 60000);
const vouchMS = envInt("VOUCH_MS", 120000);
const handoffMaxAgeMS = 30000;

const nameRe = /^[A-Za-z0-9-]{1,63}$/;

const logf = (fmt: string, ...a: unknown[]) => log("[elector] " + fmt, ...a);

// of a roster, tb kept absent when a peer sent none
export type Member = { name: string; git: boolean; tb?: boolean };
// prev null marshals as null
export type Roster = { epoch: number; members: Member[]; prev: Member[] | null };

const member = (name: string, git: boolean, tb?: boolean): Member =>
  tb === undefined ? { name, git } : { name, git, tb };
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

function validMembers(v: unknown): Member[] | undefined {
  if (!Array.isArray(v)) return;
  const out: Member[] = [];
  for (const x of v) {
    const o = obj(x);
    if (!o || typeof o.name !== "string" || !nameRe.test(o.name) || typeof o.git !== "boolean") return;
    if ("tb" in o && typeof o.tb !== "boolean") return;
    out.push(member(o.name, o.git, "tb" in o ? o.tb : undefined));
  }
  return out;
}

// from generic JSON, undefined when malformed
export function validRoster(v: unknown): Roster | undefined {
  const o = obj(v);
  if (!o || !isInt(o.epoch) || o.epoch < 0) return;
  const members = validMembers(o.members);
  if (!members) return;
  // prev undefined fails JS's `r.prev !== null` check
  if (!("prev" in o)) return;
  let prev: Member[] | null = null;
  if (o.prev !== null) {
    prev = validMembers(o.prev) ?? null;
    if (!prev) return;
  }
  return { epoch: o.epoch, members, prev };
}

type Claim = {
  host: string;
  role: string;
  master: string;
  gen: number;
  stamp: number;
  eligible: boolean;
  handoffTo: string;
};

function validClaim(v: unknown): Claim | undefined {
  const o = obj(v);
  if (!o) return;
  const role = o.role;
  if (role !== "master" && role !== "servant" && role !== "none") return;
  if (!isInt(o.gen) || !isInt(o.stamp)) return;
  return {
    host: "",
    role,
    master: typeof o.master === "string" ? o.master : "",
    gen: o.gen,
    stamp: o.stamp,
    eligible: !!o.eligible,
    handoffTo: typeof o.handoffTo === "string" ? o.handoffTo : "",
  };
}

// the monotonic clock every stamp is on, the wall clock where /proc has none
export function uptimeMS(): number {
  try {
    return Math.round(Number.parseFloat(readFileSync("/proc/uptime", "utf8").split(/\s+/)[0]!) * 1000);
  } catch {
    return Date.now();
  }
}

function writeAtomic(file: string, text: string) {
  try {
    writeFileAtomic(file, text);
  } catch {}
}

const rm = (file: string) => {
  try {
    rmSync(file, { force: true });
  } catch {}
};

const read = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const names = (m: Member[]) => m.map((x) => x.name);
const gitNames = (m: Member[]) =>
  m
    .filter((x) => x.git)
    .map((x) => x.name)
    .sort();
const uniq = (xs: string[]) => [...new Set(xs)];
const voters = (r: Roster) => uniq([...names(r.members), ...(r.prev ? names(r.prev) : [])]);
const describe = (m: Member[]) => m.map((x) => (x.git ? x.name + "*" : x.name)).join(" ");
const byName = (a: Member, b: Member) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function tiebreaker(m: Member[]): string {
  for (const x of m) if (x.tb && x.git) return x.name;
  return gitNames(m)[0] ?? "";
}

function partOK(m: Member[], granted: Set<string>, leader: string): boolean {
  const gits = gitNames(m);
  if (gits.length === 1 && gits[0] === leader) return true;
  const got = m.filter((x) => granted.has(x.name)).length;
  return got * 2 > m.length || (got * 2 === m.length && gits.length > 0 && granted.has(tiebreaker(m)));
}

const quorum = (r: Roster, granted: Set<string>, leader: string) =>
  partOK(r.members, granted, leader) && (r.prev === null || partOK(r.prev, granted, leader));

type Local = { gen: number; stamp: number; inSync: boolean; force: boolean };

function readLocal(): Local {
  const f = read(localFile).trim().split(/\s+/);
  const at = (i: number) => f[i] ?? "";
  const num = (s: string) => {
    const v = Number(s);
    return Number.isFinite(v) ? Math.trunc(v) : 0;
  };
  return { gen: num(at(0)), stamp: num(at(1)), inSync: at(2) === "1", force: at(3) === "1" };
}

function better(a: Claim, b: Claim): boolean {
  if (a.gen !== b.gen) return a.gen > b.gen;
  if (a.stamp !== b.stamp) return a.stamp > b.stamp;
  return a.host < b.host;
}

// the tailnet address, where a peer-shaped request to self must go
function selfAddr(self: string): string {
  for (const addrs of Object.values(networkInterfaces()))
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4") continue;
      const [a0, a1] = a.address.split(".").map(Number);
      if (a0 === 100 && a1! >= 64 && a1! <= 127) return a.address;
    }
  return self;
}

const forgejoUp = () => read(forgejoPidFile).trim() !== "";

// one frontend request: parsed JSON on a 200, else undefined
export type Call = (
  host: string,
  method: string,
  path: string,
  body?: unknown,
) => Promise<Record<string, any> | undefined>;

// the elector's state, one tick at a time driving it
export class Elector {
  known: Roster = { epoch: 0, members: [], prev: null };
  firstSeen = new Map<string, number>();
  lastSeen = new Map<string, number>();
  gitFlag = new Map<string, boolean>();
  claims = new Map<string, Claim>();
  selfState?: Record<string, any>;
  viewOK = false;
  witnessed = new Set<string>();
  pollMS = tickMS;

  role = "none";
  master = "";
  gen = 0;
  leaseUntil = 0;
  committed = -1;
  noMasterTicks = 0;
  skip = 0;
  refused = "";
  holdUntil = 0;
  stopping = false;
  handedOffBoot = "";
  handoffTo = "";
  vouched = false;
  vouchedAt = 0;
  lastMaster = "";
  finalFrom = "";
  lastStall = "";
  grantedLast = new Set<string>();

  constructor(
    public self: string,
    private callFn: Call = httpCall,
  ) {}

  private stall(why: string) {
    if (why === this.lastStall) return;
    this.lastStall = why;
    logf("no master, not campaigning: %s", why);
  }

  private call(host: string, method: string, path: string, body?: unknown) {
    return this.callFn(host === this.self ? selfAddr(this.self) : host, method, path, body);
  }

  private adopt(v: unknown) {
    const r = validRoster(v);
    if (!r || r.epoch <= this.known.epoch) return;
    this.known = r;
    this.saveKnown();
  }

  private saveKnown() {
    writeAtomic(rosterFile, marshal(this.known));
  }

  // every host's git state as the local frontend's mesh poll carried it
  private async probe(): Promise<boolean> {
    const now = uptimeMS();
    const view = await this.call(this.self, "GET", "/api/git/view");
    const states = view?.states;
    this.viewOK = !!view && Array.isArray(states);
    if (!this.viewOK) return false;
    const pm = view!.pollMs;
    this.pollMS = typeof pm === "number" && pm > 0 && Number.isFinite(pm) ? Math.trunc(pm) : tickMS;
    const byHost = new Map<string, Record<string, any>>();
    for (const s of states as unknown[]) {
      const o = obj(s);
      if (!o || typeof o.host !== "string" || !nameRe.test(o.host)) continue;
      byHost.set(o.host, o);
    }
    this.claims = new Map();
    this.witnessed = new Set();
    for (const [h, f] of Object.entries(obj(view!.offlineMs) ?? {}))
      if (nameRe.test(h) && h !== this.self && !byHost.has(h) && typeof f === "number" && f >= witnessMS)
        this.witnessed.add(h);
    for (const h of [...this.firstSeen.keys()]) if (!byHost.has(h)) this.firstSeen.delete(h);
    for (const [h, s] of byHost) {
      this.adopt(s.roster);
      this.lastSeen.set(h, now);
      if (!this.firstSeen.has(h)) this.firstSeen.set(h, now);
      this.gitFlag.set(h, s.gitHost === true);
      if (h === this.self) this.selfState = s;
      const c = validClaim(s.claim);
      if (c && h !== this.self) {
        c.host = h;
        this.claims.set(h, c);
      }
    }
    return true;
  }

  private async campaign(r: Roster, ms: number, extra: string[]): Promise<Set<string>> {
    const vs = uniq([...voters(r), ...extra]);
    const replies = await Promise.all(
      vs.map((h) => this.call(h, "POST", "/api/git/vote", { c: this.self, ms, roster: r })),
    );
    const granted = new Set<string>();
    replies.forEach((rep, i) => {
      if (!rep) return;
      if (rep.granted === true) granted.add(vs[i]!);
      this.adopt(rep.roster);
    });
    return granted;
  }

  private me(l: Local): Claim {
    return { host: this.self, role: "", master: "", gen: l.gen, stamp: l.stamp, eligible: false, handoffTo: "" };
  }

  private synced = (l: Local) => l.inSync;

  private eligible(l: Local, r: Roster): boolean {
    if (l.force || this.synced(l)) return true;
    const gits = new Set([...gitNames(r.members), ...(r.prev ? gitNames(r.prev) : [])]);
    gits.delete(this.self);
    for (const h of gits) if (!this.claims.has(h) && !(this.vouched && this.witnessed.has(h))) return false;
    return true;
  }

  private pending(): string[] {
    const now = uptimeMS();
    const members = new Set(names(this.known.members));
    const out: string[] = [];
    for (const [h, t] of this.firstSeen) if (!members.has(h) && now - t >= addAfterMS) out.push(h);
    return out.sort();
  }

  private desiredMembers(grantedLast: Set<string>): Member[] {
    const now = uptimeMS();
    const out = new Map<string, Member>();
    for (const m of this.known.members) {
      const ls = this.lastSeen.get(m.name) ?? now;
      if (m.name !== this.self && now - ls > removeAfterMS) continue;
      out.set(m.name, member(m.name, this.gitFlag.get(m.name) ?? m.git, false));
    }
    for (const h of this.pending()) if (grantedLast.has(h)) out.set(h, member(h, this.gitFlag.get(h) === true, false));
    out.set(this.self, member(this.self, true, true));
    return [...out.values()].sort(byName);
  }

  private nextRoster(): [Roster, boolean] {
    if (this.committed !== this.known.epoch || !this.viewOK) return [this.known, false];
    if (this.known.prev !== null)
      return [{ epoch: this.known.epoch + 1, members: this.known.members, prev: null }, true];
    const want = this.desiredMembers(this.grantedLast);
    if (marshal(want) === marshal(this.known.members)) return [this.known, false];
    return [{ epoch: this.known.epoch + 1, members: want, prev: this.known.members }, true];
  }

  private async lead() {
    const [r, changed] = this.nextRoster();
    if (changed) {
      this.known = r;
      this.saveKnown();
      logf("roster %d: %s%s", r.epoch, describe(r.members), r.prev ? ` (joint with ${describe(r.prev)})` : "");
    }
    const sent = uptimeMS();
    // the probe run beside the campaign: adopt is the shared write, both
    // rare enough to tolerate the ordering
    const [, granted] = await Promise.all([this.probe(), this.campaign(r, leaseMS, this.pending())]);
    this.grantedLast = granted;
    if (quorum(r, granted, this.self)) {
      this.leaseUntil = sent + leaseMS - leaseMarginMS;
      this.committed = r.epoch;
    }
    if (uptimeMS() >= this.leaseUntil) {
      logf("lost the vote majority, stepping down");
      this.role = "none";
      this.master = "";
    }
  }

  private async followOrCampaign(l: Local) {
    if (!(await this.probe())) return;
    let best: Claim | undefined;
    for (const c of this.sortedClaims()) if (c.role === "master" && (!best || better(c, best))) best = c;
    if (best) {
      this.noMasterTicks = 0;
      if (best.gen < l.gen) {
        if (this.refused !== best.host)
          logf(
            "refusing to follow %s: its data (gen %d) is older than ours (gen %d), fix by hand",
            best.host,
            best.gen,
            l.gen,
          );
        this.refused = best.host;
        this.vouched = false;
        this.vouchedAt = 0;
        this.role = "none";
        this.master = "";
        return;
      }
      this.refused = "";
      this.lastStall = "";
      if (this.synced(l)) this.vouchedAt = uptimeMS();
      this.vouched = uptimeMS() - this.vouchedAt < vouchMS;
      this.lastMaster = best.host;
      this.role = "servant";
      this.master = best.host;
      return;
    }

    this.role = "none";
    this.master = "";
    this.noMasterTicks++;
    const named = this.namedSuccessor();
    if (named && named !== this.self) return;
    if (this.skip > 0) {
      this.skip--;
      return;
    }
    if (uptimeMS() < this.holdUntil) return;
    if (this.noMasterTicks < promoteGrace) return;

    const boot = this.known.epoch === 0 || l.force;
    const gone: string[] = [];
    if (!boot && this.vouched) for (const h of names(this.known.members)) if (this.witnessed.has(h)) gone.push(h);
    let r = this.known;
    let same = true;
    if (boot) {
      const hosts = uniq([...[...this.firstSeen.keys()].sort(), this.self]);
      const ms = hosts
        .map((h) => member(h, h === this.self || this.gitFlag.get(h) === true, h === this.self))
        .sort(byName);
      r = { epoch: this.known.epoch + 1, members: ms, prev: null };
      same = false;
    } else if (gone.length) {
      const goneSet = new Set(gone);
      const ms = this.known.members
        .filter((m) => !goneSet.has(m.name))
        .map((m) => member(m.name, m.git, m.name === this.self));
      r = { epoch: this.known.epoch + 1, members: ms, prev: null };
      same = false;
    }
    if (!r.members.some((m) => m.name === this.self && m.git)) {
      this.stall("not a git member of the roster");
      return;
    }
    if (!this.eligible(l, r)) {
      const who =
        gitNames(r.members)
          .filter((h) => h !== this.self && !this.claims.has(h))
          .join(", ") || "no host";
      const why = this.vouched ? " (waiting on tailscale to call them gone)" : " (never vouched for the last master)";
      this.stall(`not in sync, and ${who} out of view${why}`);
      return;
    }
    const mine = this.me(l);
    for (const c of this.sortedClaims())
      if (!l.force && named !== this.self && better(c, mine)) {
        this.stall(`${c.host} has newer data, waiting on it`);
        return;
      }
    if (l.force) logf("forced: resetting roster to %s", describe(r.members));
    else if (gone.length)
      logf(
        "%s offline per tailscale for %ds, roster without it: %s",
        gone.join(", "),
        Math.trunc(witnessMS / 1000),
        describe(r.members),
      );
    if (!same) {
      this.known = r;
      this.saveKnown();
    }
    const sent = uptimeMS();
    const granted = await this.campaign(r, leaseMS, []);
    if (!quorum(r, granted, this.self)) {
      await this.campaign(r, 0, []);
      this.stall(`${granted.size} of ${voters(r).length} votes, no majority`);
      const idx = gitNames(r.members).indexOf(this.self);
      this.skip = (idx < 0 ? 0 : idx) + 1;
      return;
    }
    const prev = this.claims.get(this.lastMaster);
    this.finalFrom = prev && prev.role !== "master" && prev.gen >= l.gen ? this.lastMaster : "";
    let g = l.gen;
    for (const c of this.claims.values()) if (c.gen > g) g = c.gen;
    this.gen = g + 1;
    this.leaseUntil = sent + leaseMS - leaseMarginMS;
    this.committed = r.epoch;
    this.role = "master";
    this.master = this.self;
    this.vouched = false;
    this.vouchedAt = 0;
    this.lastStall = "";
    const how = gitNames(r.members).length === 1 ? "sole git host" : `won ${granted.size} of ${voters(r).length} votes`;
    logf("%s (roster %d: %s), promoting self, gen %d", how, r.epoch, describe(r.members), this.gen);
  }

  // claims in view order is a JS Map's insertion order, sorted here: ties
  // broken by better(), name last, so the order never decides
  private sortedClaims(): Claim[] {
    return [...this.claims.keys()].sort().map((h) => this.claims.get(h)!);
  }

  writeOut(l: Local) {
    if (this.role === "master" && !forgejoUp()) {
      try {
        writeFileSync(promotingFile, "", { mode: 0o644 });
      } catch {}
    } else rm(promotingFile);
    writeAtomic(leaseFile, `${this.leaseUntil}\n`);
    const g = this.role === "master" && this.gen > l.gen ? this.gen : l.gen;
    const ff = this.role === "master" && this.finalFrom ? this.finalFrom : "-";
    writeAtomic(decisionFile, `${this.role} ${this.master || "-"} ${g} ${uptimeMS()} ${ff}\n`);
    this.writeClaim(l, g);
  }

  private writeClaim(l: Local, g: number) {
    writeAtomic(
      claimFile,
      marshal({
        host: this.self,
        role: this.role,
        master: this.master,
        gen: g,
        stamp: l.stamp,
        eligible: this.role === "master" || this.synced(l),
        roster: this.known.epoch,
        handoffTo: uptimeMS() < this.holdUntil ? this.handoffTo : "",
      }),
    );
  }

  private canTakeOver(h: string): boolean {
    const c = this.claims.get(h);
    if (!c || c.role !== "servant" || c.master !== this.self || !c.eligible) return false;
    return this.known.members.some((m) => m.name === h && m.git);
  }

  successor(): string {
    let best: Claim | undefined;
    for (const c of this.sortedClaims()) if (this.canTakeOver(c.host) && (!best || better(c, best))) best = c;
    return best?.host ?? "";
  }

  private async passTiebreak(to: string) {
    if (this.known.prev !== null || !to) return;
    const members = this.known.members.map((m) => member(m.name, m.git, m.name === to));
    for (const prev of [this.known.members, null]) {
      const r: Roster = { epoch: this.known.epoch + 1, members, prev };
      this.known = r;
      this.saveKnown();
      if (!quorum(r, await this.campaign(r, leaseMS, []), this.self)) return;
    }
    logf("%s is now the tiebreaker", to);
  }

  async handOff(reason: string, to: string) {
    logf("%s, handing off%s", reason, to ? " to " + to : "");
    this.role = "none";
    this.master = "";
    this.handoffTo = to;
    this.holdUntil = uptimeMS() + holdMS;
    this.writeOut(readLocal());
    while (forgejoUp()) {
      const sent = uptimeMS();
      if (quorum(this.known, await this.campaign(this.known, leaseMS, []), this.self))
        this.leaseUntil = sent + leaseMS - leaseMarginMS;
      if (uptimeMS() >= this.leaseUntil) return;
      const l = readLocal();
      this.writeClaim(l, l.gen);
      await sleep(200);
    }
    await this.passTiebreak(to);
    await this.campaign(this.known, 0, []);
  }

  private namedSuccessor(): string {
    for (const c of this.sortedClaims())
      if (c.handoffTo && (c.handoffTo === this.self || this.claims.has(c.handoffTo))) return c.handoffTo;
    return "";
  }

  private handoffRequest(): string {
    const req = readJSONMap(handoffFile);
    if (!req) return "";
    rm(handoffFile);
    if (typeof req.at !== "number" || Date.now() - req.at > handoffMaxAgeMS) return "";
    const to = typeof req.to === "string" ? req.to : "";
    if (!this.canTakeOver(to)) {
      logf("not handing off to %s: not an in-sync servant of ours", to);
      return "";
    }
    return to;
  }

  async tick() {
    if (this.stopping) return;
    const l = readLocal();
    let leaving = false;
    if (this.role === "master" && this.selfState) {
      const boot = typeof this.selfState.bootId === "string" ? this.selfState.bootId : "";
      if (this.selfState.updating === true && this.handedOffBoot !== boot) {
        leaving = true;
        this.handedOffBoot = boot;
      }
    }
    const to = this.successor();
    if (leaving && to) await this.handOff("an update is about to restart this host", to);
    else if (this.role === "master") {
      const to = this.handoffRequest();
      if (to) await this.handOff("asked from the frontend", to);
      else {
        if (leaving) logf("an update is about to restart this host, no servant to take over, staying master");
        await this.lead();
      }
    } else await this.followOrCampaign(l);
    if (!this.stopping) this.writeOut(l);
  }

  // the saved roster and its voters as last seen, then the first files out
  start() {
    const r = validRoster(readJSON(rosterFile));
    if (r) this.known = r;
    const now = uptimeMS();
    for (const h of voters(this.known)) this.lastSeen.set(h, now);
    this.writeOut(readLocal());
    logf("starting as %s, roster %d: %s", this.self, this.known.epoch, describe(this.known.members) || "(none yet)");
  }

  // the claim withdrawn, the lease handed off or released
  async stop() {
    this.stopping = true;
    rm(claimFile);
    if (this.role === "master") await this.handOff("shutting down", this.successor());
    else await this.campaign(this.known, 0, []);
  }
}

const httpCall: Call = async (host, method, path, body) => {
  try {
    const r = await requestJSON({ host, port: frontendPort, method, path, body, timeoutMs: probeTimeoutMs });
    return r.status === 200 ? obj(r.body) : undefined;
  } catch {
    return undefined;
  }
};

// runs the elector until SIGTERM, the exit code
export async function main(): Promise<number> {
  const selfFile = join(StateDir, "self-host");
  let self: string;
  try {
    self = readFileSync(selfFile, "utf8").trim();
  } catch (e) {
    logf("can't read %s: %s", selfFile, e instanceof Error ? e.message : e);
    return 1;
  }
  const e = new Elector(self);
  e.start();
  let wake = () => {};
  let signalled = false;
  const onSignal = () => {
    signalled = true;
    e.stopping = true;
    wake();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  for (;;) {
    const t0 = Date.now();
    try {
      await e.tick();
    } catch (err) {
      logf("tick failed: %s", err instanceof Error ? (err.stack ?? err.message) : err);
    }
    if (!signalled) {
      const d = Math.max(0, Math.min(e.pollMS, tickMS) - (Date.now() - t0));
      await new Promise<void>((res) => {
        wake = res;
        setTimeout(res, d);
      });
    }
    if (signalled) {
      await e.stop();
      return 0;
    }
  }
}
