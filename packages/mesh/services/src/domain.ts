// the mesh's domain in the store: its name and the edge hosts that serve it on
// the internet, the certificate over it, the ACME account and challenge, and
// the public ports each host asks the edge to open
import * as store from "@phosphorus/store";
import { FrontendPort, isIPv4, now, obj, SelfHost } from "@phosphorus/util";

export const domainRel = "etc/mesh/domain.json";
export const tlsRel = "etc/mesh/tls.json";
export const acmeRel = "etc/mesh/acme.json";
export const challengeRel = "etc/mesh/acme-challenge.json";
export const acmeStateRel = "etc/mesh/acme-state.json";
const portsDir = "etc/ports";

export const domainRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// the mesh's choice: the domain and the Linux hosts with a public address serving it
export type Domain = { name: string; edges: string[] };

export function domain(): Domain | undefined {
  const d = obj(store.read(domainRel));
  if (!d || typeof d.name !== "string" || !domainRe.test(d.name) || !Array.isArray(d.edges)) return;
  return { name: d.name, edges: d.edges.filter((e: unknown): e is string => typeof e === "string").sort() };
}

// the certificate over the domain and its wildcard, PEM, as the CA issued it
export type TLSRec = { cert: string; key: string; names: string[]; notBefore: number; notAfter: number; at: number };

export function tls(): TLSRec | undefined {
  const t = obj(store.read(tlsRel));
  if (!t || typeof t.cert !== "string" || typeof t.key !== "string" || typeof t.notAfter !== "number") return;
  return {
    cert: t.cert,
    key: t.key,
    names: Array.isArray(t.names) ? t.names.map(String) : [],
    notBefore: typeof t.notBefore === "number" ? t.notBefore : 0,
    notAfter: t.notAfter,
    at: typeof t.at === "number" ? t.at : 0,
  };
}

// the certificate the domain needs now: over it and its wildcard, a month left
export const tlsCovers = (t: TLSRec | undefined, name: string) =>
  !!t && t.names.includes(name) && t.names.includes(`*.${name}`) && t.notAfter - now() > 30 * 24 * 3600_000;

// a service gets <name>.<domain> once the domain has a certificate that holds
export const publicUp = () => {
  const d = domain();
  return !!d && tlsCovers(tls(), d.name);
};

// the ordering edge's word: the registrar's delegation as it last saw it, an order
// running, the last failure
export type AcmeState = {
  by: string;
  delegation: { ok: boolean; why: string };
  ordering: boolean;
  error: string;
  at: number;
};

export function acmeState(): AcmeState | undefined {
  const s = obj(store.read(acmeStateRel));
  if (!s || typeof s.by !== "string") return;
  const d = obj(s.delegation);
  return {
    by: s.by,
    delegation: { ok: d?.ok === true, why: typeof d?.why === "string" ? d.why : "" },
    ordering: s.ordering === true,
    error: typeof s.error === "string" ? s.error : "",
    at: typeof s.at === "number" ? s.at : 0,
  };
}

// the texts at each _acme-challenge name while an order runs
export const challenge = (): Record<string, string[]> => {
  const c = obj(store.read(challengeRel)) ?? {};
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(c)) if (Array.isArray(v)) out[k] = v.map(String);
  return out;
};

// --- public ports ------------------------------------------------------------

export type PortRec = { port: number; proto: "tcp" | "udp"; pub: number; srv?: string };
export type PortRow = PortRec & { host: string; name: string };

const portRel = (host: string, name: string) => `${portsDir}/${host}/${name}.json`;
const labelRe = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const srvRe = /^[a-z0-9]([a-z0-9-]{0,14})$/;
// the edge's own ports, never handed to a service
export const edgePorts = new Set([22, 53, 80, 443, 3478, 8090, 8791, 41641]);
// services trusting any tailnet caller, the frontend and model server: never behind a public port
const meshOnlyPorts = new Set([FrontendPort, 8791]);

const validPort = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;

// every host's public ports
export function ports(): PortRow[] {
  const out: PortRow[] = [];
  for (const f of store.list(portsDir)) {
    const [host, file] = f.split("/");
    if (!host || !file) continue;
    const r = obj(store.read(`${portsDir}/${f}`));
    if (!r || !validPort(r.port) || !validPort(r.pub) || (r.proto !== "tcp" && r.proto !== "udp")) continue;
    if (meshOnlyPorts.has(r.port)) continue;
    const row: PortRow = { host, name: file.replace(/\.json$/, ""), port: r.port, proto: r.proto, pub: r.pub };
    if (typeof r.srv === "string" && r.srv) row.srv = r.srv;
    out.push(row);
  }
  return out.sort((a, b) => a.pub - b.pub || a.proto.localeCompare(b.proto));
}

