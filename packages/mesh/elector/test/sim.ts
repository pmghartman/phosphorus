// a deterministic mesh for elections: one scheduler on simulated time, each host
// a frontend (voter, view), an elector and a model of git-daemon.sh (decision
// read, forgejo up on the master alone, the watchdog fencing on a lapsed lease,
// a servant pulling every few seconds, a final pull on handoff); partitions,
// crashes and skewed clocks between them
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Call,
  type Claim,
  type Clock,
  type Decision,
  Elector,
  type Group,
  type Local,
  type Roster,
  type Timing,
  Voter,
} from "@phosphorus/elector";

export const simTiming: Timing = {
  tickMS: 500,
  leaseMS: 4000,
  leaseMarginMS: 1500,
  promoteGrace: 2,
  addAfterMS: 3000,
  removeAfterMS: 300000,
  holdMS: 15000,
  witnessMS: 60000,
  vouchMS: 120000,
  handoffMaxAgeMS: 30000,
};

// mulberry32
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Timer = { at: number; seq: number; fn: () => void };

// the git data a host holds: gen and stamp as GIT_VERSION, writes the pushes it has
type Data = { gen: number; stamp: number; writes: number };

const daemonTick = 250;
const replicateMS = 5000;
const inSyncMS = 30000;
const decisionMaxAgeMS = 2000;
const watchdogMS = 200;
const pullMS = 300;
const claimMaxAgeMS = 3000;
const publishMS = 250;

export class Host {
  alive = false;
  life = 0;
  crashedAt = 0;
  e!: Elector;
  voter!: Voter;
  // the elector's files that outlive a crash
  roster?: Roster;
  claim?: { c: Record<string, unknown>; at: number };
  handoffReq?: { to: string; at: number };
  updating = false;
  bootId = "";
  published?: Record<string, any>;

  // git-daemon.sh's
  data: Data = { gen: 0, stamp: 0, writes: 0 };
  snap: Data = { gen: 0, stamp: 0, writes: 0 };
  decision?: Decision;
  amMaster = false;
  promoting = false;
  authoritative = "";
  forgejo = false;
  lastGood = 0;
  lastRepl = -1e12;
  pulling = false;
  force = false;
  // set when this host promoted: the data it started leading on
  ledFrom?: Data;

  constructor(
    public sim: Sim,
    public name: string,
    // the monotonic and wall clocks: an offset and a rate against sim time
    public monoOff: number,
    public wallOff: number,
    public rate: number,
    public candidate = true,
  ) {}

  mono = () => Math.round(this.monoOff + this.sim.t * this.rate);
  wall = () => Math.round(this.wallOff + this.sim.t * this.rate);
  secs = () => Math.floor(this.wall() / 1000);

  // a wait on this host's clock, never ending once it crashed
  sleep = (ms: number): Promise<void> => {
    const life = this.life;
    return new Promise((res) =>
      this.sim.at(Math.max(1, Math.ceil(ms / this.rate)), () => {
        if (this.alive && this.life === life) res();
      }),
    );
  };

  local = (): Local => {
    const inSync = this.amMaster || (this.lastGood > 0 && this.mono() - this.lastGood < inSyncMS);
    return { gen: this.data.gen, stamp: this.data.stamp, inSync, force: this.force };
  };

  group(): Group {
    return {
      name: "git",
      view: "/api/git/view",
      vote: "/api/git/vote",
      flag: "gitHost",
      local: this.local,
      up: () => this.forgejo,
      decide: (d) => (this.decision = d),
      claim: (c) => (this.claim = c ? { c, at: this.sim.t } : undefined),
      roster: () => this.roster,
      saveRoster: (r) => (this.roster = r),
      handoff: () => {
        const r = this.handoffReq;
        this.handoffReq = undefined;
        return r;
      },
    };
  }

  state(): Record<string, any> {
    const c = this.claim && this.sim.t - this.claim.at <= claimMaxAgeMS ? this.claim.c : null;
    return {
      host: this.name,
      gitHost: this.candidate,
      roster: this.voter.roster,
      claim: c,
      updating: this.updating,
      bootId: this.bootId,
    };
  }

  view() {
    const states = [this.state()];
    const offlineMs: Record<string, number> = {};
    for (const p of this.sim.hosts.values()) {
      if (p === this) continue;
      if (!p.alive) offlineMs[p.name] = this.sim.t - p.crashedAt;
      else if (this.sim.linked(this.name, p.name) && p.published) states.push(p.published);
    }
    return { pollMs: 500, states, offlineMs };
  }

