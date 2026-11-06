// the mesh's control server: the host running headscale, every host moved onto
// it together, and headscale's own calls, made on the control host by its CLI
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as envfile from "@phosphorus/envfile";
import * as store from "@phosphorus/store";
import {
  ControlDir,
  type ControlSpec,
  ControlSpecFile,
  env,
  errText,
  flushWrites,
  HeadscaleBin,
  mkdirParent,
  Notes,
  now,
  obj,
  peerCall,
  RepoDir,
  RunDir,
  run,
  SelfHost,
  tailnetIP,
} from "@phosphorus/util";

const notes = new Notes("control");

export const controlRel = "etc/mesh/control.json";
const hostRel = (h: string) => `etc/hosts/${h.toLowerCase()}/control.json`;
const configFile = join(ControlDir, "config.json");
const hostKeyFile = join(ControlDir, "host-key.json");
// run's join waits on this: the URL this host moves to on its next start
export const SwitchFile = join(RunDir, "control-switch");
const envPath = () => join(env("PHOSPHORUS_HOME", RepoDir), ".env");
export const HostedControl = "https://controlplane.tailscale.com";

export type Stage = "running" | "prepared" | "switching" | "done";
// the mesh's choice, one store record; absent: no control server of its own yet
export type Control = { host: string; url: string; relay: boolean; stage: Stage; at?: number; by?: string };
// each host's own record: the control server it's on, and its join key saved for the move
export type HostControl = { on: string; ready: boolean };

export const control = (): Control | undefined => {
  const c = obj(store.read(controlRel));
  if (!c || typeof c.host !== "string" || typeof c.url !== "string") return undefined;
  return c as Control;
};
export const hostControl = (h: string): HostControl | undefined => obj(store.read(hostRel(h))) as HostControl;

// the MagicDNS domain: mesh.<BASE_DOMAIN>, never the control URL's own
export function magicDomain(url: string, base = env("BASE_DOMAIN").toLowerCase()): string {
  const host = new URL(url).hostname;
  const d = base ? `mesh.${base}` : "mesh.internal";
  return host === d || host.endsWith("." + d) ? `tailnet.${d}` : d;
}

// --- headscale's calls, on the control host -------------------------------------------

