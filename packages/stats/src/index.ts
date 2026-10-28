// this host's cpu, memory, disk, network, gpus, phosphorus's own processes by
// role and the top ones, sampled only while watched, peers fanned in, one socket each
import { basename, join } from "node:path";
import { list as procsList } from "@phosphorus/procs";
import { FrontendPort, marshal, now, readJSON, run, StateDir, writeJSONAtomic } from "@phosphorus/util";
import { type Conn, dial } from "@phosphorus/wsock";
import { type CpuT, type Gpu, gpuMS, num, read, round, runes, type RxTx, type Sys } from "./common.ts";
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
const tunnelIf = /^(tailscale|wg|tun|utun)/i;

// --- net totals over the last day --------------------------------------------

type NetDay = { boot: string; last?: Record<string, RxTx> | null; buckets: [number, number, number][]; at?: number };

const netDayFile = join(StateDir, "net-day.json");
let bootID = "";
let netDay: NetDay = { boot: "", buckets: [] };

function realLinks(): Record<string, RxTx> {
  const out: Record<string, RxTx> = {};
  for (const [n, v] of Object.entries(sys.netBytes().bytes)) if (!tunnelIf.test(n)) out[n] = v;
  return out;
}

// bytes since the last bucket: a counter that fell, or any after a reboot, counted from zero
function netSince(cur: Record<string, RxTx>): RxTx {
  const d = { rx: 0, tx: 0 };
  const fresh = netDay.boot !== bootID;
  for (const [n, v] of Object.entries(cur)) {
    const p = fresh ? undefined : netDay.last?.[n];
    d.rx += p && v.rx >= p.rx ? v.rx - p.rx : v.rx;
    d.tx += p && v.tx >= p.tx ? v.tx - p.tx : v.tx;
  }
  return d;
}

async function netDayTick() {
  await sys.poll?.();
  const at = now();
  const cur = realLinks();
  const buckets = netDay.buckets.slice();
  if (netDay.last) {
    const d = netSince(cur);
    buckets.push([at, d.rx, d.tx]);
  }
  netDay = { boot: bootID, last: cur, buckets: buckets.filter((b) => at - b[0] < dayMS), at: netDay.at };
  writeJSONAtomic(netDayFile, netDay);
}

function netDayTotals() {
  const d = netSince(realLinks());
  for (const b of netDay.buckets) {
    d.rx += b[1];
    d.tx += b[2];
  }
  const since = netDay.buckets.length ? netDay.buckets[0]![0] - netBucketMS : (netDay.at ?? null);
  return { rx: d.rx, tx: d.tx, since };
}

// --- gpus ------------------------------------------------------------------------

const nvsmi = ["nvidia-smi"];
let nvsmiAt = 0;
let nvidia: Gpu[] = [];
let gpuBusy = false;
let gpuAt = 0;

// nvidia-smi's csv rows; a field it can't read ([N/A]) left null, never a false 0
export function parseNvidia(out: string): Gpu[] {
  const z = (s: string) => (Number.isNaN(num(s)) ? 0 : num(s));
  const opt = (s: string) => (!Number.isNaN(num(s)) && num(s) !== 0 ? num(s) : null);
  const list: Gpu[] = [];
  for (const l of out.split("\n")) {
    if (l === "") continue;
    const p = l.split(",");
    while (p.length < 7) p.push("");
    list.push({
      name: p[0]!.trim().toLowerCase(), util: z(p[1]!), memUsed: z(p[2]!) * (1 << 20), memTotal: z(p[3]!) * (1 << 20),
      temp: opt(p[4]!), mhz: opt(p[5]!), mhzMax: opt(p[6]!),
    });
  }
  return list;
}

function refreshNvidia() {
  if (gpuBusy || nvsmiAt >= nvsmi.length || now() - gpuAt < gpuMS) return;
  gpuBusy = true;
  const bin = nvsmi[nvsmiAt]!;
  const query = "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,clocks.sm,clocks.max.sm";
  run([bin, query, "--format=csv,noheader,nounits"], { timeoutMs: 5000 })
    .then((r) => {
      // a binary that isn't there, not retried
      if (r.error) nvsmiAt++;
      nvidia = r.ok ? parseNvidia(r.stdout) : [];
    })
    .finally(() => ((gpuBusy = false), (gpuAt = now())));
}

function gpus(): Gpu[] {
  refreshNvidia();
  const nv = [...nvidia];
  return nv.concat(sys.vendorGpus(nv.length > 0));
}

// --- processes -----------------------------------------------------------------

type Row = Record<string, any>;

// parts phosphorus's own processes by role, from refreshProcs
let parts: Row[] = [];
let procPrev = new Map<number, number>();
let procAt = 0;
let procList: unknown = null;

function refreshProcs(at: number) {
  if (at - procAt < procMS) return;
  const secs = procAt ? (at - procAt) / 1000 : 0;
  procAt = at;
  const cur = new Map<number, number>();
  const list: Row[] = [];
  const roles = new Map<string, Row>();
  const linuxOS = process.platform === "linux";
  for (const p of procsList()) {
    if (!p.rss) continue;
    cur.set(p.pid, p.cpu);
    const was = procPrev.get(p.pid);
    const cpu = was !== undefined && secs > 0 ? Math.round((1000 * (p.cpu - was)) / secs) / 10 : 0;
    const row: Row = { pid: p.pid, name: linuxOS ? p.name : (p.name || basename(p.cmd)).replace(/\.exe$/, ""), cpu, mem: p.rss };
    if (!linuxOS && p.cmd) row.cmd = runes(p.cmd, 300);
    if (p.role) {
      row.role = p.role;
      const r = roles.get(p.role) ?? { name: p.role, cpu: 0, mem: 0, pids: 0 };
      r.cpu = Math.round(10 * (r.cpu + cpu)) / 10;
      r.mem += p.rss;
      r.pids++;
      roles.set(p.role, r);
    }
    list.push(row);
  }
  procPrev = cur;
  parts = [...roles.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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
  procAt = 0;
  procList = null;
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
  const rate = (a: number, b: number | undefined) => (b !== undefined && a >= b && secs > 0 ? round((a - b) / secs) : 0);
  const cpus = cur.cpu.map(pct);
  const ld = sys.loadAvg();
  refreshProcs(at);
  const nets = order.map((n) => ({ name: n, rx: rate(cur.net[n]!.rx, last.net[n]?.rx), tx: rate(cur.net[n]!.tx, last.net[n]?.tx) }));
  return {
    ...hooks.self(),
    at,
    cpu: { total: cpus[0], cores: cpus.slice(1), model: sys.cpuModel(), load: ld },
    mem: sys.memInfo(),
    net: nets,
    netDay: netDayTotals(),
    io: { r: rate(cur.r, last.r), w: rate(cur.w, last.w) },
    disk: sys.disk(),
    gpus: gpus(),
    uptime: Math.round(sys.uptimeSecs()),
    parts,
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
