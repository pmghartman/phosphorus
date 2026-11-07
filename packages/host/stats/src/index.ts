// this host's cpu, memory, disk, network, gpus, phosphorus's own processes by
// role and the top ones, sampled only while watched, peers fanned in, one socket each
import { cpus } from "node:os";
import { basename, join } from "node:path";
import { snapshot } from "@phosphorus/procs";
import { DataDir, FrontendPort, marshal, now, nvidiaGpus, readJSON, writeJSONAtomic } from "@phosphorus/util";
import { type Conn, dial } from "@phosphorus/wsock";
import { type CpuT, type Gpu, gpuMS, type RxTx, read, round, runes, type Sys } from "./common.ts";
import { darwin } from "./darwin.ts";
import { linux } from "./linux.ts";
import { win32 } from "./win32.ts";

export type { CpuT, Disk, Gpu, Mem, Net, RxTx, Sys } from "./common.ts";

const sampleMS = 1000;
const procMS = 2000;
const procTop = 25;
const peerRetry = 3000;
const netBucketMS = 5 * 60 * 1000;
const dayMS = 24 * 3600 * 1000;

export const sys: Sys = process.platform === "linux" ? linux : process.platform === "darwin" ? darwin : win32;
const tunnelIf = /^(wg|tun|utun|phos)/i;

// --- the last day: net totals, cpu, memory, disk and gpu in 5 minute buckets ------
// kept two days, so each hour of the last one has a whole day of net behind it

// a bucket: its end, rx and tx bytes, cpu, memory, disk and gpu percent over it, null unread
type Bucket = [number, number, number, number | null, number | null, (number | null)?, (number | null)?];
type NetDay = { boot: string; last?: Record<string, RxTx> | null; cpu?: CpuT; buckets: Bucket[]; at?: number };

const netDayFile = join(DataDir, "net-day.json");
const trendStepMS = 3600 * 1000;
const trendPoints = dayMS / trendStepMS;
const keepMS = 2 * dayMS;
let bootID = "";
let netDay: NetDay = { boot: "", buckets: [] };

function realLinks(): Record<string, RxTx> {
  const out: Record<string, RxTx> = {};
  for (const [n, v] of Object.entries(sys.netBytes().bytes)) if (!tunnelIf.test(n)) out[n] = v;
  return out;
}

// bytes moved between two readings: a counter that fell (reboot, link remade) from zero;
// a link with no earlier reading only its baseline, never its whole counter
export function netDelta(last: Record<string, RxTx> | null | undefined, cur: Record<string, RxTx>): RxTx {
  const d = { rx: 0, tx: 0 };
  for (const [n, v] of Object.entries(cur)) {
    const p = last?.[n];
    if (!p) continue;
    d.rx += v.rx >= p.rx ? v.rx - p.rx : v.rx;
    d.tx += v.tx >= p.tx ? v.tx - p.tx : v.tx;
  }
  return d;
}

const netSince = (cur: Record<string, RxTx>) => netDelta(netDay.last, cur);

const pct1 = (f: number) => Math.round(f * 1000) / 10;

// the gpus' mean load over a bucket, from the samples taken while watched
let gpuSum = 0;
let gpuN = 0;
const gpuLoad = (list: Gpu[]) => {
  const u = list.map((g) => g.util).filter((x): x is number => x !== null);
  return u.length ? u.reduce((a, x) => a + x, 0) / u.length : null;
};
function gpuNote(list: Gpu[]) {
  const u = gpuLoad(list);
  if (u === null) return;
  gpuSum += u;
  gpuN++;
}

async function netDayTick() {
  await sys.poll?.();
  const at = now();
  const cur = realLinks();
  const cpu = sys.cpuTimes()[0];
  const buckets = netDay.buckets.slice();
  if (netDay.last) {
    const d = netSince(cur);
    const was = netDay.boot === bootID ? netDay.cpu : undefined;
    const busy = cpu && was && cpu.total > was.total ? 1 - (cpu.idle - was.idle) / (cpu.total - was.total) : null;
    const m = sys.memInfo();
    const dk = sys.disk();
    // no one watching: the gpus as they read now
    const g = gpuN ? gpuSum / gpuN : gpuLoad(gpus());
    buckets.push([
      at,
      d.rx,
      d.tx,
      busy === null ? null : pct1(busy),
      m.total ? pct1(m.used / m.total) : null,
      dk.total ? pct1(dk.used / dk.total) : null,
      g === null ? null : Math.round(g * 10) / 10,
    ]);
  }
  gpuSum = 0;
  gpuN = 0;
  netDay = { boot: bootID, last: cur, cpu, buckets: buckets.filter((b) => at - b[0] < keepMS), at: netDay.at };
  writeJSONAtomic(netDayFile, netDay);
}

