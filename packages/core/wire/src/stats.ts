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
  io: { r: number; w: number };
  disk: { total: number; used: number; count: number };
  gpus: StatsGpu[];
  uptime?: number;
  parts?: StatsPart[];
  own?: StatsOwn | null;
  procs?: { count: number; top: StatsProc[] };
}
