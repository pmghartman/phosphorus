// Linux from /proc and /sys; each reader takes its file's text so the parsers
// run on samples
import { statfsSync } from "node:fs";
import { type CpuT, type Disk, type Gpu, type Mem, type Net, num, read, readdir, type Sys, vendor } from "./common.ts";

const realFS =
  /^(ext[234]|xfs|btrfs|zfs|f2fs|bcachefs|jfs|reiserfs|ntfs3?|fuseblk|exfat|vfat|hfsplus|apfs|9p|drvfs|virtiofs)$/;
const virtualIf = /^(lo|veth|docker|br-|virbr|cni|flannel|kube)/;
const wholeDisk = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function cpuTimes(s = read("/proc/stat")): CpuT[] {
  const out: CpuT[] = [];
  for (const line of s.split("\n")) {
    if (!line.startsWith("cpu")) break;
    const v = line.trim().split(/\s+/).slice(1).map(num);
    const at = (i: number) => (i < v.length && !Number.isNaN(v[i]) ? v[i]! : 0);
    let total = 0;
    for (let i = 0; i < 8 && i < v.length; i++) total += v[i]!;
    out.push({ idle: at(3) + at(4), total });
  }
  return out;
}

export function memInfo(s = read("/proc/meminfo")): Mem {
  const kb: Record<string, number> = {};
  for (const line of s.split("\n")) {
    const m = /^(\w+):\s+(\d+)/.exec(line);
    if (m) kb[m[1]!] = num(m[2]!) * 1024;
  }
  const total = kb.MemTotal ?? 0;
  const avail = kb.MemAvailable ?? kb.MemFree ?? 0;
  return {
    total,
    used: total - avail,
    avail,
    cached: (kb.Cached ?? 0) + (kb.Buffers ?? 0),
    swapTotal: kb.SwapTotal ?? 0,
    swapUsed: (kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0),
  };
}

export function netBytes(s = read("/proc/net/dev")): Net {
  const out: Net = { bytes: {}, order: [] };
  for (const line of s.split("\n").slice(2)) {
    const at = line.indexOf(":");
    if (at < 0) continue;
    const name = line.slice(0, at).trim();
    if (virtualIf.test(name)) continue;
    const f = line
      .slice(at + 1)
      .trim()
      .split(/\s+/);
    if (f.length < 9) continue;
    out.bytes[name] = { rx: num(f[0]!), tx: num(f[8]!) };
    out.order.push(name);
  }
  return out;
}

export function diskBytes(s = read("/proc/diskstats")): [number, number] {
  let r = 0,
    w = 0;
  for (const line of s.split("\n")) {
    const v = line.trim().split(/\s+/);
    if (v.length < 10 || !wholeDisk.test(v[2]!)) continue;
    r += num(v[5]!) * 512;
    w += num(v[9]!) * 512;
  }
  return [r, w];
}

export type Mount = { dir: string; dev: string };

// the real filesystems' mount points, \040-style escapes undone
export function diskMounts(s = read("/proc/self/mountinfo")): Mount[] {
  const out: Mount[] = [];
  for (const line of s.split("\n")) {
    const v = line.split(" ");
    const sep = v.indexOf("-");
    if (sep < 0 || v.length <= sep + 1 || v.length < 5) continue;
    const dir = v[4]!.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
    if (dir.startsWith("/") && realFS.test(v[sep + 1]!)) out.push({ dir, dev: v[2]! });
  }
  return out;
}

// every real filesystem once: a device mounted twice, or two mounts of one
// store, counted a single time
export function disk(mounts = diskMounts()): Disk {
  const seen = new Set<string>();
  let total = 0,
    used = 0,
    count = 0;
  for (const m of mounts) {
    if (seen.has(m.dev)) continue;
    let s;
    try {
      s = statfsSync(m.dir);
    } catch {
      continue;
    }
    const key = `${s.blocks}:${s.bfree}:${s.bsize}:${s.type}`;
    if (s.blocks === 0 || seen.has(key)) continue;
    seen.add(m.dev);
    seen.add(key);
    total += s.blocks * s.bsize;
    used += (s.blocks - s.bfree) * s.bsize;
    count++;
  }
  return { total, used, count };
}

