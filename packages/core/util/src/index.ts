// env, JSON files on disk, JSON over HTTP, this host's settings, tailnet name
// lookups and change-only logging
import {
  closeSync,
  fdatasyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env, envInt } from "./env.ts";
import { type HostConfig, readConfig } from "./hostconf.ts";
import { logf } from "./log.ts";
import { run } from "./proc.ts";

export * from "./acl.ts";
export * from "./clock.ts";
export { env, envInt } from "./env.ts";
export * from "./hostconf.ts";
export * from "./log.ts";
export * from "./net.ts";
export { hasNvidia, type NvGpu, nvidiaGpus } from "./nvml.ts";
export * from "./proc.ts";

export const FrontendPort = envInt("FRONTEND_PORT", 8090);
// the frontend's exit asking run to start it again with the mesh's new domain
export const RestartExit = 75;
export const SelfHost = process.env.SELF_HOST ?? "";
// the install, phosphorus run's PHOSPHORUS_HOME
export const RepoDir = env("PHOSPHORUS_REPO_DIR", env("PHOSPHORUS_HOME", "/var/lib/phosphorus"));
export const StateDir = env("STATE_DIR", join(RepoDir, "state"));
export * from "./statedir.ts";
// the replicated store, never inside a user's reach
export const SysDir = env("PHOSPHORUS_SYS_DIR", join(RepoDir, "sys"));

export const now = () => Date.now();
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// this host's settings, re-read only when changed
export const hostConfig = (): HostConfig => readConfig({ sys: SysDir, state: StateDir, self: SelfHost });

// a file's JSON, undefined on any failure
export function readJSON<T = any>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

// a file's JSON as an object, undefined when it isn't one
export function readJSONMap(file: string): Record<string, any> | undefined {
  return obj(readJSON(file));
}

const fresh = new Map<string, { sig: string; value: unknown }>();

// a daemon's json while refreshed within maxAgeMs, else undefined
export function readFresh(file: string, maxAgeMs: number): any {
  let sig: string;
  try {
    const st = statSync(file, { bigint: true });
    if (Date.now() - Number(st.mtimeMs) > maxAgeMs) return undefined;
    sig = `${st.ino}:${st.mtimeNs}:${st.size}`;
  } catch {
    return undefined;
  }
  const hit = fresh.get(file);
  if (hit && hit.sig === sig) return hit.value;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8")) ?? undefined;
  } catch {}
  fresh.set(file, { sig, value });
  return value;
}

// JSON.stringify, "null" for what it can't encode
export function marshal(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "null";
  } catch {
    return "null";
  }
}

// temp then rename, a reader never sees half a file
export function writeFileAtomic(file: string, data: string | Uint8Array) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o644 });
  renameSync(tmp, file);
}

export const writeJSONAtomic = (file: string, v: unknown) => writeFileAtomic(file, marshal(v));

// writeFileAtomic, on the disk before it replaces the old one
export function writeFileDurable(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, data);
    fdatasyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

const soonDue = new Map<string, { d: string; durable: boolean }>();
const soonBusy = new Map<string, Promise<void>>();

// off the hot path, one write in flight per file, latest next; durable flushed to
// the disk before it replaces the old one
export function writeSoon(file: string, d: string, durable = false) {
  soonDue.set(file, { d, durable });
  if (soonBusy.has(file)) return;
  const p = (async () => {
    for (let w = soonDue.get(file); w; w = soonDue.get(file)) {
      soonDue.delete(file);
      const tmp = `${file}.${process.pid}.soon.tmp`;
      try {
        const fh = await open(tmp, "w", 0o644);
        try {
          await fh.writeFile(w.d);
          if (w.durable) await fh.datasync();
        } finally {
          await fh.close();
        }
        await rename(tmp, file);
      } catch (e) {
        logf("[frontend] couldn't write %s: %s", file, errText(e));
      }
    }
    soonBusy.delete(file);
  })();
  soonBusy.set(file, p);
}

export const writeJSONSoon = (file: string, v: unknown) => writeSoon(file, marshal(v));

// every pending write done, for shutdown; ten seconds at most
export async function flushWrites() {
  const end = Date.now() + 10_000;
  while (soonBusy.size && Date.now() < end)
    await Promise.race([Promise.all([...soonBusy.values()]), sleep(Math.max(0, end - Date.now()))]);
}

export type Response = { status: number; body: any; text: string };
export type Req = {
  host?: string;
  port: number;
  method?: string;
  path: string;
  // undefined: none
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

// one request, rejecting only on a failed request; body undefined for non-JSON
export async function requestJSON(r: Req): Promise<Response> {
  const host = r.host || "127.0.0.1";
  const url = `http://${host.includes(":") ? `[${host}]` : host}:${r.port}${r.path}`;
  const signals = [r.signal, r.timeoutMs ? AbortSignal.timeout(r.timeoutMs) : undefined].filter(
    Boolean,
  ) as AbortSignal[];
  const headers: Record<string, string> = { ...r.headers };
  if (r.body !== undefined) headers["Content-Type"] = "application/json";
  let res: globalThis.Response;
  try {
    res = await fetch(url, {
      method: r.method || "GET",
      headers,
      body: r.body !== undefined ? marshal(r.body) : undefined,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError") throw new Error("timed out");
    throw e;
  }
  const text = await res.text();
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: res.status, body, text };
}

// [status, body] from a peer's frontend, never failing, a non-JSON answer as the error text
export async function peerCall(host: string, r: Omit<Req, "port">): Promise<[number, any]> {
  let res: Response;
  try {
    res = await requestJSON({ ...r, port: FrontendPort });
  } catch (e) {
    return [502, { error: `${host} didn't answer: ${errText(e)}` }];
  }
  if (res.body !== undefined && res.body !== null) return [res.status, res.body];
  return [res.status, { error: res.text.trim() || `status ${res.status}` }];
}

export const mkdirParent = (file: string, mode = 0o755) => void mkdirSync(dirname(file), { recursive: true, mode });

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// an object, undefined when v isn't one
export const obj = (v: unknown): Record<string, any> | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : undefined;

const collator = new Intl.Collator("und");
// String.prototype.localeCompare under ICU's root order, ties broken by code units
export function localeCompare(a: string, b: string): number {
  return Math.sign(collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0));
}
