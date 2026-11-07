// the mesh's control: the host its hub runs on, reached at the mesh's domain;
// join keys, addresses and the devices on it, every one a store record
import { createHash, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join as pathJoin } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { domain } from "@phosphorus/services";
import * as store from "@phosphorus/store";
import { env, errText, marshal, Notes, now, obj, peerCall, RunDir, SelfHost, tailnetIP } from "@phosphorus/util";
import { validHost } from "./names.ts";
import { allHosts, type DeviceRec, deviceRel, devices, hostRel, removeHost, WGPort } from "./registry.ts";

const notes = new Notes("control");

export const controlRel = "etc/mesh/control.json";
export const joinsDir = "etc/mesh/joins";
export const seenRel = "etc/mesh/seen.json";
export const MeshPrefix = "100.64.0.0/10";

// the mesh's choice of hub; its url the mesh's domain, blank before there is one
export type Control = { host: string; url: string };

export const control = (): Control | undefined => {
  const c = obj(store.read(controlRel));
  if (!c || typeof c.host !== "string" || !c.host) return undefined;
  const d = domain()?.name ?? "";
  return { host: c.host, url: d ? `https://${d}` : "" };
};

// the mesh's DNS zone: mesh.<BASE_DOMAIN>
export const meshZone = (base = env("BASE_DOMAIN").toLowerCase()) => (base ? `mesh.${base}` : "mesh.internal");

// --- addresses -----------------------------------------------------------------------

const ipNum = (ip: string) => ip.split(".").reduce((n, x) => n * 256 + Number(x), 0);
const ipText = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
const first = ipNum("100.64.0.1");
const last = ipNum("100.127.255.254");

// the lowest address in 100.64.0.0/10 no host or device holds, removed hosts' too
export function freeIP(taken = [...allHosts().map((h) => h.ip), ...devices().map((d) => d.ip)]): string {
  const used = new Set(taken.filter(Boolean).map(ipNum));
  for (let n = first; n <= last; n++) if ((n & 255) !== 0 && (n & 255) !== 255 && !used.has(n)) return ipText(n);
  throw new Error("the mesh has no free address left");
}

// --- the hub --------------------------------------------------------------------------

export type Hub = { host: string; ip: string; key: string; endpoint: string };

// the control host's record: its address, key and public endpoint
export function hub(c = control()): Hub | undefined {
  if (!c) return;
  const h = allHosts().find((x) => x.host === c.host && !x.removed);
  if (!h?.key) return;
  return { host: c.host, ip: h.ip, key: h.key, endpoint: h.endpoint ?? "" };
}

// --- join keys ------------------------------------------------------------------------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

// a new host's join key, its own each press, good for 90 days and many hosts
export function joinKey(c: Control) {
  if (!c.url) throw new Error("the mesh needs its domain before a host can join it");
  const id = randomBytes(4).toString("hex");
  const secret = b64url(randomBytes(24));
  const expires = now() + 90 * 24 * 3600_000;
  store.write(`${joinsDir}/${id}.json`, { hash: sha(secret), expires, reusable: true, made: now() }, true);
  return { key: envfile.formatMeshKey({ url: c.url, token: `${id}.${secret}` }), expires };
}

