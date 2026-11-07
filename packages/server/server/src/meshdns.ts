// the mesh's DNS on the hub's mesh address: every host and device by name under
// mesh.<domain>, every other name asked of this machine's own resolvers
import { getServers } from "node:dns";
import * as dns from "@phosphorus/dns";
import * as peers from "@phosphorus/peers";
import { env, errText, isLoopbackAddr, marshal, Notes, now } from "@phosphorus/util";
import { selfHost } from "./config.ts";

const notes = new Notes("meshdns");
const dnsPort = Number(env("MESH_DNS_PORT", "53"));

let served: dns.Served | undefined;
let servedOn = "";
let zone: dns.Zone | undefined;
let zoneSig = "";
let busy = false;

// the zone's names: hosts, then devices
export function meshNames(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of peers.registry.hosts()) if (h.ip) out[h.host] = [h.ip];
  for (const d of peers.registry.devices()) if (d.ip && !out[d.name]) out[d.name] = [d.ip];
  return out;
}

function refreshZone() {
  const spec: dns.ZoneSpec = { domain: peers.control.meshZone(), edges: [], hosts: meshNames(), serial: 0 };
  const sig = marshal(spec);
  if (sig === zoneSig) return;
  zoneSig = sig;
  spec.serial = Math.floor(now() / 1000);
  zone = dns.build(spec);
}

// the machine's resolvers, the mesh address itself left out
const upstream = (self: string) => () =>
  getServers()
    .map((s) => s.replace(/^\[|\](:\d+)?$/g, ""))
    .filter((s) => s && s !== self && !s.startsWith("100."))
    .concat(getServers().some((s) => isLoopbackAddr(s)) ? [] : ["1.1.1.1"]);

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const c = peers.control.control();
    const ip = c?.host === selfHost ? (peers.control.hub(c)?.ip ?? "") : "";
    if (ip) refreshZone();
    if (ip === servedOn && (served || !ip)) return;
    served?.close();
    served = undefined;
    servedOn = ip;
    if (!ip) return;
    try {
      served = await dns.serve({
        addrs: [ip],
        port: dnsPort,
        zone: () => zone,
        forward: dns.forwarder(upstream(ip)),
        log: (m) => notes.note("serve", m),
      });
      notes.note("on", `${peers.control.meshZone()} served on ${ip}`);
    } catch (e) {
      // the tunnel not up yet: tried again next tick
      servedOn = "";
      notes.note("on", `can't serve the mesh's dns on ${ip}:${dnsPort} yet: ${errText(e)}`);
    }
  } finally {
    busy = false;
  }
}

export function startMeshDNS() {
  void tick();
  setInterval(() => void tick(), 5000);
}

export const stopMeshDNS = () => served?.close();
