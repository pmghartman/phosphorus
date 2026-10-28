// what every OS's reader shares: the shapes the sampler consumes, file reads
// that never throw, Go's ParseFloat, and node:os where it reads the same figures
import { readdirSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";

export const gpuMS = 2000;

export type CpuT = { idle: number; total: number };
export type RxTx = { rx: number; tx: number };
export type Net = { bytes: Record<string, RxTx>; order: string[] };
export type Mem = { total: number; used: number; avail: number; cached: number; swapTotal: number; swapUsed: number };
export type Disk = { total: number; used: number; count: number };
export type Gpu = Record<string, unknown>;

// one OS's readers; poll, where the figures come from commands, refreshes them before a sample
export type Sys = {
  poll?: () => Promise<void>;
  cpuTimes(): CpuT[];
  memInfo(): Mem;
  netBytes(): Net;
  diskBytes(): [number, number];
  disk(): Disk;
  cpuModel(): string;
  bootID(): Promise<string>;
  loadAvg(): (number | null)[];
  uptimeSecs(): number;
  vendorGpus(haveNvidia: boolean): Gpu[];
};

export const vendor: Record<string, string> = { "0x10de": "nvidia", "0x1002": "amd", "0x8086": "intel" };

// "" when unreadable, as Go's os.ReadFile fell back
export function read(f: string): string {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return "";
  }
}

export function readdir(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

// strconv.ParseFloat of the trimmed text: NaN on anything but a number
export function num(s: string): number {
  const t = s.trim();
  return t === "" ? NaN : Number(t);
}

// Go's math.Floor(x + 0.5)
export const round = (x: number) => Math.floor(x + 0.5);

// the first n runes, not UTF-16 units
export const runes = (s: string, n: number) => (s.length > n ? [...s].slice(0, n).join("") : s);

// node:os's per-core times, the total first: what gopsutil summed on macOS and Windows
export function osCpuTimes(): CpuT[] {
  const per = cpus().map(({ times: t }) => ({ idle: t.idle, total: t.idle + t.user + t.sys + t.nice + t.irq }));
  if (!per.length) return [];
  const all = per.reduce((a, c) => ({ idle: a.idle + c.idle, total: a.total + c.total }), { idle: 0, total: 0 });
  return [all, ...per];
}

// none on Windows, where it reads as zeros
export function osLoadAvg(): (number | null)[] {
  const l = loadavg();
  return l[0]! + l[1]! + l[2]! > 0 ? l : [null, null, null];
}

let model: string | undefined;
export const osCpuModel = () => (model ??= (cpus()[0]?.model ?? "").trim());