function netDayTotals() {
  const at = now();
  const d = netSince(realLinks());
  const day = netDay.buckets.filter((b) => at - b[0] < dayMS);
  for (const b of day) {
    d.rx += b[1];
    d.tx += b[2];
  }
  const since = day.length ? day[0]![0] - netBucketMS : (netDay.at ?? null);
  return { rx: d.rx, tx: d.tx, since };
}

// Trend the last day by the hour, oldest first, the last one still filling: rx and tx the day
// ending at each hour, cpu, memory, disk and gpu that hour's mean and highest bucket, null unread
export type Trend = {
  at: number;
  step: number;
  rx: (number | null)[];
  tx: (number | null)[];
  cpu: (number | null)[];
  mem: (number | null)[];
  disk: (number | null)[];
  gpu: (number | null)[];
  cpuPeak: (number | null)[];
  memPeak: (number | null)[];
  gpuPeak: (number | null)[];
  since: number | null;
};

export function trendOf(buckets: Bucket[], at: number): Trend {
  const end = Math.ceil(at / trendStepMS) * trendStepMS;
  const t: Trend = {
    at: end,
    step: trendStepMS,
    rx: [],
    tx: [],
    cpu: [],
    mem: [],
    disk: [],
    gpu: [],
    cpuPeak: [],
    memPeak: [],
    gpuPeak: [],
    since: null,
  };
  const got = (v: (number | null | undefined)[]) => v.filter((x): x is number => typeof x === "number");
  const mean = (v: (number | null | undefined)[]) => {
    const g = got(v);
    return g.length ? Math.round((10 * g.reduce((a, x) => a + x, 0)) / g.length) / 10 : null;
  };
  const peak = (v: (number | null | undefined)[]) => (got(v).length ? Math.max(...got(v)) : null);
  for (let k = trendPoints - 1; k >= 0; k--) {
    const h = end - k * trendStepMS;
    const w = buckets.filter((b) => b[0] <= h && b[0] > h - trendStepMS);
    const day = buckets.filter((b) => b[0] <= h && b[0] > h - dayMS);
    t.rx.push(day.length ? day.reduce((a, b) => a + b[1], 0) : null);
    t.tx.push(day.length ? day.reduce((a, b) => a + b[2], 0) : null);
    t.cpu.push(mean(w.map((b) => b[3])));
    t.mem.push(mean(w.map((b) => b[4])));
    t.disk.push(mean(w.map((b) => b[5])));
    t.gpu.push(mean(w.map((b) => b[6])));
    t.cpuPeak.push(peak(w.map((b) => b[3])));
    t.memPeak.push(peak(w.map((b) => b[4])));
    t.gpuPeak.push(peak(w.map((b) => b[6])));
  }
  if (buckets.length) t.since = buckets[0]![0] - netBucketMS;
  return t;
}

// the trend sent when it changes and every tenth sample, so a page just opened has it soon
const trendEvery = 10;
let trendSent = "";
let trendN = 0;
function trendNow(): Trend | undefined {
  const at = now();
  const sig = `${Math.ceil(at / trendStepMS)}:${netDay.buckets.at(-1)?.[0] ?? 0}`;
  if (sig === trendSent && ++trendN % trendEvery) return;
  trendSent = sig;
  trendN = 0;
  return trendOf(netDay.buckets, at);
}

// --- gpus ------------------------------------------------------------------------

// nvidia's from NVML in process, at most every gpuMS
let nvidia: Gpu[] = [];
let gpuAt = 0;

function gpus(): Gpu[] {
  if (now() - gpuAt >= gpuMS) {
    nvidia = nvidiaGpus();
    gpuAt = now();
  }
  return [...nvidia].concat(sys.vendorGpus(nvidia.length > 0));
}

// --- processes -----------------------------------------------------------------

type Row = Record<string, any>;

// parts phosphorus's own processes by role and own their total, from refreshProcs
let parts: Row[] = [];
let own: Row | null = null;
type Prev = { cpu: number; kids: number; ppid: number };
let procPrev = new Map<number, Prev>();
let jobPrev: number | undefined;
let procAt = 0;
let procList: unknown = null;

// cpu seconds over an interval as a percent of the whole machine, as the host's own cpu reads
const share = (s: number, secs: number) =>
  secs > 0 ? Math.round((1000 * Math.max(0, s)) / (secs * Math.max(1, cpus().length))) / 10 : 0;

// each figure the last few intervals' cpu seconds over their span, so a row reads
// steady and the top ones keep their places
const avgOver = 5;
let spentWas = new Map<string, [number, number][]>();
let spentNow = new Map<string, [number, number][]>();
function avg(key: string, spent: number, secs: number): number {
  const h = [...(spentWas.get(key) ?? []), [Math.max(0, spent), secs] as [number, number]].slice(-avgOver);
  spentNow.set(key, h);
  return share(
    h.reduce((a, x) => a + x[0], 0),
    h.reduce((a, x) => a + x[1], 0),
  );
}

