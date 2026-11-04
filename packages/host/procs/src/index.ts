// every process with its phosphorus role on any OS: from PHOSPHORUS_ROLE where
// readable, else the nearest ancestor in state/run/roles.json
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { env, runSync, StateDir } from "@phosphorus/util";
import { type Job, listWindows, readJob } from "./win32.ts";

export { type Job, jobName } from "./win32.ts";

// one process; cpu: seconds since it started, user and system, kids: its ended children's where the OS counts them
export type P = {
  pid: number;
  ppid: number;
  name: string;
  cmd: string;
  role: string;
  rss: number;
  cpu: number;
  kids: number;
};

// phosphorus run's own children by pid, STATE_DIR read late: run sets it after start
export const rolesFile = () => join(env("STATE_DIR", StateDir), "run", "roles.json");

// the pid of each of run's children and run's own
export function writeRoles(m: Map<number, string>) {
  const tmp = rolesFile() + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)));
    renameSync(tmp, rolesFile());
  } catch {}
}

function readRoles(): Map<number, string> {
  try {
    const m = JSON.parse(readFileSync(rolesFile(), "utf8")) as Record<string, string>;
    return new Map(Object.entries(m).map(([k, v]) => [Number(k), v]));
  } catch {
    return new Map();
  }
}

// /proc: every field gopsutil reads, the role off each environ we may read
function listLinux(): P[] {
  const page = 4096,
    tick = 100;
  const out: P[] = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const name = stat.slice(stat.indexOf("(") + 1, close);
      const f = stat.slice(close + 2).split(" ");
      const cmd = readFileSync(`/proc/${d}/cmdline`, "utf8").replace(/\0+$/, "").replaceAll("\0", " ");
      let role = "";
      try {
        const e = readFileSync(`/proc/${d}/environ`, "utf8")
          .split("\0")
          .find((kv) => kv.startsWith("PHOSPHORUS_ROLE="));
        role = e ? e.slice(16) : "";
      } catch {}
      out.push({
        pid: Number(d),
        ppid: Number(f[1]),
        name,
        cmd,
        role,
        rss: Number(f[21]) * page,
        cpu: (Number(f[11]) + Number(f[12])) / tick,
        kids: (Number(f[13]) + Number(f[14])) / tick,
      });
    } catch {}
  }
  return out;
}

// ps's [[h:]m]m:ss.ss as seconds
const psTime = (t: string) => t.split(/[:-]/).reduce((s, x) => s * 60 + Number(x), 0);

// ps -S: each one's time with its ended children's summed in
function listDarwin(): P[] {
  const r = runSync(["ps", "-axww", "-o", "pid=,ppid=,rss=,time=,command="]);
  const withKids = new Map<number, number>();
  for (const l of runSync(["ps", "-axS", "-o", "pid=,time="]).stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)/.exec(l);
    if (m) withKids.set(+m[1]!, psTime(m[2]!));
  }
  return r.stdout
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      const cmd = m[5]!;
      const name = (cmd.split(" ")[0] ?? "").split("/").pop() ?? "";
      const cpu = psTime(m[4]!);
      const kids = Math.max(0, (withKids.get(+m[1]!) ?? cpu) - cpu);
      return { pid: +m[1]!, ppid: +m[2]!, name, cmd, role: "", rss: +m[3]! * 1024, cpu, kids };
    });
}

// where phosphorus's own binaries live: the home's bin and tools, the Windows app's folder
function ownDirs(): string[] {
  const state = env("STATE_DIR", StateDir);
  const dirs = [join(dirname(state), "bin"), join(state, "cache")];
  try {
    const app = readFileSync(join(state, "app-dir"), "utf8").trim();
    if (app) dirs.push(app);
  } catch {}
  return dirs.map((d) => fold(d.replace(/[\\/]+$/, "") + sep));
}

// paths compared as Windows compares them, case and slashes folded
const fold = (s: string) => (process.platform === "win32" ? s.toLowerCase().replaceAll("/", "\\") : s);

// every process this account can see, roles resolved
export const list = (): P[] => snapshot().procs;

// the processes, and on Windows the job run keeps them all in
export function snapshot(): { procs: P[]; job?: Job } {
  let out: P[];
  try {
    out = process.platform === "linux" ? listLinux() : process.platform === "darwin" ? listDarwin() : listWindows();
  } catch {
    return { procs: [] };
  }
  const known = readRoles();
  let job: Job | undefined;
  if (process.platform === "win32") {
    const run = [...known].find(([, r]) => r === "run")?.[0];
    try {
      job = run ? readJob(run) : undefined;
    } catch {}
  }
  for (const p of out) p.role ||= known.get(p.pid) ?? "";
  const byPID = new Map(out.map((p) => [p.pid, p]));
  // unlabelled descendants of a recorded child take its role
  for (const p of out) {
    if (p.role) continue;
    const seen = new Set<number>();
    for (let at = p.ppid; at > 1 && !seen.has(at); ) {
      seen.add(at);
      const r = known.get(at);
      if (r) {
        p.role = r;
        break;
      }
      const q = byPID.get(at);
      if (!q) break;
      if (q.role && !known.get(q.pid)) {
        p.role = q.role;
        break;
      }
      at = q.ppid;
    }
  }
  // the rest phosphorus's when in run's job or started from its own binaries, named for the binary
  const dirs = ownDirs();
  for (const p of out) {
    if (p.role) continue;
    const exe = fold(p.cmd.replace(/^"/, ""));
    if (job?.pids.has(p.pid) || dirs.some((d) => exe.startsWith(d)))
      p.role = (p.name || basename(exe)).replace(/\.exe$/i, "").toLowerCase();
  }
  return { procs: out, job };
}