let model: string | undefined;
export const cpuModel = (s?: string) =>
  (model ??= /^model name\s*:\s*(.+)$/m.exec(s ?? read("/proc/cpuinfo"))?.[1] ?? "");

// --- gpus from /sys/class/drm ------------------------------------------------

function numFile(f: string): number | null {
  const v = read(f).trim();
  if (v === "") return null;
  const n = num(v);
  return Number.isNaN(n) ? null : n;
}

function integrated(v: string, dev: string): boolean {
  if (v === "intel") {
    const m = /PCI_SLOT_NAME=(\S+)/.exec(read(dev + "/uevent"));
    return !!m && /:00:02\.0$/.test(m[1]!);
  }
  if (v === "amd") {
    const x = read(dev + "/mem_info_vram_vendor").trim();
    return x === "" || x === "unknown";
  }
  return false;
}

// amdClock the shader clock now and its top step, from pp_dpm_sclk's levels
export function amdClock(s: string): [number | null, number | null] {
  let now: number | null = null,
    top: number | null = null;
  for (const l of s.split("\n")) {
    const m = /(\d+)Mhz/.exec(l);
    if (!m) continue;
    top = num(m[1]!);
    if (l.trim().endsWith("*")) now = top;
  }
  return [now, top];
}

export function vendorGpus(haveNvidia: boolean): Gpu[] {
  const out: Gpu[] = [];
  for (const c of readdir("/sys/class/drm")) {
    if (!/^card\d+$/.test(c)) continue;
    const dev = `/sys/class/drm/${c}/device`;
    const v = vendor[read(dev + "/vendor").trim()];
    if (!v || (v === "nvidia" && haveNvidia)) continue;
    const igpu = integrated(v, dev);
    let temp: number | null = null;
    const hw = readdir(dev + "/hwmon");
    if (hw.length) {
      const t = numFile(`${dev}/hwmon/${hw[0]}/temp1_input`);
      if (t !== null) temp = Math.round(t / 1000);
    }
    let name = read(dev + "/product_name").trim();
    if (!name) name = igpu ? `${v} integrated gpu` : `${v} gpu`;
    let used = numFile(dev + "/mem_info_vram_used"),
      total = numFile(dev + "/mem_info_vram_total");
    // an amd igpu's memory the gtt it maps from system ram
    if (igpu && v === "amd")
      [used, total] = [numFile(dev + "/mem_info_gtt_used"), numFile(dev + "/mem_info_gtt_total")];
    let mhz = numFile(`/sys/class/drm/${c}/gt_act_freq_mhz`),
      mhzMax = numFile(`/sys/class/drm/${c}/gt_max_freq_mhz`);
    if (v === "amd") [mhz, mhzMax] = amdClock(read(dev + "/pp_dpm_sclk"));
    out.push({
      name: name.toLowerCase(),
      util: numFile(dev + "/gpu_busy_percent"),
      memUsed: used,
      memTotal: total,
      mhz,
      mhzMax,
      temp,
      integrated: igpu,
    });
  }
  return out;
}

export const bootID = async () => read("/proc/sys/kernel/random/boot_id").trim();

export function loadAvg(s = read("/proc/loadavg")): (number | null)[] {
  const la = s.trim().split(/\s+/);
  return [0, 1, 2].map((i) => (i < la.length && la[i] !== "" ? num(la[i]!) : null));
}

export function uptimeSecs(s = read("/proc/uptime")): number {
  const up = s.trim().split(/\s+/);
  return up[0] ? num(up[0]) : 0;
}

export const linux: Sys = {
  cpuTimes,
  memInfo,
  netBytes,
  diskBytes,
  disk,
  cpuModel,
  bootID,
  loadAvg,
  uptimeSecs,
  vendorGpus,
};