function refreshProcs(at: number) {
  if (at - procAt < procMS) return;
  const secs = procAt ? (at - procAt) / 1000 : 0;
  procAt = at;
  const { procs, job } = snapshot();
  const cur = new Map<number, Prev>();
  for (const p of procs) cur.set(p.pid, { cpu: p.cpu, kids: p.kids, ppid: p.ppid });
  // each ended one's last figures by parent, taken off what the parent's kids grew by
  const ended = new Map<number, number>();
  for (const [pid, q] of procPrev) if (!cur.has(pid)) ended.set(q.ppid, (ended.get(q.ppid) ?? 0) + q.cpu + q.kids);
  const list: Row[] = [];
  const roles = new Map<string, Row>();
  const tot = { mem: 0, pids: 0, roles: 0, outside: 0 };
  const linuxOS = process.platform === "linux";
  for (const p of procs) {
    if (!p.rss) continue;
    const was = procPrev.get(p.pid);
    const cpu = avg(`p:${p.pid}`, was ? p.cpu - was.cpu : 0, secs);
    const row: Row = {
      pid: p.pid,
      name: linuxOS ? p.name : (p.name || basename(p.cmd)).replace(/\.exe$/, ""),
      cpu,
      mem: p.rss,
    };
    if (!linuxOS && p.cmd) row.cmd = runes(p.cmd, 300);
    if (p.role) {
      row.role = p.role;
      // its own time and its ended children's, each counted once; a new one's all of it
      const spent = !secs
        ? 0
        : was
          ? Math.max(0, p.cpu - was.cpu) + Math.max(0, p.kids - was.kids - (ended.get(p.pid) ?? 0))
          : p.cpu + p.kids;
      const r = roles.get(p.role) ?? { name: p.role, cpu: 0, mem: 0, pids: 0 };
      r.cpu += spent;
      r.mem += p.rss;
      r.pids++;
      roles.set(p.role, r);
      tot.mem += p.rss;
      tot.pids++;
      tot.roles += spent;
      if (!job?.pids.has(p.pid)) tot.outside += spent;
    }
    list.push(row);
  }
  procPrev = cur;
  for (const r of roles.values()) r.cpu = avg(`r:${r.name}`, r.cpu, secs);
  parts = [...roles.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // run's job counts what ended between samples too, Windows' only record of them
  const inJob = job && jobPrev !== undefined && secs ? Math.max(0, job.cpu - jobPrev) : 0;
  jobPrev = job?.cpu;
  const spent = job ? inJob + tot.outside : tot.roles;
  own = { cpu: avg("own", spent, secs), mem: tot.mem, pids: tot.pids };
  // the ended ones no role's figure holds, so the rows add up to the total
  const gone = avg("gone", spent - tot.roles, secs);
  [spentWas, spentNow] = [spentNow, new Map()];
  if (gone >= 0.1) own.exited = gone;
  list.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  const top = list.slice(0, procTop);
  // the top ones named by their argv[0] on Linux, where comm is 15 bytes
  if (linuxOS)
    for (const p of top) {
      const cmd = read(`/proc/${p.pid}/cmdline`).split("\0").filter(Boolean);
      if (!cmd.length) continue;
      p.cmd = runes(cmd.join(" "), 300);
      const b = basename(cmd[0]!);
      if (b) p.name = b;
    }
  procList = { count: list.length, top };
}

function resetProcs() {
  procPrev = new Map();
  spentWas = new Map();
  jobPrev = undefined;
  procAt = 0;
  procList = null;
  own = null;
}

// --- own sampler -----------------------------------------------------------

// hooks self() and peers() from server
export const hooks: { self: () => Record<string, any>; peers: () => Record<string, string> | undefined } = {
  self: () => ({}),
  peers: () => undefined,
};

type SampleState = { at: number; cpu: CpuT[]; net: Record<string, RxTx>; r: number; w: number };

const listeners = new Map<number, (t: string) => void>();
let lid = 0;
let prev: SampleState | undefined;
let latest = "";
let ticker: ReturnType<typeof setInterval> | undefined;
let inflight = false;

async function sample(): Promise<Record<string, any> | undefined> {
  await sys.poll?.();
  // stopped while polling: the next listener starts from a clean baseline
  if (!ticker) return;
  const at = now();
  const { bytes, order } = sys.netBytes();
  const [r, w] = sys.diskBytes();
  const cur: SampleState = { at, cpu: sys.cpuTimes(), net: bytes, r, w };
  const last = prev;
  prev = cur;
  if (!last || !cur.cpu.length) return;
  const secs = (at - last.at) / 1000;
  const pct = (a: CpuT, i: number) => {
    const b = last.cpu[i];
    return b && a.total > b.total ? round(1000 * (1 - (a.idle - b.idle) / (a.total - b.total))) / 10 : 0;
  };
  const rate = (a: number, b: number | undefined) =>
    b !== undefined && a >= b && secs > 0 ? round((a - b) / secs) : 0;
  const cpus = cur.cpu.map(pct);
  const ld = sys.loadAvg();
  refreshProcs(at);
  const g = gpus();
  gpuNote(g);
  const nets = order.map((n) => ({
    name: n,
    rx: rate(cur.net[n]!.rx, last.net[n]?.rx),
    tx: rate(cur.net[n]!.tx, last.net[n]?.tx),
  }));
  return {
    ...hooks.self(),
    at,
    cpu: { total: cpus[0], cores: cpus.slice(1), model: sys.cpuModel(), load: ld },
    mem: sys.memInfo(),
    net: nets,
    netDay: netDayTotals(),
    trend: trendNow(),
    io: { r: rate(cur.r, last.r), w: rate(cur.w, last.w) },
    disk: sys.disk(),
    gpus: g,
    uptime: Math.round(sys.uptimeSecs()),
    parts,
    own,
    procs: procList,
  };
}

// a tick still polling skips the next, so rates span real intervals
async function tick() {
  if (inflight) return;
  inflight = true;
  try {
    const s = await sample();
    if (!s) return;
    latest = marshal(s);
    for (const fn of [...listeners.values()]) fn(latest);
  } finally {
    inflight = false;
  }
}

// every sample as JSON text; the sampler runs only while someone listens
export function listen(fn: (t: string) => void): () => void {
  const id = ++lid;
  listeners.set(id, fn);
  const start = !ticker;
  if (start) {
    ticker = setInterval(tick, sampleMS);
    void tick();
  } else if (latest) fn(latest);
  return () => {
    listeners.delete(id);
    if (listeners.size || !ticker) return;
    clearInterval(ticker);
    ticker = undefined;
    prev = undefined;
    latest = "";
    resetProcs();
  };
}

// --- peers fanned in ------------------------------------------------------

type PeerConn = { ip: string; stopped: boolean; conn?: Conn; wake: () => void };

const peers = new Map<string, PeerConn>();
const peerLatest = new Map<string, string>();
const browsers = new Set<Conn>();
let recon: ReturnType<typeof setInterval> | undefined;
const decoder = new TextDecoder();

function toBrowsers(text: string) {
  for (const b of [...browsers]) b.text(text);
}

function dialPeer(host: string, ip: string) {
  const p: PeerConn = { ip, stopped: false, wake: () => {} };
  peers.set(host, p);
  (async () => {
    while (!p.stopped) {
      try {
        const c = await dial(`ws://${ip}:${FrontendPort}/api/stats?own`, {}, 3000);
        if (p.stopped) {
          c.terminate();
          return;
        }
        p.conn = c;
        c.onMessage((d) => {
          const t = typeof d === "string" ? d : decoder.decode(d);
          if (peers.get(host) === p) peerLatest.set(host, t);
          toBrowsers(t);
        });
        await c.done();
      } catch {}
      if (p.stopped) return;
      await new Promise<void>((r) => {
        p.wake = r;
        setTimeout(r, peerRetry);
      });
    }
  })();
}

function dropPeer(host: string) {
  const p = peers.get(host);
  if (!p) return;
  peers.delete(host);
  peerLatest.delete(host);
  p.stopped = true;
  p.conn?.terminate();
  p.wake();
}

function reconcile() {
  const want = hooks.peers() ?? {};
  for (const [h, p] of peers) if (want[h] !== p.ip) dropPeer(h);
  for (const [h, ip] of Object.entries(want)) if (!peers.has(h)) dialPeer(h, ip);
}

// attach a browser: own samples and every peer's, a peer: own only
export function attach(ws: Conn, own: boolean) {
  const off = listen((t) => {
    if (ws.open()) ws.text(t);
  });
  ws.onClose(off);
  // nothing is read, as Go drained it
  ws.onMessage(() => {});
  if (own) return;
  browsers.add(ws);
  for (const t of peerLatest.values()) ws.text(t);
  if (!recon) {
    reconcile();
    recon = setInterval(reconcile, sampleMS);
  }
  ws.onClose(() => {
    browsers.delete(ws);
    if (browsers.size) return;
    clearInterval(recon);
    recon = undefined;
    for (const h of [...peers.keys()]) dropPeer(h);
  });
}

// init the day's net totals, a baseline written now
export async function init() {
  const nd = readJSON<NetDay>(netDayFile);
  netDay = nd && Array.isArray(nd.buckets) ? nd : { boot: "", buckets: [] };
  bootID = await sys.bootID();
  await netDayTick();
  netDay.at ??= now();
  setInterval(netDayTick, netBucketMS).unref();
}
