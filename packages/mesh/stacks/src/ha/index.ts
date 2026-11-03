// failover for installed services: each stack with standbys an election group
// (stack-<id>), every mesh host voting, its active host and standbys the
// candidates. The winner's lease is what Runtime.up runs under, a watchdog
// stopping it once the lease lapses; the active snapshots data/ between the
// manifest's hooks, standbys pull it every few seconds; promotion moves the
// copy into data/, starts the stack and makes this host the want's active.
// A former active coming back never runs its old copy: it is set aside as
// data.orphan-<gen> and the host rejoins as a standby. Runs in the frontend,
// which answers the group's votes and serves its snapshot.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type Call,
  type Clock,
  type Decision,
  fileStore,
  type Group,
  Groups,
  groupRe,
  type Local,
  type Roster,
  realClock,
  type Timing,
  timing,
  Voter,
} from "@phosphorus/elector";
import { errText, logf as log, obj, writeFileAtomic } from "@phosphorus/util";
import type { StackRole, StackStatus, StackWant } from "@phosphorus/wire";
import { idRe } from "../ids.ts";
import type { Runtime } from "../index.ts";
import {
  cleanRel,
  type Fetch,
  install,
  linkTree,
  type Manifest,
  mirror,
  orphan,
  type Paths,
  paths,
  pullInto,
  readMap,
  readVersion,
  signature,
  walk,
  writeJSON,
  writeVersion,
} from "./copy.ts";

export type { Entry, Manifest } from "./copy.ts";

const prefix = "stack-";
export const groupOf = (id: string) => prefix + id;
export const idOf = (g: string) =>
  g.startsWith(prefix) && idRe.test(g.slice(prefix.length)) ? g.slice(prefix.length) : "";

const nameRe = /^[A-Za-z0-9-]{1,63}$/;
// a decision older than this: the elector stalled, stand down
const decisionMaxAgeMS = 2000;
const replicateMS = 5000;
const inSyncMS = 30000;
// an unchanged token still pulled whole this often
const fullPullMS = 60000;
const claimMaxAgeMS = 3000;
const keepDownMS = 15000;
const retryUpMS = 5000;
const watchdogMS = 200;
const stepMS = 250;
// a frontend's lazily made voters, at most
const maxVoters = 256;

const logf = (fmt: string, ...a: unknown[]) => log("[ha] " + fmt, ...a);

// what failover needs of the frontend it runs in
export interface Mesh {
  self: string;
  // electors' and voters' rosters
  stateDir: string;
  wants(): Record<string, StackWant>;
  setWant(id: string, w: StackWant): void;
  // each live peer's published ha states, by group
  peers(): Record<string, Record<string, any>>;
  offlineMs(): Record<string, number>;
  pollMs(): number;
  updating(): boolean;
  bootId(): string;
  // a notice on every admin's pages
  notify(title: string, body: string): void;
  // a peer frontend's JSON on a 200
  call: Call;
  // a peer's snapshot file written to file, false when it failed
  fetchFile(host: string, group: string, path: string, file: string): Promise<boolean>;
  // this host's published state moved, for its peers at once
  changed?: () => void;
  clock?: Clock;
  timing?: Timing;
}

