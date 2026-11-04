// Windows' processes over kernel32 and ntdll: a toolhelp snapshot for pids,
// parents and names, then each one's memory, times and command line
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { P } from "./index.ts";

const { u32, u64, ptr: Ptr, bool, i32 } = FFIType;
let lib: ReturnType<typeof open> | undefined;
function open() {
  return {
    k: dlopen("kernel32.dll", {
      CreateToolhelp32Snapshot: { args: [u32, u32], returns: u64 },
      Process32FirstW: { args: [u64, Ptr], returns: bool },
      Process32NextW: { args: [u64, Ptr], returns: bool },
      OpenProcess: { args: [u32, bool, u32], returns: u64 },
      CloseHandle: { args: [u64], returns: bool },
      K32GetProcessMemoryInfo: { args: [u64, Ptr, u32], returns: bool },
      GetProcessTimes: { args: [u64, Ptr, Ptr, Ptr, Ptr], returns: bool },
      OpenJobObjectW: { args: [u32, bool, Ptr], returns: u64 },
      QueryInformationJobObject: { args: [u64, u32, Ptr, u32, Ptr], returns: bool },
    }).symbols,
    nt: dlopen("ntdll.dll", { NtQueryInformationProcess: { args: [u64, u32, Ptr, u32, Ptr], returns: i32 } }).symbols,
  };
}

const QUERY_LIMITED = 0x1000;
const ProcessCommandLineInformation = 60;

export function listWindows(): P[] {
  const { k, nt } = (lib ??= open());
  const snap = k.CreateToolhelp32Snapshot(2 /* TH32CS_SNAPPROCESS */, 0) as bigint;
  if (!snap || snap === 0xffffffffffffffffn) return [];
  const pe = Buffer.alloc(568);
  pe.writeUInt32LE(568, 0);
  const mem = Buffer.alloc(72);
  const t = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
  const cmdBuf = Buffer.alloc(64 * 1024);
  const retLen = Buffer.alloc(4);
  const out: P[] = [];
  try {
    for (let ok = k.Process32FirstW(snap, pe); ok; ok = k.Process32NextW(snap, pe)) {
      const pid = pe.readUInt32LE(8);
      const nameRaw = pe.subarray(44, 44 + 520).toString("utf16le");
      const p: P = {
        pid,
        ppid: pe.readUInt32LE(32),
        name: nameRaw.slice(0, nameRaw.indexOf("\0")),
        cmd: "",
        role: "",
        rss: 0,
        cpu: 0,
        kids: 0,
      };
      const h = pid ? (k.OpenProcess(QUERY_LIMITED, false, pid) as bigint) : 0n;
      if (h) {
        mem.writeUInt32LE(72, 0);
        if (k.K32GetProcessMemoryInfo(h, mem, 72)) p.rss = Number(mem.readBigUInt64LE(16));
        if (k.GetProcessTimes(h, t[0]!, t[1]!, t[2]!, t[3]!))
          p.cpu = Number(t[2]!.readBigUInt64LE(0) + t[3]!.readBigUInt64LE(0)) / 1e7;
        if (nt.NtQueryInformationProcess(h, ProcessCommandLineInformation, cmdBuf, cmdBuf.length, retLen) === 0) {
          // a UNICODE_STRING whose text follows it in the same buffer
          const len = cmdBuf.readUInt16LE(0);
          const at = Number(cmdBuf.readBigUInt64LE(8) - BigInt(ptr(cmdBuf)));
          if (at >= 0 && at + len <= cmdBuf.length) p.cmd = cmdBuf.subarray(at, at + len).toString("utf16le");
        }
        k.CloseHandle(h);
      }
      out.push(p);
    }
  } finally {
    k.CloseHandle(snap);
  }
  return out;
}

// the job phosphorus run puts itself in, named for run's pid; its children inherit it
export const jobName = (runPID: number) => `Local\\phosphorus-run-${runPID}`;

// cpu seconds of all the job ever held, ended ones too, and every pid in it now
export type Job = { cpu: number; pids: Set<number> };
let job: { pid: number; h: bigint } | undefined;
const acct = Buffer.alloc(48);
let idList = Buffer.alloc(8 + 8 * 1024);

// run's job, undefined when run made none or is gone
export function readJob(runPID: number): Job | undefined {
  const { k } = (lib ??= open());
  if (job?.pid !== runPID || !job.h) {
    if (job?.h) k.CloseHandle(job.h);
    // JOB_OBJECT_QUERY
    job = { pid: runPID, h: k.OpenJobObjectW(0x4, false, Buffer.from(jobName(runPID) + "\0", "utf16le")) as bigint };
  }
  if (!job.h) return;
  // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: total user then kernel time in 100ns
  if (!k.QueryInformationJobObject(job.h, 1, acct, acct.length, null)) return;
  const cpu = Number(acct.readBigInt64LE(0) + acct.readBigInt64LE(8)) / 1e7;
  // JOBOBJECT_BASIC_PROCESS_ID_LIST, grown when the job outgrows it
  for (let i = 0; ; i++) {
    idList.fill(0, 0, 8);
    const ok = k.QueryInformationJobObject(job.h, 3, idList, idList.length, null);
    const n = idList.readUInt32LE(0);
    if (ok && n <= idList.readUInt32LE(4)) break;
    if (i > 2 || n <= idList.readUInt32LE(4)) return;
    idList = Buffer.alloc(8 + 16 * n);
  }
  const pids = new Set<number>();
  for (let i = 0; i < idList.readUInt32LE(4); i++) pids.add(Number(idList.readBigUInt64LE(8 + 8 * i)));
  return { cpu, pids };
}