  boot() {
    this.alive = true;
    this.life++;
    this.bootId = `${this.name}-${this.life}`;
    const clock: Clock = { mono: this.mono, wall: this.wall, sleep: this.sleep };
    this.voter = new Voter(join(this.sim.dir, `${this.name}-roster.json`), this.wall(), this.wall);
    this.e = new Elector(this.name, this.sim.call(this), this.group(), clock, this.sim.timing);
    this.e.addr = () => this.name;
    this.amMaster = this.promoting = this.forgejo = this.pulling = false;
    this.authoritative = "";
    this.lastGood = 0;
    this.decision = undefined;
    this.e.start();
    const life = this.life;
    const loop = async () => {
      while (this.alive && this.life === life) {
        await this.e.tick();
        await this.sleep(this.sim.timing.tickMS + Math.floor(this.sim.rand() * 40));
      }
    };
    const daemon = async () => {
      while (this.alive && this.life === life) {
        this.daemonTick();
        await this.sleep(daemonTick);
      }
    };
    const watchdog = async () => {
      while (this.alive && this.life === life) {
        if (this.forgejo && !this.leaseValid()) {
          this.sim.log(`${this.name}: watchdog fenced forgejo`);
          this.forgejo = false;
          this.sim.fenced++;
        }
        await this.sleep(watchdogMS);
      }
    };
    const publish = async () => {
      while (this.alive && this.life === life) {
        this.published = this.state();
        await this.sleep(publishMS);
      }
    };
    void loop();
    void daemon();
    void watchdog();
    void publish();
  }

  crash() {
    this.sim.log(`${this.name}: crash`);
    this.alive = false;
    this.crashedAt = this.sim.t;
    this.forgejo = false;
    this.published = undefined;
    this.amMaster = false;
  }

  // a clean stop as git-daemon.sh's term: forgejo down, then the elector handing off
  async shutdown() {
    const life = this.life;
    this.stopForgejo();
    this.e.stopping = true;
    await this.e.stop();
    if (this.life === life) this.crash();
  }

  leaseValid = () => (this.decision?.leaseUntil ?? 0) > this.mono();

  private stepDown() {
    this.sim.log(`${this.name}: no longer master`);
    this.amMaster = false;
    this.promoting = false;
    this.authoritative = "";
    this.stopForgejo();
  }

  private stopForgejo() {
    if (!this.forgejo) return;
    this.forgejo = false;
    this.snapshot();
  }

  private snapshot() {
    this.snap = { ...this.data, stamp: this.secs() };
    this.data.stamp = this.snap.stamp;
  }

  // a copy of from's snapshot, landing pullMS later; done(ok)
  private pull(from: string, done: (ok: boolean) => void) {
    this.pulling = true;
    const life = this.life;
    this.sim.at(pullMS, () => {
      if (!this.alive || this.life !== life) return;
      this.pulling = false;
      const src = this.sim.hosts.get(from);
      // rsyncd refusing while the source is promoting
      if (!src?.alive || src.promoting || !this.sim.linked(this.name, from)) return done(false);
      this.data = { ...src.snap };
      done(true);
    });
  }

  private daemonTick() {
    let d = this.decision;
    if (d && this.mono() - d.at > decisionMaxAgeMS) d = undefined;
    const role = d?.role ?? "none";
    if (role === "master") {
      if (!this.amMaster) {
        this.sim.log(`${this.name}: elected master (gen ${d!.gen})${d!.from ? ", final pull from " + d!.from : ""}`);
        this.data.gen = d!.gen;
        this.force = false;
        this.amMaster = true;
        this.promoting = true;
        this.authoritative = this.name;
        if (d!.from) {
          const gen = d!.gen;
          this.pull(d!.from, () => {
            this.data.gen = gen;
            this.beginLeading();
          });
          return;
        }
        this.beginLeading();
      }
      if (this.promoting) return;
      if (!this.forgejo && this.leaseValid()) {
        this.forgejo = true;
        this.sim.up(this);
      }
    } else if (role === "servant") {
      if (this.amMaster) this.stepDown();
      this.authoritative = d!.master;
    } else {
      if (this.amMaster) this.stepDown();
      this.authoritative = "";
    }
    // a push landing on a serving master
    if (this.forgejo) this.data.writes++;
    this.replicate();
  }

  private beginLeading() {
    if (!this.alive) return;
    this.data.stamp = this.secs();
    this.promoting = false;
    this.ledFrom = { ...this.data };
    this.sim.promoted(this);
  }

