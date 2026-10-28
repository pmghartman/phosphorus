// every process with its phosphorus role on any OS: from PHOSPHORUS_ROLE where
// readable, else the nearest ancestor in state/roles.json
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, runSync, StateDir } from "@phosphorus/util";
import { listWindows } from "./win32.ts";

// one process; cpu: seconds since it started, user and system
export type P = { pid: number; ppid: number; name: string; cmd: string; role: string; rss: number; cpu: number };

// phosphorus run's own children by pid, STATE_DIR read late: run sets it after start
export const rolesFile = () => join(env("STATE_DIR", StateDir), "roles.json");

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
      });
    } catch {}
  }
  return out;
}

// ps's [[h:]m]m:ss.ss as seconds
const psTime = (t: string) => t.split(/[:-]/).reduce((s, x) => s * 60 + Number(x), 0);

function listDarwin(): P[] {
  const r = runSync(["ps", "-axww", "-o", "pid=,ppid=,rss=,time=,command="]);
  return r.stdout
    .split("\n")
    .map((l) => /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => {
      const cmd = m[5]!;
      const name = (cmd.split(" ")[0] ?? "").split("/").pop() ?? "";
      return { pid: +m[1]!, ppid: +m[2]!, name, cmd, role: "", rss: +m[3]! * 1024, cpu: psTime(m[4]!) };
    });
}

// every process this account can see, roles resolved
export function list(): P[] {
  let out: P[];
  try {
    out = process.platform === "linux" ? listLinux() : process.platform === "darwin" ? listDarwin() : listWindows();
  } catch {
    return [];
  }
  const known = readRoles();
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
  return out;
}

// the processes carrying a phosphorus role
export const ours = () => list().filter((p) => p.role);
