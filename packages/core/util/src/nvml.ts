// nvidia gpus through NVML, the driver's own library, read in process: no nvidia-smi
import { dlopen, type Library, type Pointer, FFIType as T } from "bun:ffi";

export type NvGpu = {
  name: string;
  util: number;
  memUsed: number;
  memTotal: number;
  temp: number | null;
  mhz: number | null;
  mhzMax: number | null;
};

const paths =
  process.platform === "win32"
    ? ["nvml.dll", "C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvml.dll"]
    : process.platform === "linux"
      ? ["libnvidia-ml.so.1", "libnvidia-ml.so"]
      : [];

const syms = {
  nvmlInit_v2: { args: [], returns: T.i32 },
  nvmlDeviceGetCount_v2: { args: [T.ptr], returns: T.i32 },
  nvmlDeviceGetHandleByIndex_v2: { args: [T.u32, T.ptr], returns: T.i32 },
  nvmlDeviceGetName: { args: [T.ptr, T.ptr, T.u32], returns: T.i32 },
  nvmlDeviceGetUtilizationRates: { args: [T.ptr, T.ptr], returns: T.i32 },
  nvmlDeviceGetMemoryInfo: { args: [T.ptr, T.ptr], returns: T.i32 },
  nvmlDeviceGetMemoryInfo_v2: { args: [T.ptr, T.ptr], returns: T.i32 },
  nvmlDeviceGetTemperature: { args: [T.ptr, T.u32, T.ptr], returns: T.i32 },
  nvmlDeviceGetClockInfo: { args: [T.ptr, T.u32, T.ptr], returns: T.i32 },
  nvmlDeviceGetMaxClockInfo: { args: [T.ptr, T.u32, T.ptr], returns: T.i32 },
} as const;

type Nvml = Library<typeof syms>["symbols"];

// null once no library loads or none starts, not tried again
let lib: Nvml | null | undefined;
function nvml(): Nvml | null {
  if (lib !== undefined) return lib;
  lib = null;
  for (const p of paths) {
    try {
      const l = dlopen(p, syms).symbols;
      if (l.nvmlInit_v2() === 0) return (lib = l);
    } catch {}
  }
  return lib;
}

const TempGPU = 0;
const ClockSM = 1;
// nvmlMemory_v2_t: its size, version 2 in the top byte
const MemV2 = BigInt(40 | (2 << 24));

// [used, total] as nvidia-smi counts them, the driver's reserve left out where v2 reads
function memOf(l: Nvml, d: Pointer, m: BigUint64Array): [number, number] {
  m.fill(0n);
  m[0] = MemV2;
  if (l.nvmlDeviceGetMemoryInfo_v2(d, m) === 0) return [Number(m[4]), Number(m[1])];
  return l.nvmlDeviceGetMemoryInfo(d, m) === 0 ? [Number(m[2]), Number(m[0])] : [0, 0];
}

// every nvidia gpu as it reads now; a figure it can't read null, never a false 0
export function nvidiaGpus(): NvGpu[] {
  const l = nvml();
  const n = new Uint32Array(2);
  if (!l || l.nvmlDeviceGetCount_v2(n) !== 0) return [];
  const h = new BigUint64Array(1);
  const mem = new BigUint64Array(5);
  const name = new Uint8Array(96);
  const out: NvGpu[] = [];
  for (let i = 0, count = n[0]!; i < count; i++) {
    if (l.nvmlDeviceGetHandleByIndex_v2(i, h) !== 0) continue;
    const d = Number(h[0]) as Pointer;
    const opt = (ok: number) => (ok === 0 && n[0] ? n[0] : null);
    name.fill(0);
    l.nvmlDeviceGetName(d, name, name.length);
    const end = name.indexOf(0);
    const util = l.nvmlDeviceGetUtilizationRates(d, n) === 0 ? n[0]! : 0;
    const [memUsed, memTotal] = memOf(l, d, mem);
    out.push({
      name: new TextDecoder()
        .decode(name.subarray(0, end < 0 ? name.length : end))
        .trim()
        .toLowerCase(),
      util,
      memUsed,
      memTotal,
      temp: opt(l.nvmlDeviceGetTemperature(d, TempGPU, n)),
      mhz: opt(l.nvmlDeviceGetClockInfo(d, ClockSM, n)),
      mhzMax: opt(l.nvmlDeviceGetMaxClockInfo(d, ClockSM, n)),
    });
  }
  return out;
}

let any: boolean | undefined;
// an nvidia gpu here, as its driver says
export const hasNvidia = () => (any ??= nvidiaGpus().length > 0);
