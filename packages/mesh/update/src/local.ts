// this host's own update, and a peer's followed to its end
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  env,
  errText,
  FrontendPort,
  intervalMS,
  now,
  obj,
  RepoDir,
  type Req,
  readJSONMap,
  requestJSON,
  StateDir,
  sleep,
  tailnetIP,
  writeJSONAtomic,
} from "@phosphorus/util";

export const VersionFile = env("VERSION_FILE", join(RepoDir, "VERSION"));
const requestFile = join(StateDir, "update-request.json");
const agentFile = join(StateDir, "update-agent.json");

export const agentPickupMS = 60000;
export const updateTimeoutMS = 1200000;
export const connectTimeoutMS = 2000;
export const swapTimeoutMS = 120000;
export const peerQuietMS = 180000;
export const peerCapMS = 1800000;

// Go's truthy: false, nil, 0, NaN and "" are false
export const truthy = (v: unknown) => (typeof v === "number" ? v !== 0 && !Number.isNaN(v) : !!v);
// as a JS template literal renders a JSON value
export const jsString = (v: unknown): string =>
  v == null
    ? "null"
    : Array.isArray(v)
      ? v.map((e) => (e == null ? "" : jsString(e))).join(",")
      : typeof v === "object"
        ? "[object Object]"
        : String(v);
export const str = (v: unknown) => (truthy(v) ? jsString(v) : "");