// the token's record when it holds, undefined when it doesn't
function checkToken(token: string) {
  const m = /^([a-f0-9]{8})\.([A-Za-z0-9_-]{20,})$/.exec(token);
  if (!m) return;
  const rel = `${joinsDir}/${m[1]}.json`;
  const r = obj(store.read(rel));
  if (!r || typeof r.hash !== "string" || typeof r.expires !== "number" || r.expires < now()) return;
  const want = Buffer.from(r.hash, "hex");
  const got = Buffer.from(sha(m[2]!), "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return;
  return { rel, reusable: r.reusable === true };
}

const keyRe = /^[A-Za-z0-9+/]{43}=$/;

// a host joining: its token checked, its record written with an address (its own
// again when it rejoins under its name), the hub given back
export function join(c: Control, body: Record<string, unknown>) {
  const tok = checkToken(String(body.token ?? ""));
  if (!tok) throw new Error("that join key isn't valid or has expired");
  const name = String(body.name ?? "").toLowerCase();
  const key = String(body.key ?? "");
  if (!validHost(name)) throw new Error("a host name is letters, digits and dashes, up to 63");
  if (!keyRe.test(key)) throw new Error("that isn't a WireGuard public key");
  if (devices().some((d) => d.name === name)) throw new Error(`${name} is a device's name on the mesh`);
  const h = hub(c);
  if (!h) throw new Error("the mesh's hub isn't up yet");
  if (name === c.host) throw new Error(`${name} runs the mesh's hub`);
  const had = allHosts().find((x) => x.host === name);
  const ip = had?.ip || freeIP();
  store.write(hostRel(name), { ip, os: String(body.os ?? ""), key }, true);
  if (!tok.reusable) store.remove(tok.rel);
  notes.log(`${name} joined at ${ip}`);
  return { name, ip, hub: { name: h.host, ip: h.ip, key: h.key, endpoint: h.endpoint }, domain: domain()?.name ?? "" };
}

// --- devices: phones and laptops on the WireGuard app ----------------------------------

const guestTTLMS = 3 * 24 * 3600_000;

// a device's WireGuard config, the private key in it shown once and kept nowhere
export function deviceConfig(priv: string, ip: string, h: Hub, zone: string) {
  return [
    "[Interface]",
    `PrivateKey = ${priv}`,
    `Address = ${ip}/32`,
    `DNS = ${h.ip}, ${zone}`,
    "",
    "[Peer]",
    `PublicKey = ${h.key}`,
    `AllowedIPs = ${MeshPrefix}`,
    `Endpoint = ${h.endpoint || `${domain()?.name ?? ""}:${WGPort}`}`,
    "PersistentKeepalive = 25",
    "",
  ].join("\n");
}

// a device added, or one already there given a new key at its address; guests
// gone after three days
export function addDevice(c: Control, name: string, guest: boolean) {
  const n = name.trim().toLowerCase();
  if (!validHost(n)) throw new Error("a name is letters, digits and dashes, up to 63");
  if (allHosts().some((x) => x.host === n)) throw new Error(`${n} is a phosphorus host`);
  const h = hub(c);
  if (!h) throw new Error("the mesh's hub isn't up yet");
  const had = devices().find((d) => d.name === n);
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  const b64 = (s: unknown) => Buffer.from(String(s), "base64url").toString("base64");
  const ip = had?.ip || freeIP();
  const rec: DeviceRec = { ip, key: b64(jwk.x), guest };
  if (guest) rec.expires = now() + guestTTLMS;
  store.write(deviceRel(n), rec, true);
  notes.log(`${had ? "new key for" : "added"} ${guest ? "guest " : ""}${n} at ${ip}`);
  return { name: n, ip, expires: rec.expires ?? 0, config: deviceConfig(b64(jwk.d), ip, h, meshZone()) };
}

// a device's name changed
export function renameDevice(name: string, to: string) {
  const n = to.trim().toLowerCase();
  if (!validHost(n)) throw new Error("a name is letters, digits and dashes, up to 63");
  const d = devices().find((x) => x.name === name);
  if (!d) throw new Error("no such device");
  if (n === name) return { name: n };
  if (allHosts().some((x) => x.host === n) || devices().some((x) => x.name === n)) throw new Error(`${n} is taken`);
  const { name: _, ...rec } = d;
  store.write(deviceRel(n), rec);
  store.remove(deviceRel(name));
  return { name: n };
}

// a device or host off the mesh until it joins again; never the hub itself
export function removeDevice(c: Control, name: string) {
  if (name === c.host) throw new Error(`${name} runs the mesh's hub`);
  if (devices().some((d) => d.name === name)) store.remove(deviceRel(name));
  else if (!removeHost(name)) throw new Error("no such device");
  notes.log(`removed ${name}`);
  return { name };
}

// --- ops on the control host ------------------------------------------------------------

// an op on the control host: run here when this is it, else asked of it over the mesh
export async function controlOp(op: string, body: Record<string, unknown> = {}): Promise<[number, any]> {
  const c = control();
  if (!c) return [409, { error: "the mesh has no hub yet" }];
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

// an op asked of this host as the control host, one at a time so addresses never clash
let queue: Promise<unknown> = Promise.resolve();
export function localControlOp(op: string, body: Record<string, unknown>): Promise<[number, any]> {
  const run = async (): Promise<[number, any]> => {
    const c = control();
    if (!c || c.host !== SelfHost) return [409, { error: `${SelfHost} isn't the mesh's hub` }];
    try {
      switch (op) {
        case "join-key":
          return [200, joinKey(c)];
        case "join":
          return [200, join(c, body)];
        case "device-add":
          return [200, addDevice(c, String(body.name ?? ""), body.guest === true)];
        case "rename":
          return [200, renameDevice(String(body.name ?? ""), String(body.to ?? ""))];
        case "remove":
          return [200, removeDevice(c, String(body.name ?? ""))];
      }
    } catch (e) {
      return [400, { error: errText(e) }];
    }
    return [404, { error: `no control op ${op}` }];
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

// --- the control host's part, every few seconds -------------------------------------------

let lastSweep = 0;

// guests past their three days and spent join keys gone
function sweep() {
  if (now() - lastSweep < 60_000) return;
  lastSweep = now();
  for (const d of devices())
    if (d.guest && d.expires && d.expires < now()) {
      store.remove(deviceRel(d.name));
      notes.log(`removed guest ${d.name}, past 3 days`);
    }
  for (const f of store.list(joinsDir)) {
    const rel = `${joinsDir}/${f}`;
    const r = obj(store.read(rel));
    if (!r || typeof r.expires !== "number" || r.expires < now()) store.remove(rel);
  }
}

let seenAt = 0;
let seenSig = "";

// each host's address as the hub's tunnel last saw it, for direct paths between hosts
function publishSeen() {
  if (now() - seenAt < 30_000) return;
  seenAt = now();
  let st: any;
  try {
    st = JSON.parse(readFileSync(pathJoin(RunDir, "net.json"), "utf8"));
  } catch {
    return;
  }
  const hosts = new Set(allHosts().map((h) => h.host));
  const seen: Record<string, string> = {};
  for (const p of Array.isArray(st?.peers) ? st.peers : []) {
    const ep = typeof p?.endpoint === "string" ? p.endpoint : "";
    if (p?.up && hosts.has(p.name) && /^\d+\.\d+\.\d+\.\d+:\d+$/.test(ep) && !ep.startsWith("127.")) seen[p.name] = ep;
  }
  const sig = marshal(seen);
  if (sig === seenSig) return;
  seenSig = sig;
  if (marshal(store.read(seenRel)) !== sig) store.write(seenRel, seen);
}

let busy = false;

// on the control host alone: guests swept, the hub's view of each host published
export async function controlTick() {
  if (busy || !SelfHost) return;
  busy = true;
  try {
    if (control()?.host === SelfHost) {
      sweep();
      publishSeen();
    }
    notes.clear("tick");
  } catch (e) {
    notes.note("tick", errText(e));
  } finally {
    busy = false;
  }
}
