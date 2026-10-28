// the host binary's commands (this same binary, phosphorus-host), their output
// kept in state/, what it says of the keys and the service, and the update-agent
// file the frontend and `phosphorus update` wait on
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirParent, type RunResult, run, writeJSONAtomic } from "@phosphorus/util";
import { app, read } from "./os.ts";

// the host binary, no console window, the home passed along
export const hostCmd = (args: string[], input?: string) => run([app.host, ...args, "--home", app.home], { input });

// a host command's result, its output kept in state/<log>.log
export async function hostRun(log: string, ...args: string[]): Promise<RunResult> {
  mkdirSync(join(app.home, "state"), { recursive: true });
  const r = await hostCmd(args);
  writeFileSync(join(app.home, "state", log + ".log"), r.output);
  return r;
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
  const r = await hostRun("keys", "keys", "--state");
  let m: Partial<KeyState> | undefined;
  try {
    m = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
  } catch {}
  return { keys: m?.keys ?? {}, domain: m?.domain ?? "" };
}

export const keyStatus = async () => (await keyState()).keys;

export const keysMissing = async () => !(await keyStatus()).TS_AUTHKEY;

// whether the service and Tailscale are up, both false when the host can't say
export async function hostState(): Promise<{ running: boolean; vpn: boolean }> {
  const r = await hostCmd(["status", "--json"]);
  try {
    const v = JSON.parse(r.stdout);
    return { running: !!v.running, vpn: !!v.vpn };
  } catch {
    return { running: false, vpn: false };
  }
}

export const payloadVersion = () => read(join(app.payload, "VERSION"));

export const installedVersion = () => read(join(app.home, ".phosphorus-installed"));

// a domain's https, else this host's own frontend over the tailnet's port
export const frontendURL = (d: string) => (d ? `https://${d}/` : "http://localhost/");

export const updateAgentFile = join(app.home, "state/update-agent.json");

// what the frontend and `phosphorus update` wait on
export function report(
  id: string,
  state: "running" | "ok" | "failed",
  current: boolean,
  version: string,
  error: string,
) {
  mkdirParent(updateAgentFile);
  writeJSONAtomic(updateAgentFile, { id, state, current, version, error: error.slice(0, 400), at: Date.now() });
}