// why a port can't be published, "" when it can
export function portError(p: Partial<PortRow>, existing = ports()): string {
  if (!p.host || !labelRe.test(p.host)) return "no host";
  if (!p.name || !labelRe.test(p.name)) return "a name is letters, digits and dashes, up to 63";
  if (!validPort(p.port)) return "the service's port must be 1 to 65535";
  if (meshOnlyPorts.has(p.port)) return `${p.port} is phosphorus's own, for the mesh alone`;
  if (!validPort(p.pub)) return "the public port must be 1 to 65535";
  if (edgePorts.has(p.pub)) return `${p.pub} is phosphorus's own`;
  if (p.proto !== "tcp" && p.proto !== "udp") return "the protocol is tcp or udp";
  if (p.srv !== undefined && p.srv !== "" && !srvRe.test(p.srv))
    return "an SRV service is letters and digits, up to 15";
  const clash = existing.find(
    (e) => e.pub === p.pub && e.proto === p.proto && (e.host !== p.host || e.name !== p.name),
  );
  if (clash) return `${p.proto} ${p.pub} is ${clash.name}'s on ${clash.host}`;
  return "";
}

export function setPort(p: PortRow) {
  const rec: PortRec = { port: p.port, proto: p.proto, pub: p.pub };
  if (p.srv) rec.srv = p.srv;
  store.write(portRel(p.host, p.name), rec);
}

export const removePort = (host: string, name: string) => store.remove(portRel(host, name));

export const selfPorts = () => ports().filter((p) => p.host === SelfHost);

// --- an admin's own records ---------------------------------------------------------

export const recordsRel = "etc/mesh/records.json";
export type DNSRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT";
// name relative to the domain, "" the domain itself
export type DNSRecord = {
  id: string;
  name: string;
  type: DNSRecordType;
  value: string;
  priority?: number;
  ttl?: number;
};

const recordTypes = new Set<string>(["A", "AAAA", "CNAME", "MX", "TXT"]);
const relNameRe = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?)*$/;
const hostNameRe = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function dnsRecords(): DNSRecord[] {
  const list = obj(store.read(recordsRel))?.list;
  if (!Array.isArray(list)) return [];
  const out: DNSRecord[] = [];
  for (const x of list) {
    const r = obj(x);
    if (!r || typeof r.id !== "string" || !recordTypes.has(r.type)) continue;
    out.push({
      id: r.id,
      name: String(r.name ?? ""),
      type: r.type as DNSRecordType,
      value: String(r.value ?? ""),
      ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
      ...(typeof r.ttl === "number" ? { ttl: r.ttl } : {}),
    });
  }
  return out;
}

// why a record can't be served, "" when it can
export function dnsRecordError(r: Omit<DNSRecord, "id">, others = dnsRecords()): string {
  if (!recordTypes.has(r.type)) return "the type is A, AAAA, CNAME, MX or TXT";
  if (r.name && !relNameRe.test(r.name))
    return "the name is a label under the domain, www say, or blank for the domain";
  if (/^ns\d+$/.test(r.name) || r.name.startsWith("_acme-challenge")) return `${r.name} is phosphorus's own`;
  const v = r.value.trim();
  if (r.type === "A" && !isIPv4(v)) return "an A record's value is an IPv4 address";
  if (r.type === "AAAA" && !/^[0-9a-f:]+$/i.test(v)) return "an AAAA record's value is an IPv6 address";
  if ((r.type === "CNAME" || r.type === "MX") && !hostNameRe.test(v.replace(/\.$/, "").toLowerCase()))
    return `a ${r.type} record's value is a host name, mail.example.com say`;
  if (r.type === "TXT" && (!v || v.length > 1000)) return "a TXT record's value is up to 1000 characters";
  const p = r.priority;
  if (r.type === "MX" && p !== undefined && !(Number.isInteger(p) && p >= 0 && p <= 65535))
    return "an MX priority is 0 to 65535";
  if (r.type === "CNAME" && !r.name) return "the domain itself can't be a CNAME";
  const same = others.filter((o) => o.name === r.name);
  if (r.type === "CNAME" && same.length) return `${r.name} has records already; a CNAME stands alone`;
  if (same.some((o) => o.type === "CNAME")) return `${r.name} is a CNAME; it stands alone`;
  return "";
}

export function addDnsRecord(r: Omit<DNSRecord, "id">): DNSRecord {
  const rec: DNSRecord = { ...r, value: r.value.trim(), id: crypto.randomUUID().slice(0, 8) };
  store.write(recordsRel, { list: [...dnsRecords(), rec] }, true);
  return rec;
}

export const removeDnsRecord = (id: string) =>
  store.write(recordsRel, { list: dnsRecords().filter((r) => r.id !== id) }, true);
