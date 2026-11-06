// the mesh's domain in the store: its name and the edge hosts that serve it on
// the internet, the certificate over it, the ACME account and challenge, and
// the public ports each host asks the edge to open
import * as store from "@phosphorus/store";
import { now, obj, SelfHost } from "@phosphorus/util";

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

const validPort = (p: unknown): p is number => typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535;

// every host's public ports
export function ports(): PortRow[] {
  const out: PortRow[] = [];
  for (const f of store.list(portsDir)) {
    const [host, file] = f.split("/");
    if (!host || !file) continue;
    const r = obj(store.read(`${portsDir}/${f}`));
    if (!r || !validPort(r.port) || !validPort(r.pub) || (r.proto !== "tcp" && r.proto !== "udp")) continue;
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