const candidates = (w: StackWant) => [w.active, ...w.standbys].filter(Boolean);
const withStandbys = (w: StackWant | undefined) => !!w && Array.isArray(w.standbys) && w.standbys.length > 0;
const uniq = (xs: string[]) => [...new Set(xs)];
const ago = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)} min`);

// one stack on one candidate host: its election's I/O and the acting on it,
// as git-daemon.sh does for git
export class Replica implements Group {
  name: string;
  view: string;
  vote: string;
  flag = "candidate";
  p: Paths;
  private files: ReturnType<typeof fileStore>;
  claimed?: { c: Record<string, unknown>; at: number };
  handoffReq?: { to: string; at: number };
  decision?: Decision;

  amMaster = false;
  promoting = false;
  authoritative = "";
  state: "down" | "starting" | "up" | "stopping" = "down";
  fenced = false;
  fencing?: Promise<void>;
  disposed = false;
  lastGood = 0;
  lastRepl = -Infinity;
  lastKeepDown = -Infinity;
  lastUpTry = -Infinity;
  // wall ms: a standby's last whole copy, the active's last snapshot
  lastSync = 0;
  // the want gen this host's project is rendered from, and the active's
  appGen = 0;
  masterApp = 0;
  // the data's signature after the last snapshot, and each snapshotted file's source version
  private lastSig = "";
  private sigs: Record<string, string> = {};
  private chain: Promise<void> = Promise.resolve();
  private busy = false;

  constructor(
    public ha: HA,
    public id: string,
    public rt: Runtime,
  ) {
    this.name = groupOf(id);
    this.view = `/api/ha/${this.name}/view`;
    this.vote = `/api/ha/${this.name}/vote`;
    this.p = paths(rt.dataDir(id));
    this.files = fileStore(join(ha.m.stateDir, "ha"), this.name);
  }

  private now = () => this.ha.clock.mono();
  private wall = () => this.ha.clock.wall();
  want = () => this.ha.m.wants()[this.id];
  version = () => readVersion(this.p.version);
  leaseValid = () => (this.decision?.leaseUntil ?? 0) > this.now();

  // --- the elector's side ------------------------------------------------------

  local(): Local {
    const v = this.version();
    const w = this.want();
    // a first install: the want's active holds the only data there is
    const fresh = !v && w?.active === this.ha.m.self;
    const inSync = this.amMaster || fresh || (this.lastGood > 0 && this.now() - this.lastGood < inSyncMS);
    return { gen: v?.gen ?? 0, stamp: v?.stamp ?? 0, inSync, force: false };
  }

  up = () => !this.disposed && this.state !== "down";

  decide(d: Decision) {
    if (this.disposed) return;
    this.decision = d;
  }

  claim(c: Record<string, unknown> | undefined) {
    const moved = JSON.stringify(c) !== JSON.stringify(this.claimed?.c);
    this.claimed = c ? { c, at: this.now() } : undefined;
    if (moved) this.ha.m.changed?.();
  }

  roster = () => this.files.roster();
  saveRoster = (r: Roster) => this.files.saveRoster(r);

  handoff() {
    const r = this.handoffReq;
    this.handoffReq = undefined;
    return r;
  }

  blocked(): string {
    const w = this.want();
    if (!this.version() && w?.active !== this.ha.m.self) return "no copy of the data yet";
    const ref = this.masterApp;
    if (ref && this.appGen !== ref) return `this host's copy is at app gen ${this.appGen}, the active's at ${ref}`;
    return "";
  }

  claimNow = () => (this.claimed && this.now() - this.claimed.at <= claimMaxAgeMS ? this.claimed.c : null);

  // --- acting on the decision --------------------------------------------------

  // one step at a time, a slow one never overlapped
  kick() {
    if (this.busy || this.disposed) return;
    this.busy = true;
    this.chain = this.chain
      .then(() => this.step())
      .catch((e) => logf("%s: %s", this.id, errText(e)))
      .finally(() => {
        this.busy = false;
      });
  }

  idle = () => this.chain;

  async step() {
    if (this.disposed) return;
    try {
      this.appGen = await this.rt.gen(this.id);
    } catch {}
    this.noteMaster();
    let d = this.decision;
    if (d && this.now() - d.at > decisionMaxAgeMS) d = undefined;
    const role = d?.role ?? "none";
    if (role === "master") {
      if (!this.amMaster) await this.elected(d!);
      if (this.promoting || this.disposed) return;
      if (this.state === "down" && this.leaseValid() && this.now() - this.lastUpTry >= retryUpMS) await this.start();
    } else {
      if (this.amMaster) await this.stepDown();
      this.authoritative = role === "servant" ? d!.master : "";
      // stopped before its data moves: a former active's app may still be up
      await this.keepDown();
      if (role === "servant") this.setAside();
    }
    await this.replicate();
  }

  // the app gen of whoever leads, from its published state
  private noteMaster() {
    for (const s of this.ha.states(this.name)) {
      const c = obj(s.claim);
      if (c?.role === "master" && s.host !== this.ha.m.self && typeof s.app === "number" && s.app > 0)
        this.masterApp = s.app;
    }
  }

  private async elected(d: Decision) {
    const prev = this.want()?.active ?? "";
    logf("%s: elected active (gen %d)%s", this.id, d.gen, d.from ? `, final pull from ${d.from}` : "");
    this.amMaster = true;
    this.promoting = true;
    this.fenced = false;
    this.authoritative = this.ha.m.self;
    let pulled = false;
    if (d.from) {
      pulled = await this.pull(d.from, true);
      if (!pulled) logf("%s: final pull from %s failed, leading on the last copy", this.id, d.from);
    }
    if (this.disposed) return;
    const copy = readMap(this.p.copyJSON) as Record<string, any>;
    if (install(this.p)) logf("%s: the copy from %s is the live data now", this.id, prev || "the last active");
    const stamp = Math.floor(this.wall() / 1000);
    writeVersion(this.p.version, d.gen, stamp);
    writeFileAtomic(this.p.led, `${d.gen}\n`);
    this.lastSig = "";
    this.sigs = {};
    this.promoting = false;
    this.makeActive(d, prev, typeof copy?.at === "number" ? copy.at : 0, pulled);
  }

  // the want's active this host, the one it replaced a standby; admins told
  private makeActive(d: Decision, prev: string, copyAt: number, finalPull: boolean) {
    const self = this.ha.m.self;
    const w = this.want();
    if (!w) return;
    if (w.active !== self) {
      const standbys = uniq([...w.standbys.filter((h) => h !== self), ...(w.active ? [w.active] : [])]);
      this.ha.m.setWant(this.id, { ...w, active: self, standbys, at: this.wall() });
    }
    if (!prev || prev === self) return;
    const name = w.def?.name || this.id;
    const how =
      d.from && finalPull
        ? `handed over by ${prev}, nothing lost`
        : `${prev} stopped answering; ${self} took over from its copy of ${copyAt ? ago(this.wall() - copyAt) + " ago" : "the last sync"}`;
    this.ha.m.notify(`${name} moved to ${self}`, how);
  }

  private async start() {
    this.lastUpTry = this.now();
    this.state = "starting";
    try {
      await this.rt.up(this.id);
      if (this.state === "starting") {
        this.state = "up";
        logf("%s: up as the active copy", this.id);
      } else {
        // fenced while it came up: down again, the fence's stop may have run first
        await this.rt.down(this.id).catch(() => {});
        this.state = "down";
      }
    } catch (e) {
      if (this.state === "starting") this.state = "down";
      logf("%s: couldn't start: %s", this.id, errText(e));
    }
  }

  // stopped, then its last writes snapshotted for the successor's final pull
  async stepDown() {
    logf("%s: no longer active, stopping it", this.id);
    this.amMaster = false;
    this.promoting = false;
    this.authoritative = "";
    if (this.fencing) await this.fencing;
    else if (this.state !== "down") {
      this.state = "stopping";
      try {
        await this.rt.down(this.id);
      } catch (e) {
        logf("%s: couldn't stop: %s", this.id, errText(e));
      }
      await this.snapshot(false);
      this.state = "down";
    }
  }

  // the watchdog's: a lapsed lease stops the app at once
  fence() {
    if (this.disposed || this.fenced || this.state === "down" || this.state === "stopping" || this.leaseValid()) return;
    this.fenced = true;
    this.state = "stopping";
    logf("%s: lease ran out, watchdog stopping it", this.id);
    // its last writes snapshotted, for a successor's final pull
    this.fencing = this.rt
      .down(this.id)
      .catch((e) => logf("%s: couldn't stop: %s", this.id, errText(e)))
      .then(() => this.snapshot(false))
      .catch(() => {})
      .finally(() => {
        if (this.state === "stopping") this.state = "down";
        this.fencing = undefined;
      });
  }

  // following another host: data this host last led on set aside, never run again
  private setAside() {
    if (!existsSync(this.p.led)) return;
    const gen = Number(readFileSync(this.p.led, "utf8").trim()) || 0;
    const where = orphan(this.p, gen);
    rmSync(this.p.led, { force: true });
    rmSync(this.p.version, { force: true });
    logf("%s: following %s, this host's data from gen %d kept aside as %s", this.id, this.authoritative, gen, where);
  }

  // not the active: never running, a former active's leftovers stopped
  private async keepDown() {
    if (this.state !== "down" || this.now() - this.lastKeepDown < keepDownMS) return;
    this.lastKeepDown = this.now();
    let on = false;
    try {
      on = await this.rt.running(this.id);
    } catch {}
    if (!on) return;
    logf("%s: running here but not the active copy, stopping it", this.id);
    try {
      await this.rt.down(this.id);
    } catch (e) {
      logf("%s: couldn't stop: %s", this.id, errText(e));
    }
  }

  private async replicate() {
    if (this.promoting || this.now() - this.lastRepl < replicateMS) return;
    if (this.amMaster && this.state === "up") {
      this.lastRepl = this.now();
      await this.snapshot(true);
    } else if (!this.amMaster && this.authoritative) {
      this.lastRepl = this.now();
      if (await this.pull(this.authoritative, false)) this.lastGood = this.now();
    }
  }

  // data/ copied consistently into the snapshot, the hooks around it when the
  // app runs; skipped while unchanged
  async snapshot(running: boolean): Promise<boolean> {
    if (!existsSync(this.p.data)) return false;
    if (this.lastSig && signature(walk(this.p.data)) === this.lastSig && existsSync(this.p.snapJSON)) return true;
    if (running)
      try {
        await this.rt.hook(this.id, "pre");
      } catch (e) {
        logf("%s: backup.pre failed, standbys keep the last snapshot: %s", this.id, errText(e));
        return false;
      }
    const moved = mirror(this.p.data, this.p.snap, this.sigs);
    if (running)
      try {
        await this.rt.hook(this.id, "post");
      } catch (e) {
        logf("%s: backup.post failed: %s", this.id, errText(e));
      }
    this.lastSig = signature(walk(this.p.data));
    if (!moved && existsSync(this.p.snapJSON)) return true;
    const v = this.version();
    const stamp = Math.floor(this.wall() / 1000);
    const man: Manifest = {
      token: `${this.ha.m.self}-${stamp}-${Math.random().toString(36).slice(2, 10)}`,
      gen: v?.gen ?? 0,
      stamp,
      app: this.appGen,
      files: walk(this.p.snap),
    };
    writeJSON(this.p.snapJSON, man);
    writeVersion(this.p.version, man.gen, stamp);
    this.lastSync = this.wall();
    return true;
  }

  // the snapshot as offered, none while promoting
  manifest(): Manifest | undefined {
    if (this.promoting) return;
    try {
      return JSON.parse(readFileSync(this.p.snapJSON, "utf8"));
    } catch {
      return;
    }
  }

  // from's snapshot into the staging tree, then the copy once whole under one
  // token; an unchanged token skipped unless full
  async pull(from: string, full: boolean): Promise<boolean> {
    const man = await this.ha.manifestOf(from, this.name);
    if (!man) return false;
    const had = obj(readMap(this.p.copyJSON));
    if (!full && had?.token === man.token && this.wall() - Number(had.at) < fullPullMS) {
      this.lastSync = this.wall();
      return true;
    }
    const index = readMap(this.p.pullJSON);
    const fetch: Fetch = (path, file) => this.ha.m.fetchFile(from, this.name, path, file);
    const ok = await pullInto(this.p.pull, man, index, fetch);
    writeJSON(this.p.pullJSON, index);
    if (!ok) return false;
    const again = await this.ha.manifestOf(from, this.name);
    if (again?.token !== man.token) return false;
    linkTree(this.p.pull, this.p.copy);
    writeJSON(this.p.copyJSON, { token: man.token, gen: man.gen, stamp: man.stamp, app: man.app, at: this.wall() });
    writeVersion(this.p.version, man.gen, man.stamp);
    if (man.app > 0) this.masterApp = man.app;
    this.lastSync = this.wall();
    return true;
  }

  role(): StackRole {
    return this.amMaster ? "active" : "standby";
  }

  // gone from failover: the app left as it is, for the runtime's reconcile
  dispose() {
    this.disposed = true;
  }
}

// the frontend's failover: voters for every group asked, a replica and an
// elector for each stack this host is a candidate for
export class HA {
  voters = new Map<string, Voter>();
  replicas = new Map<string, Replica>();
  groups: Groups;
  clock: Clock;
  t: Timing;
  rt?: Runtime;
  private timers: ReturnType<typeof setInterval>[] = [];
  private started: number;

  constructor(public m: Mesh) {
    this.clock = m.clock ?? realClock;
    this.t = m.timing ?? timing();
    this.started = this.clock.wall();
    this.groups = new Groups(m.self, this.call, this.clock, () => m.self);
  }

  // the electors' requests: self's answered here, a peer's over the tailnet
  call: Call = async (host, method, path, body) => {
    if (host !== this.m.self) return this.m.call(host, method, path, body);
    const m = /^\/api\/ha\/([a-z0-9-]+)\/(view|vote)$/.exec(path);
    if (!m) return undefined;
    if (m[2] === "view") return this.view(m[1]!);
    const [st, out] = this.vote(m[1]!, obj(body) ?? {});
    return st === 200 ? out : undefined;
  };

  // --- what every host answers ---------------------------------------------------

  private voter(g: string): Voter | undefined {
    let v = this.voters.get(g);
    if (v) return v;
    if (!groupRe.test(g) || this.voters.size >= maxVoters) return;
    v = new Voter(join(this.m.stateDir, "ha", `${g}-roster.json`), this.started, this.clock.wall);
    this.voters.set(g, v);
    return v;
  }

  vote(g: string, p: Record<string, any>): [number, any] {
    const v = this.voter(g);
    if (!v) return [404, { error: "no such group" }];
    return v.vote(p);
  }

  // the groups this host publishes: every stack with standbys
  private wanted(): Map<string, StackWant> {
    const out = new Map<string, StackWant>();
    for (const [id, w] of Object.entries(this.m.wants())) if (idRe.test(id) && withStandbys(w)) out.set(groupOf(id), w);
    return out;
  }

  state(g: string, w: StackWant): Record<string, any> {
    const r = this.replicas.get(g);
    return {
      host: this.m.self,
      candidate: !!this.rt && candidates(w).includes(this.m.self),
      roster: this.voter(g)?.roster ?? null,
      claim: r?.claimNow() ?? null,
      updating: this.m.updating(),
      bootId: this.m.bootId(),
      app: r?.appGen ?? 0,
      lastSync: r?.lastSync ?? 0,
    };
  }

  // this host's state in each group, for its peers
  own(): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [g, w] of this.wanted()) out[g] = this.state(g, w);
    return out;
  }

  // self's and every live peer's state in g
  states(g: string): Record<string, any>[] {
    const w = this.wanted().get(g);
    const out: Record<string, any>[] = w ? [this.state(g, w)] : [];
    for (const [h, gs] of Object.entries(this.m.peers())) {
      const s = obj(obj(gs)?.[g]);
      if (s && s.host === h && nameRe.test(h)) out.push(s);
    }
    return out;
  }

  view(g: string) {
    return { states: this.states(g), pollMs: this.m.pollMs(), offlineMs: this.m.offlineMs() };
  }

  // who leads g as its published claims say
  leader(g: string): string {
    for (const s of this.states(g)) if (obj(s.claim)?.role === "master") return String(s.host);
    return "";
  }

  manifest(g: string): Manifest | undefined {
    return this.replicas.get(g)?.manifest();
  }

  // a snapshot file's path, undefined unless it is one
  file(g: string, p: string): string | undefined {
    const r = this.replicas.get(g);
    const rel = cleanRel(p);
    if (!r || !rel || r.promoting) return;
    const f = join(r.p.snap, rel);
    try {
      return statSync(f).isFile() ? f : undefined;
    } catch {
      return;
    }
  }

  async manifestOf(host: string, g: string): Promise<Manifest | undefined> {
    const v = host === this.m.self ? this.manifest(g) : await this.m.call(host, "GET", `/api/ha/${g}/snap`);
    const o = obj(v);
    if (!o || typeof o.token !== "string" || !Array.isArray(o.files)) return;
    return o as Manifest;
  }

  // --- this host's replicas --------------------------------------------------------

  attach(rt: Runtime) {
    this.rt = rt;
    this.sync();
  }

  // replicas and electors brought to the wants
  sync() {
    const want = this.wanted();
    for (const [g, r] of [...this.replicas]) {
      const w = want.get(g);
      if (w && this.rt && candidates(w).includes(this.m.self)) continue;
      this.replicas.delete(g);
      void this.drop(r);
    }
    if (!this.rt) return;
    for (const [g, w] of want) {
      if (this.replicas.has(g) || !candidates(w).includes(this.m.self)) continue;
      const r = new Replica(this, g.slice(prefix.length), this.rt);
      this.replicas.set(g, r);
      this.groups.add(r, this.t);
      logf("%s: a candidate here, %s", r.id, w.active === this.m.self ? "the want's active" : "a standby");
    }
  }

  // a stack no longer failing over here: a host dropped from its candidates
  // stops it, a want without standbys (or gone) leaves it to the runtime
  private async drop(r: Replica) {
    const dropped = withStandbys(r.want());
    if (!dropped) r.dispose();
    const stopping = dropped && r.up() ? r.stepDown() : undefined;
    await this.groups.remove(r.name);
    await stopping;
    r.dispose();
  }

  step() {
    this.sync();
    for (const r of this.replicas.values()) r.kick();
  }

  watchdog() {
    for (const r of this.replicas.values()) r.fence();
  }

  start() {
    this.timers.push(setInterval(() => this.step(), stepMS));
    this.timers.push(setInterval(() => this.watchdog(), watchdogMS));
  }

  // every active stack handed to a standby, its final pull still served here
  async stop(waitMS = 10000) {
    const led = [...this.replicas.values()].filter((r) => r.amMaster).map((r) => r.name);
    await this.groups.stopAll();
    const end = this.clock.mono() + waitMS;
    while (this.clock.mono() < end && led.some((g) => this.leader(g) === "" || this.leader(g) === this.m.self))
      await this.clock.sleep(200);
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  // this host serving id as its active copy: its published row the master one
  leads(id: string): boolean {
    const r = this.replicas.get(groupOf(id));
    return !!r && r.amMaster && r.state === "up";
  }

  // --- what an admin asks ----------------------------------------------------------

  // failover's part of this host's status for a stack: the docker side's own
  // running and health left to the runtime
  status(id: string): Pick<StackStatus, "role" | "gen" | "lastSync"> | undefined {
    const r = this.replicas.get(groupOf(id));
    if (!r) return;
    const s: Pick<StackStatus, "role" | "gen" | "lastSync"> = { role: r.role(), gen: r.appGen };
    if (r.lastSync) s.lastSync = r.lastSync;
    return s;
  }

  // the standbys an admin picked, the want's gen bumped
  setStandbys(id: string, standbys: unknown, by: string): [number, any] {
    const w = this.m.wants()[id];
    if (!w) return [404, { error: `no stack ${id}` }];
    if (!Array.isArray(standbys) || standbys.some((h) => typeof h !== "string" || !nameRe.test(h)))
      return [400, { error: "standbys must be host names" }];
    const list = uniq(standbys as string[]).filter((h) => h !== w.active);
    const next: StackWant = { ...w, standbys: list, gen: w.gen + 1, by, at: this.clock.wall() };
    this.m.setWant(id, next);
    this.sync();
    return [200, { ok: true, want: next }];
  }

  // a handoff asked of this host, the active one
  askHandoff(g: string, to: unknown): [number, any] {
    const r = this.replicas.get(g);
    if (!r?.amMaster) return [409, { error: `${this.m.self} isn't the active copy` }];
    if (typeof to !== "string" || !nameRe.test(to)) return [400, { error: "bad target" }];
    r.handoffReq = { to, at: this.clock.wall() };
    return [200, { ok: true }];
  }

  // a planned handoff to to: the active stops, to pulls one last time and
  // takes over; done once to leads
  async move(id: string, to: unknown, settleMS = 60000): Promise<[number, any]> {
    const w = this.m.wants()[id];
    if (!w) return [404, { error: `no stack ${id}` }];
    if (typeof to !== "string" || !nameRe.test(to)) return [400, { error: "bad target" }];
    const g = groupOf(id);
    const lead = this.leader(g);
    if (lead === to) return [200, { ok: true, note: "already active" }];
    if (!w.standbys.includes(to)) return [409, { error: `${to} isn't a standby of ${id}` }];
    if (!lead) return [409, { error: `no host leads ${id} right now` }];
    const target = this.states(g).find((s) => s.host === to);
    const c = obj(target?.claim);
    if (!c || c.role !== "servant" || c.master !== lead || c.eligible !== true)
      return [409, { error: `${to} isn't in sync with ${lead} yet` }];
    const [st, out] =
      lead === this.m.self
        ? this.askHandoff(g, to)
        : await this.m
            .call(lead, "POST", `/api/ha/${g}/handoff`, { to })
            .then((r): [number, any] => (r ? [200, r] : [502, { error: `${lead} didn't take the handoff` }]));
    if (st !== 200) return [st, out];
    const end = this.clock.mono() + settleMS;
    while (this.clock.mono() < end) {
      if (this.leader(g) === to) return [200, { ok: true }];
      await this.clock.sleep(500);
    }
    return [504, { error: `${to} didn't take over in ${settleMS / 1000}s` }];
  }
}

// --- the frontend's one ------------------------------------------------------------

let current: HA | undefined;
let runtime: Runtime | undefined;

// the frontend's failover, its runtime attached once there is one
export function setHA(h: HA) {
  current = h;
  if (runtime) h.attach(runtime);
}

export const ha = () => current;

// the compose runtime failover drives, from @phosphorus/stacks' reconcile
export function attach(rt: Runtime) {
  runtime = rt;
  current?.attach(rt);
}

// this host's failover status for a stack it is a candidate for
export const haStatus = (id: string) => current?.status(id);

// whether this host serves a stack as its active copy, its route the master one
export const leads = (id: string) => current?.leads(id) ?? false;
