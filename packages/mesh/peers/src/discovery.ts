// who is on the tailnet: tailscale's own status, read now and then; the trust
// map behind the tailnet gate; which hosts tailscale calls offline, and since when
import { errText, flushWrites, Notes, now, obj, run, SelfHost } from "@phosphorus/util";

const notes = new Notes("mesh");

export type Peer = { host: string; ip: string; os: string; online: boolean };
type TSNode = {
  DNSName?: string;
  TailscaleIPs?: string[] | null;
  Online?: boolean;
  OS?: string;
  Tags?: string[] | null;
};

let selfIP = "";
let lastPeers: Peer[] = [];
let hasPeers = false;
let lastDiscover = 0;
const offlineSince = new Map<string, number>();
// tailnet address -> trusted, tag:guest devices false
let trustIPs = new Map<string, boolean>();
let trustAt = 0;

// this host's tailnet IPv4, blank until discovered
export const selfIPNow = () => selfIP;
// the peers as tailscale last listed them
export const lastKnown = () => lastPeers;
export const discovered = () => hasPeers;

// a tailnet DNS name as supervisor.sh derives SELF_HOST
export function hostOf(dns: string): string {
  const s = dns.replace(/\.$/, "").split(".")[0]!.toLowerCase();
  return s.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const v4 = (ips: string[]) => ips.find((a) => a.includes(".")) ?? "";

// tailscale status: every peer by its short name, this host's address and the trust map
export async function discoverPeers(): Promise<Peer[] | undefined> {
  // the live PATH, as Go's exec looked tailscale up; Bun's default is the one at startup
  const r = await run(["tailscale", "status", "--json"], { timeoutMs: 3000, env: process.env });
  let status: Record<string, any> | undefined;
  let err = r.error ?? (r.ok ? "" : r.stderr.trim() || `exit status ${r.code}`);
  if (!err) {
    try {
      status = obj(JSON.parse(r.stdout));
    } catch (e) {
      err = errText(e);
    }
  }
  if (!status) {
    notes.note("tailscale", `can't reach tailscaled to list peers: ${err || "not an object"}`);
    return;
  }
  notes.clear("tailscale");
  const self: TSNode = obj(status.Self) ?? {};
  const nodes: Record<string, TSNode | null> = obj(status.Peer) ?? {};
  const trust = new Map<string, boolean>();
  for (const a of self.TailscaleIPs ?? []) trust.set(a, true);
  for (const p of Object.values(nodes)) {
    const guest = (p?.Tags ?? []).includes("tag:guest");
    for (const a of p?.TailscaleIPs ?? []) trust.set(a, !guest);
  }
  selfIP = v4(self.TailscaleIPs ?? []);
  trustIPs = trust;
  if (SelfHost) {
    const renamed = hostOf(self.DNSName ?? "");
    if (renamed && renamed !== SelfHost) {
      notes.log(`renamed on the tailnet to ${renamed}, restarting to follow`);
      await flushWrites();
      process.exit(1);
    }
  }
  const peers: Peer[] = [];
  for (const k of Object.keys(nodes).sort()) {
    const p = nodes[k] ?? {};
    const h = hostOf(p.DNSName ?? "");
    if (!h || h === SelfHost) continue;
    peers.push({ host: h, ip: v4(p.TailscaleIPs ?? []) || h, os: p.OS ?? "", online: p.Online === true });
  }
  return peers;
}

// a tailnet address of this tailnet's own devices, tag:guest ones not;
// an unknown one looked up again, at most once a second
export async function trusted(ip: string): Promise<boolean> {
  const known = trustIPs.get(ip);
  if (known !== undefined) return known;
  if (now() - trustAt >= 1000) {
    trustAt = now();
    await discoverPeers();
  }
  return trustIPs.get(ip) ?? false;
}

export const DiscoverIdleMS = 5000;

// per host, only while tailscale itself still answers
export function offlineMS(): Record<string, number> {
  const out: Record<string, number> = {};
  if (now() - lastDiscover > 3 * DiscoverIdleMS) return out;
  for (const [h, t] of offlineSince) out[h] = now() - t;
  return out;
}

const key = (ps: Peer[]) => ps.map((p) => `${p.host}=${p.ip}:${p.online ? 1 : 0}`).join(",");

// one look at the tailnet: the peers, and whether anything about them changed;
// tailscaled unreachable leaves the last list standing
export async function refreshPeers(): Promise<{ peers: Peer[]; ok: boolean; changed: boolean }> {
  const found = await discoverPeers();
  if (!found) return { peers: lastPeers, ok: hasPeers, changed: false };
  const changed = !hasPeers || key(found) !== key(lastPeers);
  lastDiscover = now();
  const online = new Set(found.filter((p) => p.online).map((p) => p.host));
  for (const h of online) offlineSince.delete(h);
  for (const p of [...found, ...lastPeers])
    if (!online.has(p.host) && !offlineSince.has(p.host)) offlineSince.set(p.host, lastDiscover);
  for (const h of [...offlineSince.keys()]) if (!found.some((p) => p.host === h)) offlineSince.delete(h);
  lastPeers = found;
  hasPeers = true;
  return { peers: found, ok: true, changed };
}
