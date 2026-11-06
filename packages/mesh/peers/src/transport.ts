// the transport under the mesh, Tailscale for now and read here alone: this
// host's address on it, and its peers for what phosphorus doesn't know yet
import { networkInterfaces } from "node:os";
import { errText, isTailnetAddr, Notes, obj, run } from "@phosphorus/util";
import { hostOf } from "./names.ts";

const notes = new Notes("mesh");

// a peer as the transport lists it: its name, address and guest tag
export type TransportPeer = { host: string; ip: string; guest: boolean };

type TSNode = { DNSName?: string; TailscaleIPs?: string[] | null; Tags?: string[] | null };

const v4 = (ips: string[]) => ips.find((a) => a.includes(".")) ?? "";

let selfIP = "";
let selfDNS = "";

// this host's address on the transport, its interfaces asked while tailscale never answered
export function transportIP(): string {
  if (selfIP) return selfIP;
  for (const list of Object.values(networkInterfaces()))
    for (const i of list ?? []) if (i.family === "IPv4" && isTailnetAddr(i.address)) return i.address;
  return "";
}

// this host's DNS name on the transport, blank until read
export const transportDNS = () => selfDNS;

// tailscale's peer list, undefined when tailscaled doesn't answer
export async function transportPeers(): Promise<TransportPeer[] | undefined> {
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
    notes.note("tailscale", `can't reach tailscaled: ${err || "not an object"}`);
    return;
  }
  notes.clear("tailscale");
  const self: TSNode = obj(status.Self) ?? {};
  selfIP = v4(self.TailscaleIPs ?? []) || selfIP;
  selfDNS = String(self.DNSName ?? "");
  const out: TransportPeer[] = [];
  for (const p of Object.values((obj(status.Peer) ?? {}) as Record<string, TSNode | null>)) {
    const host = hostOf(p?.DNSName ?? "");
    const ip = v4(p?.TailscaleIPs ?? []);
    if (host && ip) out.push({ host, ip, guest: (p?.Tags ?? []).includes("tag:guest") });
  }
  return out.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}
