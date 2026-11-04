// --- /api/stats: one host's sample (packages/stats)

export interface StatsGpu {
  name: string;
  util: number | null;
  mhz?: number;
  mhzMax?: number;
  memUsed?: number;
  memTotal?: number;
  temp: number | null;
}
export interface StatsPart {
  name: string;
  cpu: number;
  mem: number;
  pids: number;
}
// every phosphorus process summed; exited: cpu of ones that ended unseen, in no part's figure
export interface StatsOwn {
  cpu: number;
  mem: number;
  pids: number;
  exited?: number;
}
export interface StatsProc {
  name: string;
  pid: number;
  cpu: number;
  mem: number;
  cmd?: string;
  role?: string;
}
// the last day by the hour, oldest first, the last ending at at and still filling; rx and tx
// the bytes of the day ending at each hour, cpu, mem, disk and gpu that hour's mean and 5 minute peak
export interface StatsTrend {
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
}
export interface StatsSample {
  host: string;
  at: number;
  platform?: string;
  version?: string;
  // null on Windows, which has no load average
  cpu: { total: number; cores: number[]; model: string; load: (number | null)[] };
  mem: { total: number; used: number; avail: number; cached: number; swapTotal: number; swapUsed: number };
  net: { name: string; rx: number; tx: number }[];
  netDay: { rx: number; tx: number; since: number };
  // sent when it changes and every few samples, kept by the page between
  trend?: StatsTrend;
  io: { r: number; w: number };
  disk: { total: number; used: number; count: number };
  gpus: StatsGpu[];
  uptime?: number;
  parts?: StatsPart[];
  own?: StatsOwn | null;
  procs?: { count: number; top: StatsProc[] };
}
