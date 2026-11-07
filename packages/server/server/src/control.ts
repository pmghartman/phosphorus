// settings › network: the mesh's domain and its edge hosts, public ports, the
// hub that carries it, join keys and the devices on it, asked of the control host
import * as dns from "@phosphorus/dns";
import * as peers from "@phosphorus/peers";
import { porkbun } from "@phosphorus/registrar";
import {
  addDnsRecord,
  type DNSRecordType,
  dnsRecordError,
  dnsRecords,
  domainRe,
  domainRel,
  portError,
  removeDnsRecord,
  removePort,
  setPort,
} from "@phosphorus/services";
import * as store from "@phosphorus/store";
import { errText, now } from "@phosphorus/util";
import { selfHost } from "./config.ts";
import { builtInRecords, edgeStatus, publicHosts } from "./edge.ts";
import type { Res } from "./http.ts";
import { num, str } from "./js.ts";
import { hostsInfo } from "./server.ts";

const ctl = peers.control;

let healthAt = 0;
let healthOf = "";
let healthLast: { ok: boolean; why?: string } = { ok: false };

// <url>/healthz from here, over the internet as a joining host would reach it
async function health(url: string): Promise<{ ok: boolean; why?: string }> {
  if (healthOf === url && now() - healthAt < 10_000) return healthLast;
  let h: { ok: boolean; why?: string };
  try {
    const r = await fetch(url + "/healthz", { signal: AbortSignal.timeout(5000) });
    h = r.ok ? { ok: true } : { ok: false, why: `${url} said ${r.status}` };
  } catch (e) {
    h = { ok: false, why: `${url} not answering: ${errText(e)}` };
  }
  healthAt = now();
  healthOf = url;
  healthLast = h;
  return h;
}

// a host's tunnel as its info.json has it
export type NetInfo = {
  ip: string;
  up: boolean;
  hub: boolean;
  relay: boolean;
  waiting: string;
  // up paths: another host direct, or on the hub every peer it carries
  direct: string[];
  spokes: string[];
};

const netOf = (h: string): NetInfo | undefined => {
  const n = hostsInfo()[h]?.net;
  return n && typeof n === "object" ? (n as NetInfo) : undefined;
};

export type MeshDevice = {
  name: string;
  kind: "host" | "device" | "guest";
  ip: string;
  online: boolean;
  // a device's config made, hosts always
  ready: boolean;
  expires?: number;
  // how it reaches the hub: it is the hub, over udp, the relay, or not now
  via: "hub" | "udp" | "relay" | "";
  // hosts it has a direct session with, past the hub
  direct: string[];
};

