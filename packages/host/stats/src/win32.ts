// Windows through one PowerShell kept open, a request a line: CIM for the cache,
// pagefile, adapters, disk bytes and volumes; the dedicated gpus from DirectX's
// registry adapters and the raw GPU Engine and Adapter Memory classes, nvidia's left to nvidia-smi
import { freemem, totalmem, uptime } from "node:os";
import { now } from "@phosphorus/util";
import type { Subprocess } from "bun";
import {
  type Disk,
  type Gpu,
  gpuMS,
  type Mem,
  type Net,
  osCpuModel,
  osCpuTimes,
  osLoadAvg,
  type Sys,
  vendor,
} from "./common.ts";

const virtualIf = /^(lo|loopback|vEthernet|veth|bridge|awdl|llw|anpi|ap\d|gif|stf|isatap|teredo)/i;

// a fresh PowerShell a sample cost half a core in startup alone, Get-Counter more
const serveScript = `$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function poll {
$m=Get-CimInstance Win32_PerfRawData_PerfOS_Memory
$p=Get-CimInstance Win32_PageFileUsage
@{cache=$m.CacheBytes;standby=$m.StandbyCacheCoreBytes+$m.StandbyCacheNormalPriorityBytes+$m.StandbyCacheReserveBytes
swapTotal=($p|Measure-Object AllocatedBaseSize -Sum).Sum;swapUsed=($p|Measure-Object CurrentUsage -Sum).Sum
net=@(Get-NetAdapterStatistics|%{@{name=$_.Name;rx=$_.ReceivedBytes;tx=$_.SentBytes}})
io=@(Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk|?{$_.Name -ne '_Total'}|%{@{r=$_.DiskReadBytesPersec;w=$_.DiskWriteBytesPersec}})
disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|%{@{total=$_.Size;free=$_.FreeSpace}})
}}
function gpu {
$a=@(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\DirectX\\*'|?{$_.AdapterLuid}|%{@{name=$_.Description;vendor=$_.VendorId;luid=[string]$_.AdapterLuid;dedicated=[string]$_.DedicatedVideoMemory;type=$_.AdapterType;seen=[string]$_.LastSeen}})
$e=@(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUEngine|%{@{n=$_.Name;u=[string]$_.UtilizationPercentage;t=[string]$_.Timestamp_Sys100NS}})
$d=@(Get-CimInstance Win32_PerfRawData_GPUPerformanceCounters_GPUAdapterMemory|%{@{n=$_.Name;v=[string]$_.DedicatedUsage}})
@{adapters=$a;engines=$e;mem=$d}}
while ($null -ne ($l=[Console]::In.ReadLine())) {
$o=switch ($l) { 'poll' { poll } 'gpu' { gpu } default { @{} } }
[Console]::Out.WriteLine(($o|ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush()
}`;

const askTimeout = 15000;
const idleMS = 60000;

type Timer = ReturnType<typeof setTimeout>;
type Shell = { p: Subprocess<"pipe", "pipe", "ignore">; lines: AsyncIterator<string>; idle?: Timer };
let shell: Shell | undefined;
let turn: Promise<unknown> = Promise.resolve();

