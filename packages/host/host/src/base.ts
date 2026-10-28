// the host's shared state and small helpers: the home, the log's tag and
// stamp, where output goes once run logs to a file, and child processes

import { existsSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { parseIni, which } from "@phosphorus/util";
import type { Subprocess } from "bun";

export const isLinux = process.platform === "linux";
export const isMac = process.platform === "darwin";
export const isWindows = process.platform === "win32";

export let home = "";
export const setHome = (h: string) => void (home = h);
export let tag = "phosphorus";
export const setTag = (t: string) => void (tag = t);

// a child's exit code, passed on silently
export class ExitCode extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

export const fail = (msg: string) => new Error(msg);

export function homeDir(): string {
  const h = process.env.PHOSPHORUS_HOME;
  if (h) return h;
  // not %LOCALAPPDATA%\Phosphorus: the app's own install dir, wiped by its uninstaller
  if (isWindows) return join(process.env.USERPROFILE ?? "", "phosphorus");
  if (isMac) return join(process.env.HOME ?? "", "Library", "Phosphorus");
  return "/var/lib/phosphorus";
}

// --- output: the terminal, or the log file once run opens it --------------------------

let outFd: number | undefined;
// the log a file with no clock of its own, journald's on Linux
let stamped = false;

export function logTo(fd: number) {
  outFd = fd;
  stamped = true;
}

// what children inherit for stdout and stderr
export const stdio = (): number | "inherit" => outFd ?? "inherit";

export function print(s: string) {
  if (outFd !== undefined) writeSync(outFd, s);
  else process.stdout.write(s);
}

export function eprint(s: string) {
  if (outFd !== undefined) writeSync(outFd, s);
  else process.stderr.write(s);
}

// a line's time where the log keeps none: 2006-01-02T15:04:05-0700
export function stamp(): string {
  if (!stamped) return "";
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  const tz = sign + p(Math.floor(Math.abs(off) / 60)) + p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${tz} `;
}

export const say = (msg: string) => print(`${stamp()}[${tag}] ${msg}\n`);
export const println = (msg = "") => print(msg + "\n");

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- the home's files ------------------------------------------------------------------

export const at = (...p: string[]) => join(home, ...p);
export const fileExists = (p: string) => existsSync(p);

export function readTrim(p: string): string {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

export const version = () => readTrim(at("VERSION"));
export const envPath = () => at(".env");
export const keysMissing = () => envfile.missing(envPath()).length > 0;

const dev = Bun.main.endsWith(".ts");

// this binary, symlinks resolved; bun itself when run from the source
export function exe(): string {
  try {
    return realpathSync(process.execPath);
  } catch {
    return process.execPath;
  }
}

// how to run this program again: the compiled binary, or bun with the script
export const selfArgv = (): string[] => (dev ? [process.execPath, Bun.main] : [exe()]);

// binPath the home's own copy, what PATH and the forced command point at
export const binPath = (name: string) => at("bin", isWindows ? name + ".exe" : name);

// --- phosphorus.ini ------------------------------------------------------------------

export const iniFile = () => at("config", "phosphorus.ini");
// the git role's daemon script and templates, shipped with its package
export const gitd = (f: string) => at("packages", "mesh", "git", "gitd", f);

export function iniGet(section: string, key: string): string {
  let text = "";
  try {
    text = readFileSync(iniFile(), "utf8");
  } catch {}
  return parseIni(text).get(section + "\0" + key) ?? "";
}

// Linux alone: forgejo and the git daemon ship for it only
export const isGitHost = () => isLinux && iniGet("git", "host") === "true";
export const isModelHost = () => iniGet("model", "host") === "true";

export const has = (name: string) => which(name) !== "";

// inDpkg inside a package's maintainer script, dpkg's lock held
export const inDpkg = () => !!process.env.DPKG_MAINTSCRIPT_PACKAGE;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// --- child processes ------------------------------------------------------------------

export type SpawnOpts = {
  env?: Record<string, string | undefined>;
  cwd?: string;
  input?: string;
  stdin?: "inherit" | "ignore";
};

// argv run on this terminal (or the log), its exit code; -1 when it can't
// start; no stdin unless asked for, as Go's exec gave none
export async function spawnIO(argv: string[], o: SpawnOpts = {}): Promise<number> {
  try {
    const p = Bun.spawn(argv, {
      cwd: o.cwd,
      env: o.env as Record<string, string> | undefined,
      stdin: o.input !== undefined ? new Blob([o.input]) : (o.stdin ?? "ignore"),
      stdout: stdio(),
      stderr: stdio(),
      windowsHide: true,
    });
    return await p.exited;
  } catch {
    return -1;
  }
}

// run a host command, its output on this terminal: true when it exited 0
export const run = async (...argv: string[]) => (await spawnIO(argv)) === 0;

export async function quiet(...argv: string[]): Promise<boolean> {
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

// a command's stdout, trimmed; "" when it can't run
export async function output(...argv: string[]): Promise<string> {
  try {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
    const [out] = await Promise.all([new Response(p.stdout).text(), p.exited]);
    return out.trim();
  } catch {
    return "";
  }
}

// argv run with its stdout and stderr both captured, and printed too when tee
export async function capture(
  argv: string[],
  tee: boolean,
  env?: Record<string, string | undefined>,
): Promise<{ out: string; code: number }> {
  let p: Subprocess<"ignore", "pipe", "pipe">;
  try {
    p = Bun.spawn(argv, {
      env: env as Record<string, string> | undefined,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (e) {
    return { out: errText(e), code: -1 };
  }
  let out = "";
  const drain = async (s: ReadableStream<Uint8Array>, write: (t: string) => void) => {
    const dec = new TextDecoder();
    for await (const chunk of s) {
      const t = dec.decode(chunk, { stream: true });
      out += t;
      if (tee) write(t);
    }
  };
  const [, , code] = await Promise.all([drain(p.stdout, print), drain(p.stderr, eprint), p.exited]);
  return { out, code };
}

export function lockEnv() {
  if (fileExists(envPath())) envfile.lock(envPath());
}

// a file's size and mtime in ns, undefined when missing
export function statOf(p: string): { size: number; mtimeNs: bigint } | undefined {
  try {
    const st = statSync(p, { bigint: true });
    return { size: Number(st.size), mtimeNs: st.mtimeNs };
  } catch {
    return undefined;
  }
}

export const splitLines = (text: string) => text.replaceAll("\r\n", "\n").replace(/\n$/, "").split("\n");

// last of the lines matching re, any line when none given
export function lastLine(text: string, re?: RegExp): string {
  const ls = text.trim().split("\n");
  for (let i = ls.length - 1; i >= 0; i--) if (!re || re.test(ls[i]!)) return ls[i]!;
  return "";
}

// sshdUp something answering on 22, the frontend's terminals logging in there
export function sshdUp(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port: 22 });
    const end = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(1000, () => end(false));
    s.once("connect", () => end(true));
    s.once("error", () => end(false));
  });
}

// the Include line for state/ssh_config, one Host per tailnet peer
export const sshInclude = () => `Include "${at("state", "ssh_config").replaceAll("\\", "/")}"`;

// openLog state/phosphorus.log appended to, the previous one kept as .1 once past 20MB
export function openLog(): number | undefined {
  const p = at("state", "phosphorus.log");
  const st = statOf(p);
  if (st && st.size > 20 << 20) {
    rmSync(p + ".1", { force: true });
    try {
      renameSync(p, p + ".1");
    } catch {}
  }
  try {
    return openSync(p, "a", 0o644);
  } catch {
    return undefined;
  }
}

// durText a duration as Go prints one: 5s, 1m0s
export function durText(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}
