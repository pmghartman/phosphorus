// the mesh's control server: the host running headscale, and headscale's own
// calls, made on the control host by its CLI
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { domain } from "@phosphorus/services";
import * as store from "@phosphorus/store";
import {
  ControlDir,
  type ControlSpec,
  ControlSpecFile,
  env,
  errText,
  HeadscaleBin,
  mkdirParent,
  Notes,
  now,
  obj,
  peerCall,
  run,
  SelfHost,
  tailnetIP,
} from "@phosphorus/util";
import { removeHost, setDevices } from "./registry.ts";

const notes = new Notes("control");

export const controlRel = "etc/mesh/control.json";
const configFile = join(ControlDir, "config.json");

// the mesh's choice, one store record; absent: no control server of its own yet
export type Control = { host: string; url: string; relay: boolean };

export const control = (): Control | undefined => {
  const c = obj(store.read(controlRel));
  if (!c || typeof c.host !== "string" || typeof c.url !== "string") return undefined;
  return { host: c.host, url: c.url, relay: c.relay === true };
};

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

// a preauth key: tagged, or the mesh user's; ephemeral nodes gone when offline
async function preauthKey(o: { tags?: string[]; reusable: boolean; ephemeral: boolean; expiration: string }) {
  const a = ["preauthkeys", "create", "-e", o.expiration];
  if (o.tags) a.push("--tags", o.tags.join(","));
  else a.push("--user", String(await ensureUser()));
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

// a device of your own (a laptop, a desktop): one use, a day, the mesh user's as an
// approved device is, with the one command that joins it
export async function deviceKey(c: Control) {
  const k = await preauthKey({ reusable: false, ephemeral: false, expiration: "24h" });
  const command = `tailscale up --reset --force-reauth --login-server=${c.url} --auth-key=${k.key}`;
  return { command, expires: k.expires, url: c.url };
}

export type Node = {
  id: string;
  name: string;
  tags: string[];
  created: number;
  seen: number;
  online: boolean;
  ips: string[];
};

export async function nodes(): Promise<Node[]> {
  const got = await hs(["nodes", "list"]);
  return (Array.isArray(got) ? got : []).map((n: any) => ({
    id: String(n?.id ?? ""),
    name: String(n?.given_name || n?.name || ""),
    tags: Array.isArray(n?.tags) ? n.tags.map(String) : [],
    created: tsTime(n?.created_at),
    seen: tsTime(n?.last_seen),
    online: n?.online === true,
    ips: Array.isArray(n?.ip_addresses) ? n.ip_addresses.map(String) : [],
  }));
}

export const deleteNode = (id: string) => hs(["nodes", "delete", "--identifier", id]);

const labelRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// the node by id, refused when it's missing or a phosphorus host (named by phosphorus)
async function deviceNode(id: string, hostsToo: boolean): Promise<Node> {
  const n = (await nodes()).find((x) => x.id === id);
  if (!n) throw new Error("no such device");
  if (!hostsToo && n.tags.includes("tag:host")) throw new Error(`${n.name} is a phosphorus host, named by phosphorus`);
  return n;
}

// a device's MagicDNS name changed
export async function renameDevice(id: string, name: string) {
  const to = name.trim().toLowerCase();
  if (!labelRe.test(to)) throw new Error("a name is letters, digits and dashes, up to 63");
  await deviceNode(id, false);
  await hs(["nodes", "rename", "--identifier", id, to]);
  return { name: to };
}

// a device off the mesh until it joins again; never the control host itself
export async function removeDevice(c: Control, id: string) {
  const n = await deviceNode(id, true);
  if (n.name === c.host) throw new Error(`${n.name} runs the control server`);
  await deleteNode(id);
  if (n.tags.includes("tag:host")) removeHost(n.name);
  notes.log(`removed ${n.name}`);
  return { name: n.name };
}

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
  if (!c) return [409, { error: "the mesh has no control server" }];
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
      case "join-key":
        return [200, await joinKey(c)];
      case "guest-key":
        return [200, await guestKey(c)];
      case "device-key":
        return [200, await deviceKey(c)];
      case "approve":
        return [200, await approve(String(body.authId ?? ""))];
      case "nodes":
        return [200, { nodes: await nodes() }];
      case "rename":
        return [200, await renameDevice(String(body.id ?? ""), String(body.name ?? ""))];
      case "remove":
        return [200, await removeDevice(c, String(body.id ?? ""))];
    }
  } catch (e) {
    return [502, { error: errText(e) }];
  }
  return [404, { error: `no control op ${op}` }];
}

const mirrorEveryMS = 15_000;
let lastMirror = 0;

// headscale's devices other than hosts recorded in the store, for every host's trust
async function mirrorDevices() {
  if (now() - lastMirror < mirrorEveryMS) return;
  lastMirror = now();
  try {
    const list = (await nodes())
      .filter((n) => !n.tags.includes("tag:host"))
      .map((n) => ({ name: n.name, ip: n.ips.find((a) => a.includes(".")) ?? "", guest: n.tags.includes("tag:guest") }))
      .filter((d) => d.ip);
    setDevices(list);
    notes.clear("mirror");
  } catch (e) {
    notes.note("mirror", `couldn't record the mesh's devices, still retrying: ${errText(e)}`);
  }
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

let userID = "";
// the mesh user's id, made on first need
async function ensureUser(): Promise<string> {
  if (userID) return userID;
  const got = await hs(["users", "list"]);
  let u = Array.isArray(got) ? got.find((x: any) => x?.name === "mesh") : undefined;
  u ??= await hs(["users", "create", "mesh"]);
  const id = String(obj(u)?.id ?? "");
  if (!id) throw new Error("headscale gave no id for the mesh user");
  userID = id;
  return id;
}

// --- the control host's part, every few seconds ---------------------------------------

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

let busy = false;

// run's control child told what to serve, guests swept, on the control host alone
export async function controlTick() {
  if (busy || !SelfHost) return;
  busy = true;
  try {
    const c = control();
    const mine = c?.host === SelfHost && process.platform === "linux";
    // an edge host too: 443 is the splitter's, headscale behind it
    const behind = !!domain()?.edges.includes(SelfHost);
    writeSpec(mine ? { url: c.url, baseDomain: magicDomain(c.url), relay: c.relay, behind } : undefined);
    if (mine) {
      await sweepGuests();
      await mirrorDevices();
    }
  } catch (e) {
    notes.note("tick", errText(e));
  } finally {
    busy = false;
  }
}