  private replicate() {
    if (this.promoting || this.pulling) return;
    if (this.mono() - this.lastRepl < replicateMS) return;
    this.lastRepl = this.mono();
    if (this.amMaster) this.snapshot();
    else if (this.authoritative)
      this.pull(this.authoritative, (ok) => {
        if (ok) this.lastGood = this.mono();
      });
  }
}

export class Sim {
  t = 0;
  seq = 0;
  timers: Timer[] = [];
  hosts = new Map<string, Host>();
  cuts = new Set<string>();
  dir = mkdtempSync(join(tmpdir(), "phos-sim-"));
  rand: () => number;
  lines: string[] = [];
  fenced = 0;
  // every promotion in order: host, gen, the data it led on
  promotions: { host: string; gen: number; at: number; writes: number }[] = [];
  violations: string[] = [];

  constructor(
    seed: number,
    public timing: Timing = simTiming,
  ) {
    this.rand = rng(seed);
  }

  log(s: string) {
    this.lines.push(`${(this.t / 1000).toFixed(2)}s ${s}`);
  }

  add(name: string, o: { monoOff?: number; wallOff?: number; rate?: number; candidate?: boolean } = {}) {
    const h = new Host(this, name, o.monoOff ?? 1e6, o.wallOff ?? 1.7e12, o.rate ?? 1, o.candidate ?? true);
    this.hosts.set(name, h);
    return h;
  }

  at(ms: number, fn: () => void) {
    const t: Timer = { at: this.t + ms, seq: this.seq++, fn };
    let lo = 0,
      hi = this.timers.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const m = this.timers[mid]!;
      if (m.at < t.at || (m.at === t.at && m.seq < t.seq)) lo = mid + 1;
      else hi = mid;
    }
    this.timers.splice(lo, 0, t);
  }

  key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  linked = (a: string, b: string) => a === b || !this.cuts.has(this.key(a, b));
  cut(a: string, b: string) {
    this.cuts.add(this.key(a, b));
  }
  // a cut off from every other host
  isolate(a: string) {
    for (const b of this.hosts.keys()) if (b !== a) this.cut(a, b);
  }
  heal() {
    this.cuts.clear();
  }

  // one host's frontend requests: to self, or to a peer it can reach
  call(from: Host): Call {
    return async (to, method, path, body) => {
      const h = this.hosts.get(to);
      if (!h) return undefined;
      if (!from.alive || !h.alive || !this.linked(from.name, h.name)) return undefined;
      if (method === "GET" && path === "/api/git/view") return h.view();
      if (method === "POST" && path === "/api/git/vote") {
        const [st, out] = h.voter.vote(body as Record<string, any>);
        return st === 200 ? out : undefined;
      }
      return undefined;
    };
  }

  up(h: Host) {
    this.log(`${h.name}: forgejo up`);
    this.check();
  }

  promoted(h: Host) {
    const last = this.promotions[this.promotions.length - 1];
    if (last && h.data.gen <= last.gen)
      this.violations.push(`${h.name} led on gen ${h.data.gen}, not past ${last.host}'s ${last.gen}`);
    this.promotions.push({ host: h.name, gen: h.data.gen, at: this.t, writes: h.data.writes });
  }

  serving = () => [...this.hosts.values()].filter((h) => h.alive && h.forgejo).map((h) => h.name);

  check() {
    const up = this.serving();
    if (up.length > 1) this.violations.push(`${(this.t / 1000).toFixed(2)}s: ${up.join(" and ")} both serving`);
  }

  master = () => {
    const up = this.serving();
    return up.length === 1 ? up[0]! : "";
  };

  // the scheduler run to t+ms, every timer's promises settled before the next
  async run(ms: number) {
    const end = this.t + ms;
    while (this.timers.length && this.timers[0]!.at <= end) {
      const tm = this.timers.shift()!;
      this.t = tm.at;
      tm.fn();
      // every promise the timer set going settled: calls answer at once, so a
      // few hundred hops cover the deepest await chain
      for (let i = 0; i < 200; i++) await Promise.resolve();
      this.check();
    }
    this.t = end;
  }

  // run until pred holds, the time it took, -1 never within ms
  async until(pred: () => boolean, ms: number): Promise<number> {
    const start = this.t;
    while (this.t - start < ms) {
      if (pred()) return this.t - start;
      await this.run(100);
    }
    return pred() ? this.t - start : -1;
  }

  writes = (h: string) => this.hosts.get(h)!.data.writes;
}

export type { Claim };
