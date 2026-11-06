// the host's commands, keys, service state and update-agent file: the host binary
// run on Windows, the root daemon asked over its socket on macOS
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirParent, type RunResult, readJSON, run, sleep, writeJSONAtomic } from "@phosphorus/util";
import { call, type Reply } from "./ctl.ts";
import { app, darwin, logDir, read } from "./os.ts";

// the host binary, no console window, the home passed along
export const hostCmd = (args: string[], input?: string) => run([app.host, ...args, "--home", app.home], { input });

// where a failure's detail is
export const logHint = darwin
  ? "see /Library/Phosphorus/state/log and ~/Library/Logs/Phosphorus"
  : "see state/log/ in the Phosphorus folder";

// a host command's result, its output kept in the tray's log dir as <log>.log
export async function hostRun(log: string, ...args: string[]): Promise<RunResult> {
  const r = await hostCmd(args);
  keepLog(log, r.output);
  return r;
}

function keepLog(log: string, text: string) {
  try {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, log + ".log"), text);
  } catch {}
}

// the daemon's reply as a host command's result, its error an ERROR line
export function asRun(r: Reply): RunResult {
  let out = typeof r.output === "string" ? r.output : "";
  if (!r.ok && r.error) out += `\n[tray] ERROR: ${r.error}\n`;
  return { ok: r.ok, code: r.ok ? 0 : 1, stdout: out, stderr: "", output: out };
}

// the last ERROR line of a host command's output, "" without one
export function lastError(text: string): string {
  let e = "";
  for (const l of text.split("\n")) if (l.includes("ERROR")) e = l.trim();
  return e;
}

export type KeyState = { keys: Record<string, boolean>; domain: string };

// which keys .env holds, never their values, and the mesh's domain: one host run
export async function keyState(): Promise<KeyState> {
  let m: Partial<KeyState> | undefined;
  if (darwin) m = (await call({ op: "keys" })) as Partial<KeyState>;
  else {
    const r = await hostRun("keys", "keys", "--state");
    try {
      m = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
    } catch {}
  }
  return { keys: m?.keys ?? {}, domain: m?.domain ?? "" };
}

export const keyStatus = async () => (await keyState()).keys;

export const keysMissing = async () => {
  const k = await keyStatus();
  return !k.MESH_KEY;
};

// the typed keys into .env, KEY=value lines
export async function setKeys(body: string): Promise<RunResult> {
  if (darwin) return asRun(await call({ op: "keys-set", text: body }));
  return hostCmd(["keys", "--stdin"], body);
}

// whether the service and Tailscale are up, both false when the host can't say
export async function hostState(): Promise<{ running: boolean; vpn: boolean }> {
  if (darwin) {
    const r = await call({ op: "status" });
    return { running: r.ok && !!r.running, vpn: r.ok && !!r.vpn };
  }
  const r = await hostCmd(["status", "--json"]);
  try {
    const v = JSON.parse(r.stdout);
    return { running: !!v.running, vpn: !!v.vpn };
  } catch {
    return { running: false, vpn: false };
  }
}

// daemonRun one of the daemon's commands; dropped while it restarts itself, the
// status then waited on and the command's own log read
async function daemonRun(op: string, want: boolean): Promise<RunResult> {
  const r = await call({ op }, 6 * 60_000);
  if (!r.dropped) {
    keepLog(op, typeof r.output === "string" ? r.output : (r.error ?? ""));
    return asRun(r);
  }
  for (const end = Date.now() + 3 * 60_000; Date.now() < end; await sleep(2000))
    if ((await hostState()).running === want) return asRun({ ok: true, output: read(daemonLog(op)) });
  return asRun({ ok: false, output: read(daemonLog(op)), error: r.error });
}

const daemonLog = (op: string) => join(app.home, "state", "log", op + ".log");

// start or stop phosphorus; on macOS its daemon kept, its children held or resumed
export const service = (action: "start" | "stop") =>
  darwin ? daemonRun(action, action === "start") : hostRun(action, action);

// this release applied again, config kept: the daemon's rebuild on macOS
export const reapply = () =>
  darwin ? daemonRun("rebuild", true) : hostRun("install", "install", "--update", "--payload", app.payload);

export const payloadVersion = () => read(join(app.payload, "VERSION"));

export const installedVersion = () => read(join(app.home, ".phosphorus-installed"));

// a domain's https, else this host's own frontend over the tailnet's port
export const frontendURL = (d: string) => (d ? `https://${d}/` : "http://localhost/");

export const updateAgentFile = join(app.home, "state/update-agent.json");
const requestFile = join(app.home, "state/update-request.json");

// what the frontend and `phosphorus update` wait on
export async function report(
  id: string,
  state: "running" | "ok" | "failed",
  current: boolean,
  version: string,
  error: string,
) {
  error = error.slice(0, 400);
  if (darwin) return void (await call({ op: "report", id, state, current, version, error }));
  mkdirParent(updateAgentFile);
  writeJSONAtomic(updateAgentFile, { id, state, current, version, error, at: Date.now() });
}

// takeRequest a pending update request's id, consumed; undefined with none
export async function takeRequest(): Promise<string | undefined> {
  if (darwin) {
    const r = await call({ op: "take-request" });
    return typeof r.id === "string" ? r.id : undefined;
  }
  const r = readJSON<{ id?: string }>(requestFile);
  if (!r) return undefined;
  rmSync(requestFile, { force: true });
  return r.id ?? "";
}

// daemonUpdate the downloaded bundle handed to the daemon, which checks its
// signature itself and installs its release; its verdict waited on
export async function daemonUpdate(id: string, file: string, signature: string) {
  const r = await call({ op: "update", id, file, signature }, 5 * 60_000);
  if (!r.ok) throw new Error(r.error ?? "the daemon refused the update");
  for (const end = Date.now() + 20 * 60_000; Date.now() < end; await sleep(2000)) {
    const a = readJSON<{ id?: string; state?: string; error?: string }>(updateAgentFile);
    if (a?.id !== id) continue;
    if (a.state === "failed") throw new Error(a.error || "the update failed");
    if (a.state === "ok") return;
  }
  throw new Error(`the update is taking too long, ${logHint}`);
}
