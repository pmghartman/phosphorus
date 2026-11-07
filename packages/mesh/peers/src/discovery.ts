// who is on the mesh: the store's host and device records, and the trust map
// behind the mesh gate
import { networkInterfaces } from "node:os";
import { isTailnetAddr, noteMagicDNS, now, SelfHost } from "@phosphorus/util";
import { meshZone } from "./control.ts";
import { allHosts, devices, joined } from "./registry.ts";

export type Peer = { host: string; ip: string; os: string };

let lastPeers: Peer[] = [];
let hasPeers = false;
// mesh address -> trusted, guests and removed hosts false
let trustIPs = new Map<string, boolean>();
let trustAt = 0;

// this host's mesh address: its own record's, its join's, else the tunnel's own
export function selfIPNow(): string {
  const own = allHosts().find((h) => h.host === SelfHost && !h.removed)?.ip;
  if (own) return own;
  const j = joined();
  if (j?.ip && j.name === SelfHost) return j.ip;
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === "IPv4" && isTailnetAddr(i.address)) return i.address;
  return "";
}

// the peers as last listed
export const lastKnown = () => lastPeers;
export const discovered = () => hasPeers;

export const DiscoverIdleMS = 5000;

// the store's hosts; the hub a join named until the store records it
function listPeers(): Peer[] {
  const recs = allHosts();
  const out = recs
    .filter((h) => !h.removed && h.host !== SelfHost && h.ip)
    .map((h) => ({ host: h.host, ip: h.ip, os: h.os }));
  const hub = joined()?.hub;
  if (hub?.name && hub.ip && hub.name !== SelfHost && !recs.some((h) => h.host === hub.name))
    out.push({ host: hub.name, ip: hub.ip, os: "" });
  return out.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

function buildTrust() {
  const t = new Map<string, boolean>();
  for (const d of devices()) t.set(d.ip, !d.guest);
  for (const h of allHosts()) if (h.ip) t.set(h.ip, !h.removed);
  const hub = joined()?.hub;
  if (hub?.ip && !t.has(hub.ip)) t.set(hub.ip, true);
  const self = selfIPNow();
  if (self) t.set(self, true);
  trustIPs = t;
}

const key = (ps: Peer[]) => ps.map((p) => `${p.host}=${p.ip}`).join(",");

// one look at the mesh: the peers, and whether anything about them changed
export async function refreshPeers(): Promise<{ peers: Peer[]; changed: boolean }> {
  noteMagicDNS(meshZone());
  buildTrust();
  const found = listPeers();
  const changed = !hasPeers || key(found) !== key(lastPeers);
  lastPeers = found;
  hasPeers = true;
  return { peers: found, changed };
}

// a mesh address of this mesh's own devices, guests' not; an unknown one
// looked up again, at most once a second
export async function trusted(ip: string): Promise<boolean> {
  const known = trustIPs.get(ip);
  if (known !== undefined) return known;
  if (now() - trustAt >= 1000) {
    trustAt = now();
    await refreshPeers();
  }
  return trustIPs.get(ip) ?? false;
}