async function hs(args: string[], timeoutMs = 15_000): Promise<any> {
  const r = await run([HeadscaleBin, "-c", configFile, "-o", "json", "--force", ...args], { timeoutMs });
  if (!r.ok) {
    const why = (r.stderr || r.stdout || r.error || `exit status ${r.code}`).trim().split("\n").pop();
    throw new Error(`headscale ${args.slice(0, 2).join(" ")}: ${why}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    return undefined;
  }
}

// a preauth key: tagged, so its nodes never expire; ephemeral ones gone when offline
async function preauthKey(o: { tags: string[]; reusable: boolean; ephemeral: boolean; expiration: string }) {
  const a = ["preauthkeys", "create", "--tags", o.tags.join(","), "-e", o.expiration];
  if (o.reusable) a.push("--reusable");
  if (o.ephemeral) a.push("--ephemeral");
  const k = obj(await hs(a)) ?? {};
  if (typeof k.key !== "string" || !k.key) throw new Error("headscale gave no key");
  return { key: k.key as string, expires: tsTime(k.expiration) };
}

// a protobuf timestamp as JSON, {seconds}, or a string, as ms
function tsTime(v: unknown): number {
  const o = obj(v);
  if (o && o.seconds !== undefined) return Number(o.seconds) * 1000;
  return typeof v === "string" ? Date.parse(v) || 0 : 0;
}

// the hosts' shared key, minted once and kept until a month before it lapses
export async function hostKey(c: Control): Promise<string> {
  try {
    const k = JSON.parse(readFileSync(hostKeyFile, "utf8"));
    if (k?.url === c.url && typeof k.key === "string" && k.expires - now() > 30 * 86400_000) return k.key;
  } catch {}
  const k = await preauthKey({ tags: ["tag:host"], reusable: true, ephemeral: false, expiration: "365d" });
  const key = envfile.formatMeshKey({ url: c.url, key: k.key });
  writeFileSync(hostKeyFile, JSON.stringify({ url: c.url, key, expires: k.expires }) + "\n", { mode: 0o600 });
  return key;
}

// a new host's join key, its own each press
export async function joinKey(c: Control) {
  const k = await preauthKey({ tags: ["tag:host"], reusable: true, ephemeral: false, expiration: "90d" });
  return { key: envfile.formatMeshKey({ url: c.url, key: k.key }), expires: k.expires };
}

// a guest device's: one use, ephemeral, off phosphorus's gates, three days
export async function guestKey(c: Control) {
  const k = await preauthKey({ tags: ["tag:guest"], reusable: false, ephemeral: true, expiration: "3d" });
  return { key: k.key, expires: k.expires, url: c.url };
}

export type Node = { id: string; name: string; tags: string[]; created: number; online: boolean; ips: string[] };

export async function nodes(): Promise<Node[]> {
  const got = await hs(["nodes", "list"]);
  return (Array.isArray(got) ? got : []).map((n: any) => ({
    id: String(n?.id ?? ""),
    name: String(n?.given_name || n?.name || ""),
    tags: Array.isArray(n?.tags) ? n.tags.map(String) : [],
    created: tsTime(n?.created_at),
    online: n?.online === true,
    ips: Array.isArray(n?.ip_addresses) ? n.ip_addresses.map(String) : [],
  }));
}

export const deleteNode = (id: string) => hs(["nodes", "delete", "--identifier", id]);

// a device signing in by the web page (a phone, a laptop) let on as the mesh's user
export async function approve(authID: string) {
  const id =
    authID
      .trim()
      .replace(/^.*--auth-id\s+/, "")
      .split(/\s+/)[0] ?? "";
  if (!/^[A-Za-z0-9_-]{6,}$/.test(id)) throw new Error("that isn't an auth id from the device's sign-in page");
  await ensureUser();
  const n = obj(await hs(["auth", "register", "--user", "mesh", "--auth-id", id])) ?? {};
  return { name: String(n.given_name || n.name || "") };
}

// an op on the control host: run here when this is it, else asked of it over the tailnet
export async function controlOp(op: string, body: Record<string, unknown> = {}): Promise<[number, any]> {
  const c = control();
  if (!c) return [409, { error: "the mesh has no control server of its own yet" }];
  if (c.host === SelfHost) return localControlOp(op, body);
  const ip = await tailnetIP(c.host);
  return peerCall(c.host, {
    host: ip || c.host,
    method: "POST",
    path: "/internal/control/" + op,
    body,
    timeoutMs: 30_000,
  });
}

// an op asked of this host as the control server
export async function localControlOp(op: string, body: Record<string, unknown>): Promise<[number, any]> {
  const c = control();
  if (!c || c.host !== SelfHost) return [409, { error: `${SelfHost} isn't the mesh's control server` }];
  try {
    switch (op) {
      case "host-key":
        return [200, { key: await hostKey(c) }];
      case "join-key":
        return [200, await joinKey(c)];
      case "guest-key":
        return [200, await guestKey(c)];
      case "approve":
        return [200, await approve(String(body.authId ?? ""))];
      case "nodes":
        return [200, { nodes: await nodes() }];
    }
  } catch (e) {
    return [502, { error: errText(e) }];
  }
  return [404, { error: `no control op ${op}` }];
}

const guestTTLMS = 3 * 24 * 3600 * 1000;
let lastSweep = 0;

// tag:guest devices past their three days removed, on the control host; offline
// ones headscale drops itself after half an hour
async function sweepGuests() {
  if (now() - lastSweep < 10 * 60_000) return;
  lastSweep = now();
  try {
    for (const n of await nodes()) {
      if (!n.tags.includes("tag:guest") || now() - n.created < guestTTLMS) continue;
      await deleteNode(n.id);
      notes.log(`removed guest ${n.name}, past 3 days`);
    }
    notes.clear("guests");
  } catch (e) {
    notes.note("guests", `couldn't sweep guest devices, still retrying: ${errText(e)}`);
  }
}

let userMade = false;
async function ensureUser() {
  if (userMade) return;
  const got = await hs(["users", "list"]);
  if (!(Array.isArray(got) && got.some((u: any) => u?.name === "mesh"))) await hs(["users", "create", "mesh"]);
  userMade = true;
}

// --- the move: each host's part, every few seconds ------------------------------------

let onURL = "";
let onAt = 0;
// the control server this host was last seen on, blank before the first look
export const onControl = () => onURL;
// on the mesh's own control server: guests and keys from headscale, not the hosted API
export const onOwnControl = () => {
  const c = control();
  return !!c && !!onURL && onURL === c.url;
};
// the control server this host's tailscale is on, read again every few minutes
async function currentControl(): Promise<string> {
  if (onURL && now() - onAt < 5 * 60_000) return onURL;
  const r = await run(["tailscale", "debug", "prefs"], { timeoutMs: 5000, env: process.env });
  try {
    const u = String(JSON.parse(r.stdout)?.ControlURL ?? "").replace(/\/+$/, "");
    onURL = u || HostedControl;
    onAt = now();
  } catch {}
  return onURL;
}

let lastSpec = "";
function writeSpec(spec: ControlSpec | undefined) {
  const text = spec ? JSON.stringify(spec) : "";
  if (text === lastSpec) return;
  try {
    if (spec) {
      mkdirParent(ControlSpecFile);
      writeFileSync(ControlSpecFile, text + "\n", { mode: 0o600 });
    } else rmSync(ControlSpecFile, { force: true });
    lastSpec = text;
  } catch (e) {
    notes.note("spec", `can't write ${ControlSpecFile}: ${errText(e)}`);
  }
}

// the join key for this mesh's control server in .env, from the control host when missing
async function saveJoinKey(c: Control): Promise<boolean> {
  if (envfile.parseMeshKey(process.env.MESH_KEY)?.url === c.url) return true;
  const [st, body] = await controlOp("host-key");
  if (st !== 200 || typeof body?.key !== "string") throw new Error(body?.error || `status ${st}`);
  const key: string = body.key;
  if (envfile.parseMeshKey(key)?.url !== c.url) throw new Error("the control host's key names another server");
  envfile.set(envPath(), { MESH_KEY: key });
  process.env.MESH_KEY = key;
  return true;
}

// the frontend gone, run's join moving tailscale to url on the restart
async function moveNow(url: string, why: string) {
  notes.log(`${why}: moving to ${url}, restarting`);
  writeFileSync(SwitchFile, url + "\n", { mode: 0o644 });
  await flushWrites();
  process.exit(1);
}

const startedAt = now();
let lastPeerAt = now();
let busy = false;

// up: the phosphorus peers whose links are up now
export async function controlTick(up: string[]) {
  if (busy || !SelfHost) return;
  busy = true;
  try {
    await step(up);
  } catch (e) {
    notes.note("tick", errText(e));
  } finally {
    busy = false;
  }
}

async function step(up: string[]) {
  const c = control();
  writeSpec(
    c && c.host === SelfHost && process.platform === "linux"
      ? { url: c.url, baseDomain: magicDomain(c.url), relay: c.relay === true }
      : undefined,
  );
  const on = await currentControl();
  if (up.length) lastPeerAt = now();
  if (c?.host === SelfHost && on === c.url) await sweepGuests();
  let ready = false;
  if (c && c.stage !== "running") {
    try {
      ready = await saveJoinKey(c);
      notes.clear("join-key");
    } catch (e) {
      notes.note("join-key", `couldn't get the join key from ${c.host}, still retrying: ${errText(e)}`);
    }
  }
  const mine: HostControl = { on, ready };
  const had = hostControl(SelfHost);
  if (!had || had.on !== mine.on || had.ready !== mine.ready) store.write(hostRel(SelfHost), mine);
  if (!c || !ready || on === c.url) {
    if (c?.stage === "switching" && c.by === SelfHost) finish(c, up);
    return;
  }
  if (c.stage === "switching" && now() >= (c.at ?? 0)) return moveNow(c.url, "the mesh is switching");
  // a host away for the switch: no peer left on the old network for two minutes,
  // ten while the switch is only prepared
  const quiet = now() - Math.max(lastPeerAt, startedAt);
  if (quiet > (c.stage === "prepared" ? 10 : 2) * 60_000) return moveNow(c.url, "no peers left here");
}

// the switch done once every host this one knows is on the new server
function finish(c: Control, up: string[]) {
  const hosts = [SelfHost, ...up];
  if (hosts.every((h) => hostControl(h)?.on === c.url)) {
    store.write(controlRel, { ...c, stage: "done" });
    notes.log(`every host is on ${c.url}`);
  }
}
