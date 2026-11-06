// who is on the mesh, as the store records it: each host's own record, the
// control host's of every other device, and this host's WireGuard key pair
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as store from "@phosphorus/store";
import { DataDir, errText, marshal, Notes, obj, SelfHost } from "@phosphorus/util";
import { validHost } from "./names.ts";

const notes = new Notes("mesh");

export const hostsDir = "etc/mesh/hosts";
export const devicesDir = "etc/mesh/devices";
export const hostRel = (h: string) => `${hostsDir}/${h}.json`;
export const deviceRel = (n: string) => `${devicesDir}/${n}.json`;

// a host as it records itself; removed: its key refused until it joins again
export type HostRec = { ip: string; os: string; key: string; removed?: boolean };
// a device the control host recorded: a phone, a laptop, a guest
export type DeviceRec = { ip: string; guest: boolean };

export type Host = HostRec & { host: string };
export type Device = DeviceRec & { name: string };

const nameOf = (f: string) => f.replace(/\.json$/, "");
const str = (v: unknown) => (typeof v === "string" ? v : "");

// every host's record, removed ones too
export function allHosts(): Host[] {
  const out: Host[] = [];
  for (const f of store.list(hostsDir)) {
    const host = nameOf(f);
    const r = obj(store.read(hostRel(host)));
    if (!r || !validHost(host)) continue;
    out.push({ host, ip: str(r.ip), os: str(r.os), key: str(r.key), ...(r.removed === true ? { removed: true } : {}) });
  }
  return out;
}

// the hosts on the mesh
export const hosts = () => allHosts().filter((h) => !h.removed);

export function devices(): Device[] {
  const out: Device[] = [];
  for (const f of store.list(devicesDir)) {
    const name = nameOf(f);
    const r = obj(store.read(deviceRel(name)));
    if (r && validHost(name)) out.push({ name, ip: str(r.ip), guest: r.guest === true });
  }
  return out;
}

// --- this host's key ---------------------------------------------------------------

export const keyFile = () => join(DataDir, "mesh", "key.json");

let pub = "";

// this host's WireGuard public key, the pair made on first need
export function publicKey(): string {
  if (pub) return pub;
  try {
    const k = obj(JSON.parse(readFileSync(keyFile(), "utf8")));
    if (k && typeof k.public === "string" && typeof k.private === "string") return (pub = k.public);
  } catch {}
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  const b64 = (s: unknown) => Buffer.from(String(s), "base64url").toString("base64");
  const pair = { private: b64(jwk.d), public: b64(jwk.x) };
  mkdirSync(dirname(keyFile()), { recursive: true, mode: 0o700 });
  writeFileSync(keyFile(), JSON.stringify(pair) + "\n", { mode: 0o600 });
  notes.log("made this host's mesh key");
  return (pub = pair.public);
}

// --- this host's record ----------------------------------------------------------------

// this host's record kept current; false while the mesh has removed its key
export function registerSelf(ip: string, os: string): boolean {
  if (!SelfHost || !ip) return true;
  let key: string;
  try {
    key = publicKey();
  } catch (e) {
    notes.note("key", `can't make this host's mesh key: ${errText(e)}`);
    return true;
  }
  notes.clear("key");
  const cur = obj(store.read(hostRel(SelfHost)));
  if (cur?.removed === true && cur.key === key) {
    notes.note("removed", `${SelfHost} was removed from the mesh; join it again with a new MESH_KEY`);
    return false;
  }
  notes.clear("removed");
  const want: HostRec = { ip, os, key };
  if (marshal(cur) !== marshal(want)) store.write(hostRel(SelfHost), want);
  return true;
}

// a host off the mesh: its key refused until it joins with a new one
export function removeHost(host: string): boolean {
  const cur = obj(store.read(hostRel(host)));
  if (!cur || cur.removed === true) return false;
  store.write(hostRel(host), { ip: str(cur.ip), os: str(cur.os), key: str(cur.key), removed: true });
  return true;
}

// the control host's devices written to match what it lists, the rest removed
export function setDevices(list: Device[]) {
  const want = new Map(list.filter((d) => validHost(d.name)).map((d) => [d.name, d]));
  for (const d of devices()) if (!want.has(d.name)) store.remove(deviceRel(d.name));
  const have = new Map(devices().map((d) => [d.name, d]));
  for (const [name, d] of want) {
    const rec: DeviceRec = { ip: d.ip, guest: d.guest };
    const h = have.get(name);
    if (!h || h.ip !== rec.ip || h.guest !== rec.guest) store.write(deviceRel(name), rec);
  }
}