// a VERSION file trimmed, "" when unreadable
export function readVersion(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export type Result = { ok: boolean; current: boolean; to: string; error: string; unreachable: boolean };
export const result = (p: Partial<Result> = {}): Result => ({
  ok: false,
  current: false,
  to: "",
  error: "",
  unreachable: false,
  ...p,
});
const settled = (r: Result) => r.ok || r.error !== "";

let failedHook = () => {};

// server's, for an update here that ended without a new release
export const onFailed = (fn: () => void) => void (failedHook = fn);

// a random v4 id
export const uuid = () => randomUUID();

// the host's agent (the systemd path unit, the app) answers a request through
// agentFile: the request's id, then running, ok or failed
const readAgent = () => readJSONMap(agentFile);

// a verdict from an agent's or a peer's status: ok or an error, neither while running
export function verdict(a: Record<string, any>): Result {
  switch (a.state) {
    case "ok":
      return result({ ok: true, current: truthy(a.current), to: str(a.version) || readVersion(VersionFile) });
    case "failed":
      return result({ error: (str(a.error) || "update failed").slice(0, 500) });
  }
  return result();
}

// one update here, shared by everyone who asks while it runs
export type Request = { id: string; wait: () => Promise<Result> };

let inFlight: Request | undefined;

// hands an update to this host's agent, or joins the one already running;
// throws when the request can't be written
export function ask(): Request {
  if (inFlight) return inFlight;
  const id = uuid();
  try {
    writeJSONAtomic(requestFile, { id, at: now() });
  } catch (e) {
    throw new Error(`couldn't request the update: ${errText(e)}`);
  }
  const done = awaitAgent(id).then((r) => {
    inFlight = undefined;
    if (!r.ok) failedHook();
    return r;
  });
  return (inFlight = { id, wait: () => done });
}

// the agent's verdict on a request, an unanswered one withdrawn
async function awaitAgent(id: string): Promise<Result> {
  const started = now();
  while (now() - started < updateTimeoutMS) {
    await seams.pause();
    const a = readAgent();
    if (!a || a.id !== id) {
      if (now() - started > agentPickupMS && existsSync(requestFile)) {
        rmSync(requestFile, { force: true });
        return result({ error: "no update agent on this host: reinstall from the latest release" });
      }
      continue;
    }
    const r = verdict(a);
    if (settled(r)) return r;
  }
  return result({ error: "update timed out" });
}

// this host's update as its peers read it: the request in flight, else the
// agent's last word
export function status(): Record<string, any> {
  const a = readAgent();
  const q = inFlight;
  if (q && (!a || a.id !== q.id)) return { id: q.id, state: "asked" };
  if (!a) return { state: "idle" };
  return {
    id: a.id ?? null,
    state: a.state ?? null,
    current: truthy(a.current),
    version: a.version ?? null,
    error: a.error ?? null,
  };
}

// while an update here is asked for or running
export function busy(): boolean {
  const s = status().state;
  return s === "asked" || s === "running";
}

// this host's update after its own restart: the agent's verdict on the request
// the chain made, never assumed from the restart alone
export async function settleSelf(id: string): Promise<Result> {
  if (!id) return result({ error: "restarted before the update was asked for" });
  for (const until = now() + peerQuietMS; now() < until; await seams.pause()) {
    const a = readAgent();
    if (a && a.id === id) {
      const r = verdict(a);
      if (settled(r)) return r;
    }
  }
  return result({ error: "the update never finished after this host restarted" });
}

// --- peers ------------------------------------------------------------------

const peerReq = (host: string, r: Omit<Req, "port" | "host">) =>
  requestJSON({ ...r, host, port: FrontendPort, timeoutMs: r.timeoutMs || connectTimeoutMS });

export type SelfInfo = { bootID: string; version: string; platform: string };

// a peer's update asked for: the id to follow it by
async function askPeerHTTP(host: string): Promise<[string, Result]> {
  let r;
  try {
    r = await peerReq(host, { method: "POST", path: "/api/update/local", body: {} });
  } catch (e) {
    return ["", result({ unreachable: true, error: errText(e) })];
  }
  const m = obj(r.body);
  if (r.status === 202) {
    const id = str(m?.id);
    return id ? [id, result()] : ["", result({ error: "the host didn't name its update" })];
  }
  const e = m && truthy(m.error) ? jsString(m.error) : `status ${r.status}`;
  return ["", result({ error: e.slice(0, 500) })];
}

async function peerStateHTTP(host: string): Promise<Record<string, any>> {
  const r = await peerReq(host, { path: "/api/update/local/status" });
  const m = obj(r.body);
  if (!m) throw new Error("unreadable status");
  return m;
}

async function peerSelfHTTP(host: string): Promise<SelfInfo> {
  try {
    const r = await peerReq(host, { path: "/api/mesh/snapshot" });
    const s = obj(obj(r.body)?.self) ?? {};
    return { bootID: str(s.bootId), version: str(s.version), platform: str(s.platform) };
  } catch {
    return { bootID: "", version: "", platform: "" };
  }
}

// a peer's pace and eyes, and this host's forgetting, swapped for fakes in tests
export const seams = {
  pause: () => sleep(intervalMS()),
  askPeer: askPeerHTTP,
  peerState: peerStateHTTP,
  peerSelf: peerSelfHTTP,
  peerAddr: async (host: string) => (await tailnetIP(host)) || host,
  inFlight: () => inFlight,
  reset() {
    inFlight = undefined;
    failedHook = () => {};
  },
};

export type Note = (fields: Record<string, string>) => void;

// a peer's update asked for and followed, its id and boot noted so a watch
// picked up after this host restarts goes on
export async function callPeerUpdate(host: string, note: Note): Promise<Result> {
  const addr = await seams.peerAddr(host);
  const before = await seams.peerSelf(addr);
  const [id, r] = await seams.askPeer(addr);
  if (!id) return r;
  note({ from: before.version, boot: before.bootID, id });
  return watchPeer(host, id, before.version, before.bootID, "asked", note);
}

// a peer's update, found by its id, followed to its verdict: its agent's, then
// its new boot
export async function watchPeer(
  host: string,
  id: string,
  fromVersion: string,
  fromBoot: string,
  stage: string,
  note: Note,
): Promise<Result> {
  const addr = await seams.peerAddr(host);
  // the stage each progress bar weighs the host by, every peer at once
  const at = (s: string) => {
    if (s !== stage) {
      stage = s;
      note({ stage: s });
    }
  };
  note({ stage });
  const capAt = now() + peerCapMS;
  let quietUntil = now() + peerQuietMS;
  let swapDeadline = 0;
  while (now() < capAt) {
    await seams.pause();
    let status: Record<string, any>;
    try {
      status = await seams.peerState(addr);
    } catch {
      // silent once installing: its service restarting onto the new release
      if (stage === "installing") at("restarting");
      if (now() > quietUntil) return result({ unreachable: true, error: "stopped answering during its update" });
      continue;
    }
    quietUntil = now() + peerQuietMS;
    if (status.id !== id) continue;
    if (swapDeadline !== 0 && now() > swapDeadline)
      return result({ error: "the restart never landed, see that host's phosphorus log" });
    if (status.state === "running" && stage === "asked") at("installing");
    const v = verdict(status);
    if (!settled(v)) continue;
    if (!v.ok || v.current) {
      if (v.current) v.to = fromVersion;
      return v;
    }
    const after = await seams.peerSelf(addr);
    if (fromBoot === "" || (after.bootID !== "" && after.bootID !== fromBoot)) {
      if (after.version !== "") v.to = after.version;
      return v;
    }
    at("restarting");
    if (swapDeadline === 0) swapDeadline = now() + swapTimeoutMS;
  }
  return result({ unreachable: true, error: "gave up waiting for the update to finish" });
}