// every host and device on the mesh, each with whether it's reachable now
export function meshDevices(): MeshDevice[] {
  const c = ctl.control();
  const up = new Set([selfHost, ...peers.upPeers()]);
  const spokes = new Set(c ? (netOf(c.host)?.spokes ?? []) : []);
  const out: MeshDevice[] = [];
  for (const h of peers.registry.hosts()) {
    const n = netOf(h.host);
    const via = !n?.up ? "" : n.hub ? "hub" : n.relay ? "relay" : "udp";
    out.push({
      name: h.host,
      kind: "host",
      ip: h.ip,
      online: up.has(h.host),
      ready: true,
      via,
      direct: n?.direct ?? [],
    });
  }
  for (const d of peers.registry.devices())
    out.push({
      name: d.name,
      kind: d.guest ? "guest" : "device",
      ip: d.ip,
      online: spokes.has(d.name),
      ready: !!d.key,
      via: spokes.has(d.name) ? "udp" : "",
      direct: [],
      ...(d.expires ? { expires: d.expires } : {}),
    });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function controlStatus(): Promise<Res> {
  const c = ctl.control();
  const edge = edgeStatus();
  const hub = c ? (ctl.hub(c) ?? null) : null;
  const h = c?.url ? await health(c.url) : null;
  return [
    200,
    {
      control: c ?? null,
      hub,
      health: h,
      hosts: publicHosts(),
      edge,
      devices: meshDevices(),
      zone: ctl.meshZone(edge.domain),
      records: dnsRecords(),
      builtIn: builtInRecords(),
    },
  ];
}

const qtypes: Record<string, number> = {
  A: dns.Type.A,
  AAAA: dns.Type.AAAA,
  CNAME: dns.Type.CNAME,
  MX: dns.Type.MX,
  TXT: dns.Type.TXT,
  NS: dns.Type.NS,
  SRV: dns.Type.SRV,
};

const rdataText = (d: dns.RR["data"]): string => {
  if ("ip" in d) return d.ip;
  if (d.type === dns.Type.MX) return `${d.priority} ${d.target}`;
  if (d.type === dns.Type.SRV) return `${d.target}:${d.port}`;
  if ("target" in d) return d.target;
  if ("texts" in d) return d.texts.join("");
  if (d.type === dns.Type.CAA) return `${d.tag} ${d.value}`;
  return "";
};

// a name asked as the world asks it: of an edge host's dns for the domain, of the
// hub for the mesh's zone
async function lookup(p: Record<string, unknown>): Promise<Res> {
  const name = str(p.name).trim().toLowerCase().replace(/\.$/, "");
  const type = qtypes[str(p.type).toUpperCase() || "A"];
  if (!name || !type) return [400, { error: "a name, and a type of A, AAAA, CNAME, MX, TXT, NS or SRV" }];
  const e = edgeStatus();
  const zone = ctl.meshZone(e.domain);
  const meshName = name === zone || name.endsWith(`.${zone}`);
  const server = meshName ? (ctl.hub()?.ip ?? "") : (e.edges.find((x) => x.up && x.ip)?.ip ?? "");
  if (!server) return [409, { error: meshName ? "no hub to ask yet" : "no edge host up to ask" }];
  try {
    const r = await dns.query({ server, name, type, timeoutMs: 3000 });
    const rcode = Object.entries(dns.Rcode).find(([, v]) => v === r.rcode)?.[0] ?? String(r.rcode);
    return [
      200,
      {
        server,
        rcode: rcode.toLowerCase(),
        answers: r.answer.map((a) => ({ name: a.name, ttl: a.ttl, value: rdataText(a.data) })),
      },
    ];
  } catch (err) {
    return [502, { error: `${server} didn't answer: ${errText(err)}` }];
  }
}

// the mesh's domain set, or cleared with a blank name; its edges the Linux hosts
// with a public address that serve it
function setDomain(p: Record<string, unknown>): Res {
  const name = str(p.name).trim().toLowerCase().replace(/\.$/, "");
  if (!name) {
    store.remove(domainRel);
    return [200, { ok: true }];
  }
  if (!domainRe.test(name)) return [400, { error: "the domain must be a name like example.com" }];
  const pub = publicHosts();
  const edges = [...new Set((Array.isArray(p.edges) ? p.edges : []).map((e) => str(e).toLowerCase()))].sort();
  const bad = edges.find((e) => !pub.some((h) => h.host === e));
  if (bad) return [400, { error: `${bad} isn't a Linux host with a public address` }];
  if (!edges.length) return [400, { error: "pick at least one edge host, a Linux host with a public address" }];
  store.write(domainRel, { name, edges }, true);
  return [200, { ok: true }];
}

// the domain pointed at the edges at its registrar: porkbun's API keys used for the
// glue records and the nameservers, then forgotten
async function delegate(p: Record<string, unknown>): Promise<Res> {
  const e = edgeStatus();
  if (!e.domain) return [409, { error: "set the domain first" }];
  if (!e.nameservers.length) return [409, { error: "no edge host with a public address yet" }];
  if (str(p.registrar) !== "porkbun") return [400, { error: "the registrar must be porkbun" }];
  const keys = { apikey: str(p.apikey).trim(), secretapikey: str(p.secretapikey).trim() };
  if (!keys.apikey || !keys.secretapikey)
    return [400, { error: "porkbun's API key and secret API key are both needed" }];
  try {
    return [200, { steps: await porkbun.delegate(keys, e.domain, e.nameservers) }];
  } catch (err) {
    return [502, { error: errText(err) }];
  }
}

// an admin's step: the domain and its edges, its delegation, a public port, the
// hub's host, join keys, and the devices on it
export async function controlAction(p: Record<string, unknown>): Promise<Res> {
  const c = ctl.control();
  switch (str(p.action)) {
    case "domain":
      return setDomain(p);
    case "delegate":
      return delegate(p);
    case "port-set": {
      const row = {
        host: str(p.host).toLowerCase(),
        name: str(p.name).trim().toLowerCase(),
        port: num(p.port),
        proto: str(p.proto) as "tcp" | "udp",
        pub: num(p.pub),
        srv: str(p.srv).trim().toLowerCase(),
      };
      const why = portError(row);
      if (why) return [400, { error: why }];
      setPort(row);
      return [200, { ok: true }];
    }
    case "port-remove":
      removePort(str(p.host).toLowerCase(), str(p.name).toLowerCase());
      return [200, { ok: true }];
    case "set": {
      const host = str(p.host).toLowerCase();
      if (!publicHosts().some((h) => h.host === host))
        return [400, { error: `${host || "that"} isn't a Linux host with a public address` }];
      if (c?.host === host) return [200, { ok: true }];
      store.write(ctl.controlRel, { host }, true);
      return [200, { ok: true }];
    }
    case "join-key":
      return ctl.controlOp("join-key");
    case "device-add":
      return ctl.controlOp("device-add", { name: str(p.name), guest: p.guest === true });
    case "rename":
      return ctl.controlOp("rename", { name: str(p.name), to: str(p.to) });
    case "remove":
      return ctl.controlOp("remove", { name: str(p.name) });
    case "record-add": {
      const rec = {
        name: str(p.name).trim().toLowerCase().replace(/\.$/, "").replace(/^@$/, ""),
        type: str(p.type).toUpperCase() as DNSRecordType,
        value: str(p.value).trim(),
        ...(p.priority !== undefined && p.priority !== "" ? { priority: num(p.priority) } : {}),
      };
      const d = edgeStatus().domain;
      if (d && (rec.name === d || rec.name.endsWith(`.${d}`)))
        rec.name = rec.name.slice(0, -(d.length + 1)).replace(/\.$/, "");
      const why = dnsRecordError(rec);
      if (why) return [400, { error: why }];
      return [200, addDnsRecord(rec)];
    }
    case "record-remove":
      removeDnsRecord(str(p.id));
      return [200, { ok: true }];
    case "lookup":
      return lookup(p);
  }
  return [
    400,
    {
      error:
        "action must be domain, delegate, port-set, port-remove, set, join-key, device-add, rename, remove, record-add, record-remove or lookup",
    },
  ];
}
