// who is on the mesh: the store's host records, the transport's peers not yet
// recorded beside them, and the trust map behind the tailnet gate
import { noteMagicDNS, now, SelfHost } from "@phosphorus/util";
import { control, magicDomain } from "./control.ts";
import { allHosts, devices } from "./registry.ts";
import { type TransportPeer, transportDNS, transportIP, transportPeers } from "./transport.ts";

// registered: the host's own record, else the transport's word alone
export type Peer = { host: string; ip: string; os: string; registered: boolean };

let lastPeers: Peer[] = [];
let hasPeers = false;
let lastTransport: TransportPeer[] = [];
// mesh address -> trusted, guests and removed hosts false
let trustIPs = new Map<string, boolean>();
let trustAt = 0;

// this host's mesh IPv4, blank until known
export const selfIPNow = () => transportIP();
// the peers as last listed
export const lastKnown = () => lastPeers;
export const discovered = () => hasPeers;

export const DiscoverIdleMS = 5000;

// the MagicDNS suffix: the control server's domain, else the transport's own
function noteDomain() {
  const c = control();
  noteMagicDNS(c ? `${SelfHost || "self"}.${magicDomain(c.url)}` : transportDNS());
}

function listPeers(): Peer[] {
  const recs = allHosts();
  const named = new Set([...recs.map((h) => h.host), ...devices().map((d) => d.name)]);
  const out: Peer[] = recs
    .filter((h) => !h.removed && h.host !== SelfHost && h.ip)
    .map((h) => ({ host: h.host, ip: h.ip, os: h.os, registered: true }));
  // a host the store doesn't record yet: one still on an older phosphorus
  for (const p of lastTransport)
    if (!named.has(p.host) && p.host !== SelfHost && !p.guest)
      out.push({ host: p.host, ip: p.ip, os: "", registered: false });
  return out.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

function buildTrust() {
  const t = new Map<string, boolean>();
  for (const p of lastTransport) t.set(p.ip, !p.guest);
  for (const d of devices()) t.set(d.ip, !d.guest);
  for (const h of allHosts()) if (h.ip) t.set(h.ip, !h.removed);
  const self = transportIP();
  if (self) t.set(self, true);
  trustIPs = t;
}

const key = (ps: Peer[]) => ps.map((p) => `${p.host}=${p.ip}`).join(",");

// one look at the mesh: the peers, and whether anything about them changed
export async function refreshPeers(): Promise<{ peers: Peer[]; changed: boolean }> {
  lastTransport = (await transportPeers()) ?? lastTransport;
  noteDomain();
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
