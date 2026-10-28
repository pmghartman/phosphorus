// the mesh as this module sees it, set at Start and swapped in tests
import { readFileSync } from "node:fs";
import { tick } from "./jobs.ts";
import { sshRun } from "./runner.ts";

export type Login = { user: string; pass: string };
// Runner a script run on host as login to its end, each chunk of output to onOut; the exit code
export type Runner = (host: string, login: Login, script: string, onOut: (s: string) => void, timeoutMs: number) => Promise<number>;
// PublishLocal this host's services.export: [name] set to fields, or dropped with null
export type PublishLocal = (name: string, fields: Record<string, string> | null) => Promise<[number, any]>;
// Device a tailnet device as mesh.tailnet lists it
export type Device = { name?: unknown; os?: unknown; phosphorus?: unknown };
// Route a published service as mesh.routes lists it
export type Route = { host?: unknown; name?: unknown; port?: unknown; mode?: unknown; base_path?: unknown; scheme?: unknown; type?: unknown; public?: unknown };
// Progress what a host says of a step on it, in its info: the log's tail, the exit once there
export type Progress = { log: string; exit?: number };

export const seams: {
  routes: () => Route[];
  tailnet: () => Device[];
  run: Runner;
  publishLocal: PublishLocal;
  ipOf: (host: string) => string | Promise<string>;
  // a host's info as the mesh has it, its services' progress in it
  hostInfo: (host: string) => Record<string, any> | undefined;
  // a login's home on this host
  homeOf: (login: string) => string;
  // JSON from a url, undefined when it can't be had: GitHub's API
  fetchJSON: (url: string) => Promise<any>;
  // bytes and their type from a url: an icon off the repository
  fetchBytes: (url: string) => Promise<{ data: Uint8Array; type: string } | undefined>;
} = {
  routes: () => [],
  tailnet: () => [],
  run: sshRun,
  publishLocal: async () => [503, { error: "the mesh isn't up yet" }],
  ipOf: () => "",
  hostInfo: () => undefined,
  homeOf: passwdHome,
  fetchJSON: async (url) => {
    const r = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "phosphorus" }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return r.json();
  },
  fetchBytes: async (url) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    return { data: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") ?? "" };
  },
};

// the module's variables other modules set
export const meshVars = {
  ticker: undefined as unknown as ReturnType<typeof setInterval> | undefined,
};

export function Start(s: Partial<typeof seams>, tickMS = 3000) {
  Object.assign(seams, s);
  if (meshVars.ticker) clearInterval(meshVars.ticker);
  meshVars.ticker = setInterval(() => void tick(), tickMS);
  void tick();
}

// a login's home from /etc/passwd, /home/<login> when it isn't there
export function passwdHome(login: string): string {
  try {
    for (const l of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = l.split(":");
      if (f[0] === login && f[5]) return f[5];
    }
  } catch {}
  return "/home/" + login;
}