// stdout cut into lines, one reply each
async function* linesOf(s: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let buf = "";
  for await (const b of s) {
    buf += dec.decode(b, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
}

function open(): Shell {
  const enc = Buffer.from(serveScript, "utf16le").toString("base64");
  const p = Bun.spawn(
    ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
    { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true },
  );
  const sh: Shell = { p, lines: linesOf(p.stdout)[Symbol.asyncIterator]() };
  void p.exited.then(() => {
    if (shell === sh) shell = undefined;
  });
  return sh;
}

// its stdin's end its exit, killed if it lingers
function close(sh: Shell) {
  if (shell === sh) shell = undefined;
  clearTimeout(sh.idle);
  try {
    sh.p.stdin.end();
  } catch {}
  setTimeout(() => sh.p.kill(), 2000).unref();
}

// one request's JSON, undefined when the shell couldn't answer; one at a time,
// the shell closed after a minute unasked
function ask(what: "poll" | "gpu"): Promise<any> {
  const next = turn.then(async () => {
    const sh = (shell ??= open());
    clearTimeout(sh.idle);
    let t: Timer | undefined;
    try {
      sh.p.stdin.write(what + "\n");
      sh.p.stdin.flush();
      const got = await Promise.race([
        sh.lines.next(),
        new Promise<undefined>((r) => (t = setTimeout(() => r(undefined), askTimeout))),
      ]);
      if (!got || got.done) {
        close(sh);
        return;
      }
      return JSON.parse(got.value);
    } catch {
      close(sh);
      return;
    } finally {
      clearTimeout(t);
      if (shell === sh) sh.idle = setTimeout(() => close(sh), idleMS);
    }
  });
  turn = next.catch(() => {});
  return next;
}

// ConvertTo-Json hands a lone element back bare
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);
const big = (v: unknown) => {
  try {
    return BigInt(String(v ?? "0"));
  } catch {
    return 0n;
  }
};

export type Polled = { mem: Mem; net: Net; io: [number, number]; disk: Disk };

// the poll's JSON into the sample's figures; total and avail from the OS
export function parsePoll(j: any, total = totalmem(), avail = freemem()): Polled {
  const mem: Mem = {
    total,
    used: total - avail,
    avail,
    cached: n(j?.cache) + n(j?.standby),
    swapTotal: n(j?.swapTotal) * (1 << 20),
    swapUsed: n(j?.swapUsed) * (1 << 20),
  };
  const net: Net = { bytes: {}, order: [] };
  for (const a of arr(j?.net)) {
    const name = String(a?.name ?? ""),
      rx = n(a?.rx),
      tx = n(a?.tx);
    if (!name || virtualIf.test(name) || rx + tx === 0 || net.bytes[name]) continue;
    net.bytes[name] = { rx, tx };
    net.order.push(name);
  }
  const io: [number, number] = [0, 0];
  for (const d of arr(j?.io)) {
    io[0] += n(d?.r);
    io[1] += n(d?.w);
  }
  const seen = new Set<string>();
  const disk: Disk = { total: 0, used: 0, count: 0 };
  for (const v of arr(j?.disks)) {
    const t = n(v?.total),
      free = n(v?.free);
    const key = `${t}:${free}`;
    if (t === 0 || seen.has(key)) continue;
    seen.add(key);
    disk.total += t;
    disk.used += t - free;
    disk.count++;
  }
  return { mem, net, io, disk };
}

// a gpu with memory of its own: a hybrid laptop's flags when set, else its name,
// an APU's carve-out reading as dedicated as any card's
export function discrete(v: string, name: string, type: number): boolean {
  if (type & 0x4) return false;
  if (type & 0x10) return true;
  if (type & 0x20) return false;
  const s = name.toLowerCase();
  if (v === "nvidia") return true;
  if (v === "amd") return /\b(rx|pro|vii|firepro|instinct|r[579]|hd)\b/.test(s);
  if (v === "intel") return /\barc\b.*\b([ab]\d{3}|pro)\b|xe max/.test(s);
  return false;
}

const luidRe = /luid_0x([0-9a-f]+)_0x([0-9a-f]+)_phys_\d+(?:_eng_(\d+))?/;
const hex8 = (v: bigint) => v.toString(16).padStart(8, "0");

type Adapter = Gpu & { vendor: string };
// each engine instance's busy time and timestamp, both in 100ns
export type Engines = Map<string, [bigint, bigint]>;

// the gpu JSON into the dedicated adapters and the engines to diff the next against:
// an adapter's load its busiest engine's summed over processes since the last read.
// Registry entries outlive their adapters, so only those the classes list now count,
// every vendor-known one when there are none
export function parseGpus(j: any, prev: Engines = new Map()): [Adapter[], Engines] {
  const next: Engines = new Map();
  const busy = new Map<string, Map<string, number>>(),
    mem = new Map<string, number>();
  for (const e of arr(j?.engines)) {
    const name = String(e?.n ?? "").toLowerCase();
    const m = luidRe.exec(name);
    if (!m?.[3]) continue;
    const l = `${m[1]!.padStart(8, "0")}_${m[2]!.padStart(8, "0")}`;
    const cur: [bigint, bigint] = [big(e?.u), big(e?.t)];
    next.set(name, cur);
    const b = busy.get(l) ?? new Map<string, number>();
    busy.set(l, b);
    const was = prev.get(name);
    if (!was || cur[1] <= was[1] || cur[0] < was[0]) continue;
    const pct = (100 * Number(cur[0] - was[0])) / Number(cur[1] - was[1]);
    b.set(m[3], (b.get(m[3]) ?? 0) + pct);
  }
  for (const c of arr(j?.mem)) {
    const m = luidRe.exec(String(c?.n ?? "").toLowerCase());
    if (!m) continue;
    const l = `${m[1]!.padStart(8, "0")}_${m[2]!.padStart(8, "0")}`;
    mem.set(l, (mem.get(l) ?? 0) + Number(big(c?.v)));
  }
  const present = new Set([...busy.keys(), ...mem.keys()]);
  const newest = new Map<string, any>();
  for (const a of arr(j?.adapters)) {
    const v = vendor["0x" + n(a?.vendor).toString(16).padStart(4, "0")];
    if (!v || !discrete(v, String(a?.name ?? ""), n(a?.type))) continue;
    const luid = BigInt.asUintN(64, big(a?.luid));
    const l = `${hex8(luid >> 32n)}_${hex8(luid & 0xffffffffn)}`;
    const key = present.size ? l : String(a?.name ?? "");
    if (present.size ? !present.has(l) : n(newest.get(key)?.seen) > n(a?.seen)) continue;
    newest.set(key, { ...a, v, l });
  }
  const out: Adapter[] = [];
  for (const a of newest.values()) {
    const b = busy.get(a.l);
    out.push({
      name: String(a.name ?? "").toLowerCase(),
      util: b?.size ? Math.min(Math.max(0, ...b.values()), 100) : null,
      memUsed: mem.get(a.l) ?? null,
      memTotal: n(a.dedicated) || null,
      mhz: null,
      mhzMax: null,
      temp: null,
      vendor: a.v,
    });
  }
  return [out, next];
}

let polled = parsePoll(undefined);
let gpus: Adapter[] = [];
let engines: Engines = new Map();
let gpuAt = 0,
  gpuBusy = false;

function vendorGpus(haveNvidia: boolean): Gpu[] {
  if (!gpuBusy && now() - gpuAt >= gpuMS) {
    gpuBusy = true;
    ask("gpu")
      .then((j) => {
        if (j) [gpus, engines] = parseGpus(j, engines);
      })
      .finally(() => ((gpuAt = now()), (gpuBusy = false)));
  }
  return gpus.filter((g) => !(g.vendor === "nvidia" && haveNvidia)).map(({ vendor: _, ...g }) => g);
}

export const win32: Sys = {
  // a shell that didn't answer leaves the last figures, never a counter dropped to zero
  poll: async () => {
    const j = await ask("poll");
    if (j) polled = parsePoll(j);
  },
  cpuTimes: osCpuTimes,
  memInfo: () => polled.mem,
  netBytes: () => polled.net,
  diskBytes: () => polled.io,
  disk: () => polled.disk,
  cpuModel: osCpuModel,
  // gopsutil's boot time too was now less the tick count, to the second
  bootID: async () => String(Math.round(Date.now() / 1000 - uptime())),
  loadAvg: osLoadAvg,
  uptimeSecs: uptime,
  vendorGpus,
};
