// what this host's WireGuard device should hold, worked out from the store on
// disk: its address, the hub or the hub's peers, and direct paths to other hosts
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MESH_PREFIX } from "@phosphorus/tun";
import type { PeerConfig } from "@phosphorus/wg";

// the relay over wss, an endpoint like any other to the device
export const RelayEndpoint = "relay";

export type HostRec = {
  ip: string;
  key: string;
  os?: string;
  removed?: boolean;
  // ip:port on a public address, and on the networks it sits on
  endpoint?: string;
  lan?: string[];
};
export type DeviceRec = { ip: string; key: string; guest?: boolean };

// what a join answered, kept until the store has synced
export type Joined = {
  name: string;
  ip: string;
  hub: { name: string; ip: string; key: string; endpoint: string };
  domain: string;
  token?: string;
};

export type View = {
  self: string;
  hosts: Map<string, HostRec>;
  devices: Map<string, DeviceRec>;
  control: string;
  domain: string;
  // each host's address as the hub last saw it
  seen: Record<string, string>;
  joined?: Joined;
};

export type Plan = {
  ip: string;
  hub: boolean;
  // the hub's own mesh address, where the mesh's DNS answers
  hubIP: string;
  // the hub's key, blank while unknown
  hubKey: string;
  peers: PeerConfig[];
  // key to the host or device name, for status
  names: Map<string, string>;
};

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : []);

// a stored file's data, undefined for a tombstone or a file not there
export function readRec(sys: string, rel: string): Record<string, unknown> | undefined {
  try {
    const f = JSON.parse(readFileSync(join(sys, rel), "utf8"));
    if (f?.gone) return;
    const d = f?.data;
    return d && typeof d === "object" ? d : undefined;
  } catch {
    return;
  }
}

function readDir(sys: string, dir: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  let names: string[] = [];
  try {
    names = readdirSync(join(sys, dir));
  } catch {}
  for (const n of names.sort()) {
    if (!n.endsWith(".json")) continue;
    const r = readRec(sys, `${dir}/${n}`);
    if (r) out.set(n.slice(0, -5), r);
  }
  return out;
}

// the store's mesh records as this host has them on disk
export function readView(sys: string, self: string, joined?: Joined): View {
  const hosts = new Map<string, HostRec>();
  for (const [h, r] of readDir(sys, "etc/mesh/hosts"))
    hosts.set(h, {
      ip: str(r.ip),
      key: str(r.key),
      os: str(r.os),
      ...(r.removed === true ? { removed: true } : {}),
      ...(str(r.endpoint) ? { endpoint: str(r.endpoint) } : {}),
      lan: strs(r.lan),
    });
  const devices = new Map<string, DeviceRec>();
  for (const [d, r] of readDir(sys, "etc/mesh/devices"))
    devices.set(d, { ip: str(r.ip), key: str(r.key), guest: r.guest === true });
  const seen: Record<string, string> = {};
  for (const [h, v] of Object.entries(readRec(sys, "etc/mesh/seen.json") ?? {})) if (str(v)) seen[h] = str(v);
  return {
    self,
    hosts,
    devices,
    control: str(readRec(sys, "etc/mesh/control.json")?.host),
    domain: str(readRec(sys, "etc/mesh/domain.json")?.name),
    seen,
    joined,
  };
}

const one = (ip: string) => `${ip}/32`;

// the device's peers from a view: every host and device on the hub, the hub and
// direct paths elsewhere
export function plan(v: View): Plan {
  const me = v.hosts.get(v.self);
  const ip = (me && !me.removed && me.ip) || v.joined?.ip || "";
  const hubName = v.control || v.joined?.hub.name || "";
  const hub = !!v.control && v.control === v.self;
  const names = new Map<string, string>();
  const peers: PeerConfig[] = [];
  const live = [...v.hosts].filter(([h, r]) => h !== v.self && !r.removed && r.key && r.ip);
  if (hub) {
    for (const [h, r] of live) {
      peers.push({ key: r.key, allowed: [one(r.ip)] });
      names.set(r.key, h);
    }
    for (const [d, r] of v.devices)
      if (r.key && r.ip && !names.has(r.key)) {
        peers.push({ key: r.key, allowed: [one(r.ip)] });
        names.set(r.key, d);
      }
    return { ip, hub, hubIP: ip, hubKey: me?.key ?? "", peers, names };
  }
  const hubRec = hubName ? v.hosts.get(hubName) : undefined;
  const hubKey = hubRec?.key || v.joined?.hub.key || "";
  const hubIP = hubRec?.ip || v.joined?.hub.ip || "";
  const hubAt = hubRec?.endpoint || v.joined?.hub.endpoint || "";
  if (hubKey) {
    const endpoints = [hubAt, v.domain ? RelayEndpoint : ""].filter(Boolean);
    peers.push({ key: hubKey, allowed: [MESH_PREFIX], endpoints, keepalive: 25 });
    names.set(hubKey, hubName || "hub");
  }
  for (const [h, r] of live) {
    if (h === hubName || r.key === hubKey) continue;
    const endpoints = [...new Set([...(r.lan ?? []), r.endpoint ?? "", v.seen[h] ?? ""].filter(Boolean))];
    if (!endpoints.length) continue;
    peers.push({ key: r.key, allowed: [one(r.ip)], endpoints, direct: true });
    names.set(r.key, h);
  }
  return { ip, hub, hubIP, hubKey, peers, names };
}
