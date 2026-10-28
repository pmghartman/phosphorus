// Windows through PowerShell: one CIM query per sample for the cache, pagefile,
// adapters, disk bytes and volumes; the gpus from DirectX's registry adapters
// and the GPU Engine and GPU Adapter Memory counters, nvidia's left to nvidia-smi
import { freemem, totalmem, uptime } from "node:os";
import { now, run } from "@phosphorus/util";
import { type Disk, type Gpu, gpuMS, type Mem, type Net, osCpuModel, osCpuTimes, osLoadAvg, type Sys, vendor } from "./common.ts";

const virtualIf = /^(lo|loopback|vEthernet|veth|bridge|awdl|llw|anpi|ap\d|gif|stf|isatap|teredo)/i;

const pollScript = `$ErrorActionPreference='SilentlyContinue'
$m=Get-CimInstance Win32_PerfRawData_PerfOS_Memory
$p=Get-CimInstance Win32_PageFileUsage
@{cache=$m.CacheBytes;standby=$m.StandbyCacheCoreBytes+$m.StandbyCacheNormalPriorityBytes+$m.StandbyCacheReserveBytes
swapTotal=($p|Measure-Object AllocatedBaseSize -Sum).Sum;swapUsed=($p|Measure-Object CurrentUsage -Sum).Sum
net=@(Get-NetAdapterStatistics|%{@{name=$_.Name;rx=$_.ReceivedBytes;tx=$_.SentBytes}})
io=@(Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk|?{$_.Name -ne '_Total'}|%{@{r=$_.DiskReadBytesPersec;w=$_.DiskWriteBytesPersec}})
disks=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|%{@{total=$_.Size;free=$_.FreeSpace}})
}|ConvertTo-Json -Compress -Depth 4`;

const gpuScript = `$ErrorActionPreference='SilentlyContinue'
$a=@(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\DirectX\\*'|?{$_.AdapterLuid}|%{@{name=$_.Description;vendor=$_.VendorId;luid=[string]$_.AdapterLuid;dedicated=[string]$_.DedicatedVideoMemory;shared=[string]$_.SharedSystemMemory;seen=[string]$_.LastSeen}})
$c=@((Get-Counter '\\GPU Engine(*)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage','\\GPU Adapter Memory(*)\\Shared Usage').CounterSamples|%{@{p=$_.Path;v=$_.CookedValue}})
@{adapters=$a;counters=$c}|ConvertTo-Json -Compress -Depth 4`;

// a script's JSON, undefined when PowerShell couldn't run it
async function ps(script: string): Promise<any> {
  const enc = Buffer.from(script, "utf16le").toString("base64");
  const r = await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc], { timeoutMs: 15000 });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

// ConvertTo-Json hands a lone element back bare
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : v == null ? [] : [v]);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

export type Polled = { mem: Mem; net: Net; io: [number, number]; disk: Disk };

// the poll script's JSON into the sample's figures; total and avail from the OS
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
    const name = String(a?.name ?? ""), rx = n(a?.rx), tx = n(a?.tx);
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
    const t = n(v?.total), free = n(v?.free);
    const key = `${t}:${free}`;
    if (t === 0 || seen.has(key)) continue;
    seen.add(key);
    disk.total += t;
    disk.used += t - free;
    disk.count++;
  }
  return { mem, net, io, disk };
}

const luidRe = /luid_0x([0-9a-fA-F]+)_0x([0-9a-fA-F]+)_phys_(\d+)/;
const engRe = /_eng_(\d+)/;
const hex8 = (v: bigint) => v.toString(16).padStart(8, "0");

type Adapter = Gpu & { vendor: string };

// the gpu script's JSON into rows: an adapter's load its busiest engine's summed
// over processes; under 1GB dedicated taken as an igpu's carve-out, its memory
// the shared pool. Registry entries outlive their adapters, so only those the
// counters list now count, every vendor-known one when there are no counters
export function parseGpus(j: any): Adapter[] {
  const busy = new Map<string, Map<string, number>>(), mem = new Map<string, number>(), shMem = new Map<string, number>();
  for (const c of arr(j?.counters)) {
    const p = String(c?.p ?? "").toLowerCase(), v = n(c?.v);
    const m = luidRe.exec(p);
    if (!m) continue;
    const l = `${m[1]}_${m[2]}`.toLowerCase();
    if (p.endsWith("\\utilization percentage")) {
      const e = engRe.exec(p);
      if (!e) continue;
      const b = busy.get(l) ?? new Map<string, number>();
      b.set(e[1]!, (b.get(e[1]!) ?? 0) + v);
      busy.set(l, b);
    } else if (p.endsWith("\\dedicated usage")) mem.set(l, (mem.get(l) ?? 0) + v);
    else if (p.endsWith("\\shared usage")) shMem.set(l, (shMem.get(l) ?? 0) + v);
  }
  const present = new Set([...busy.keys(), ...mem.keys(), ...shMem.keys()]);
  const newest = new Map<string, any>();
  for (const a of arr(j?.adapters)) {
    const v = vendor["0x" + n(a?.vendor).toString(16).padStart(4, "0")];
    if (!v) continue;
    let luid: bigint;
    try {
      luid = BigInt.asUintN(64, BigInt(String(a?.luid ?? "0")));
    } catch {
      continue;
    }
    const l = `${hex8(luid >> 32n)}_${hex8(luid & 0xffffffffn)}`;
    const key = present.size ? l : String(a?.name ?? "");
    if (present.size ? !present.has(l) : n(newest.get(key)?.seen) > n(a?.seen)) continue;
    newest.set(key, { ...a, v, l });
  }
  const out: Adapter[] = [];
  for (const a of newest.values()) {
    const dedicated = n(a.dedicated);
    const integrated = dedicated < 1 << 30;
    let util: number | null = null, memUsed: number | null = null;
    const b = busy.get(a.l);
    if (b) util = Math.min(Math.max(0, ...b.values()), 100);
    if (mem.has(a.l)) memUsed = mem.get(a.l)!;
    if (shMem.has(a.l) && integrated) memUsed = shMem.get(a.l)!;
    out.push({
      name: String(a.name ?? "").toLowerCase(), util, memUsed, memTotal: integrated ? n(a.shared) : dedicated,
      mhz: null, mhzMax: null, temp: null, integrated, vendor: a.v,
    });
  }
  return out;
}

let polled = parsePoll(undefined);
let gpus: Adapter[] = [];
let gpuAt = 0, gpuBusy = false;

function vendorGpus(haveNvidia: boolean): Gpu[] {
  if (!gpuBusy && now() - gpuAt >= gpuMS) {
    gpuBusy = true;
    ps(gpuScript)
      .then((j) => (gpus = parseGpus(j)))
      .finally(() => ((gpuAt = now()), (gpuBusy = false)));
  }
  return gpus.filter((g) => !(g.vendor === "nvidia" && haveNvidia)).map(({ vendor: _, ...g }) => g);
}

export const win32: Sys = {
  poll: async () => void (polled = parsePoll(await ps(pollScript))),
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
