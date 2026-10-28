// macOS from its commands, read once per sample: vm_stat and sysctl for memory,
// netstat for the links, ioreg for disk bytes and the gpu, df for the volumes
import { totalmem, uptime } from "node:os";
import { now, run } from "@phosphorus/util";
import { type Disk, type Gpu, gpuMS, type Mem, type Net, num, osCpuModel, osCpuTimes, osLoadAvg, type Sys } from "./common.ts";

const virtualIf = /^(lo|loopback|vEthernet|veth|bridge|awdl|llw|anpi|ap\d|gif|stf|isatap|teredo)/i;
const unit: Record<string, number> = { K: 1024, M: 1 << 20, G: 1 << 30, T: 2 ** 40 };

// vm_stat's free and inactive pages the available memory, inactive the
// reclaimable cache, as gopsutil read them; swap from sysctl vm.swapusage
export function memInfo(vm: string, swap: string, total = totalmem()): Mem {
  const page = Number(/page size of (\d+)/.exec(vm)?.[1]) || 4096;
  const pages = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(vm)?.[1] ?? 0) * page;
  const swapOf = (k: string) => {
    const m = new RegExp(`${k} = ([\\d.]+)([KMGT]?)`).exec(swap);
    return m ? num(m[1]!) * (unit[m[2]!] ?? 1) : 0;
  };
  const avail = pages("Pages free") + pages("Pages inactive");
  return { total, used: total - avail, avail, cached: pages("Pages inactive"), swapTotal: swapOf("total"), swapUsed: swapOf("used") };
}

// netstat -ibn's link rows, one per interface, bytes counted from the end
// since the address column may be missing
export function netBytes(s: string): Net {
  const out: Net = { bytes: {}, order: [] };
  for (const line of s.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !f[2]!.startsWith("<Link#")) continue;
    const name = f[0]!.replace(/\*$/, "");
    const rx = num(f[f.length - 5]!), tx = num(f[f.length - 2]!);
    if (virtualIf.test(name) || !(rx + tx > 0) || out.bytes[name]) continue;
    out.bytes[name] = { rx, tx };
    out.order.push(name);
  }
  return out;
}

// every block driver's Statistics summed
export function diskBytes(ioreg: string): [number, number] {
  const sum = (k: string) => [...ioreg.matchAll(new RegExp(`"Bytes \\(${k}\\)"=(\\d+)`, "g"))].reduce((a, m) => a + Number(m[1]), 0);
  return [sum("Read"), sum("Write")];
}

// df -kP's volumes, devfs and automounter maps left out; equal total:free
// pairs are one APFS container, its capacity counted once, each volume's used
export function disk(df: string): Disk {
  const seen = new Set<string>();
  let total = 0, used = 0, count = 0;
  for (const line of df.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 6 || f[0] === "devfs" || f[0] === "map") continue;
    const t = num(f[1]!) * 1024, u = num(f[2]!) * 1024, free = num(f[3]!) * 1024;
    const mount = f.slice(5).join(" ");
    const key = `${t}:${free}`;
    if (!(t > 0) || (mount.startsWith("/System/Volumes/") && mount !== "/System/Volumes/Data")) continue;
    used += u;
    if (seen.has(key)) continue;
    seen.add(key);
    total += t;
    count++;
  }
  return { total, used, count };
}

// Apple silicon's gpu from ioreg's IOAccelerator: its utilization and the
// unified memory it holds, the chip's name for its own
export function appleGpus(ioreg: string, chip = osCpuModel(), memTotal = totalmem()): Gpu[] {
  const out: Gpu[] = [];
  // one block per accelerator, each opening with +-o
  for (const blk of ioreg.split("+-o ").slice(1)) {
    const m = /"Device Utilization %"=(\d+)/.exec(blk);
    if (!m) continue;
    const model = /"model" = "([^"]+)"/.exec(blk);
    const name = model ? model[1]!.toLowerCase() : chip ? `${chip.toLowerCase()} gpu` : "apple gpu";
    const g: Gpu = { name, util: Number(m[1]), memUsed: null, memTotal: null, mhz: null, mhzMax: null, temp: null, integrated: true };
    const mem = /"In use system memory"=(\d+)/.exec(blk);
    if (mem) g.memUsed = Number(mem[1]);
    if (memTotal) g.memTotal = memTotal;
    const cores = /"gpu-core-count" = (\d+)/.exec(blk);
    if (cores) g.cores = Number(cores[1]);
    out.push(g);
  }
  return out;
}

export const bootTime = (s: string) => /sec = (\d+)/.exec(s)?.[1] ?? "";

const cmd = async (argv: string[]) => (await run(argv, { timeoutMs: 5000 })).stdout;

let mem: Mem = { total: totalmem(), used: 0, avail: 0, cached: 0, swapTotal: 0, swapUsed: 0 };
let net: Net = { bytes: {}, order: [] };
let io: [number, number] = [0, 0];
let vols: Disk = { total: 0, used: 0, count: 0 };
let apple: Gpu[] = [];
let appleAt = 0, appleBusy = false;

async function poll() {
  const [vm, swap, ns, ioreg, df] = await Promise.all([
    cmd(["vm_stat"]),
    cmd(["sysctl", "-n", "vm.swapusage"]),
    cmd(["netstat", "-ibn"]),
    cmd(["ioreg", "-r", "-d", "1", "-c", "IOBlockStorageDriver", "-w", "0"]),
    cmd(["df", "-kP"]),
  ]);
  mem = memInfo(vm, swap);
  net = netBytes(ns);
  io = diskBytes(ioreg);
  vols = disk(df);
}

function vendorGpus(): Gpu[] {
  if (!appleBusy && now() - appleAt >= gpuMS) {
    appleBusy = true;
    cmd(["ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"])
      .then((s) => (apple = appleGpus(s)))
      .finally(() => ((appleAt = now()), (appleBusy = false)));
  }
  return [...apple];
}

export const darwin: Sys = {
  poll,
  cpuTimes: osCpuTimes,
  memInfo: () => mem,
  netBytes: () => net,
  diskBytes: () => io,
  disk: () => vols,
  cpuModel: osCpuModel,
  bootID: async () => bootTime(await cmd(["sysctl", "-n", "kern.boottime"])),
  loadAvg: osLoadAvg,
  uptimeSecs: uptime,
  vendorGpus,
};
