// child processes run to completion, their output and exit; no console window
// on Windows
import { spawn, spawnSync } from "bun";

export type RunResult = { ok: boolean; code: number; stdout: string; stderr: string; output: string; error?: string };
export type RunOpts = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  input?: string | Uint8Array;
  timeoutMs?: number;
  signal?: AbortSignal;
};

const fail = (e: unknown): RunResult => {
  const error = e instanceof Error ? e.message : String(e);
  return { ok: false, code: -1, stdout: "", stderr: error, output: error, error };
};

const stdinOf = (input: RunOpts["input"]) => (input !== undefined ? new Blob([input as BlobPart]) : "ignore");

// argv run, never throwing: a missing binary is ok false with its error
export async function run(argv: string[], o: RunOpts = {}): Promise<RunResult> {
  let p;
  try {
    p = spawn(argv, {
      cwd: o.cwd,
      env: o.env as Record<string, string> | undefined,
      stdin: stdinOf(o.input),
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      timeout: o.timeoutMs,
      signal: o.signal,
    });
  } catch (e) {
    return fail(e);
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { ok: code === 0, code, stdout, stderr, output: stdout + stderr };
}

// run's synchronous twin, for startup and the cli
export function runSync(argv: string[], o: Omit<RunOpts, "signal"> = {}): RunResult {
  try {
    const p = spawnSync(argv, {
      cwd: o.cwd,
      env: o.env as Record<string, string> | undefined,
      stdin: stdinOf(o.input),
      windowsHide: true,
      timeout: o.timeoutMs,
    });
    const stdout = p.stdout?.toString() ?? "";
    const stderr = p.stderr?.toString() ?? "";
    const code = p.exitCode ?? -1;
    return { ok: code === 0, code, stdout, stderr, output: stdout + stderr };
  } catch (e) {
    return fail(e);
  }
}

// a binary on PATH, "" when not found
export const which = (name: string) => Bun.which(name) ?? "";

// argv started in its own session on unix, nothing of this process's handed
// to it, a failure to start ignored
export function spawnDetached(argv: string[]) {
  try {
    Bun.spawn(argv, {
      detached: process.platform !== "win32",
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    }).unref();
  } catch {}
}

// startDetached argv in its own session, run after delayMs, outliving this process
export function startDetached(argv: string[], delayMs: number) {
  setTimeout(() => spawnDetached(argv), delayMs);
}
