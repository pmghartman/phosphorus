// the mesh's zone: the domain and every name under it at the edge hosts,
// names of its own beside them, and the answer to a question about it

import { canon, type Query, Rcode, type Reply, type RR, Type } from "./wire.ts";

export type Srv = { name: string; service: string; proto: "tcp" | "udp"; port: number; target: string };

export type ZoneSpec = {
  domain: string;
  // the edge hosts' public IPv4s: the nameservers, the apex and every name not named below
  edges: string[];
  // names of their own under the domain, relative, each to its IPv4s
  hosts?: Record<string, string[]>;
  // texts under the domain, relative: the ACME challenge
  txt?: Record<string, string[]>;
  srv?: Srv[];
  serial: number;
};

const ttlShort = 60;
const ttlLong = 3600;
const ttlTxt = 30;

export type Zone = {
  domain: string;
  nameservers: string[];
  // every name's records, "" the apex, others relative to the domain
  names: Map<string, RR[]>;
  soa: RR;
  wildcard: RR[];
};

const rel = (name: string, domain: string) => (name === domain ? "" : name.slice(0, -(domain.length + 1)));

const abs = (r: string, domain: string) => (r ? `${r}.${domain}` : domain);

// the zone from its spec, nsN names one per edge and two at least
export function build(spec: ZoneSpec): Zone {
  const domain = canon(spec.domain);
  const edges = [...new Set(spec.edges)];
  const names = new Map<string, RR[]>();
  const add = (r: string, rr: RR) => {
    const list = names.get(r) ?? [];
    list.push(rr);
    names.set(r, list);
  };
  const a = (r: string, ips: string[], ttl = ttlShort) =>
    ips.forEach((ip) => add(r, { name: abs(r, domain), ttl, data: { type: Type.A, ip } }));
  const nsCount = Math.max(2, edges.length);
  const nameservers: string[] = [];
  for (let i = 0; i < nsCount && edges.length; i++) {
    const ns = `ns${i + 1}`;
    nameservers.push(abs(ns, domain));
    add("", { name: domain, ttl: ttlLong, data: { type: Type.NS, target: abs(ns, domain) } });
    a(ns, [edges[i % edges.length]!], ttlLong);
  }
  const soa: RR = {
    name: domain,
    ttl: ttlLong,
    data: {
      type: Type.SOA,
      mname: nameservers[0] ?? domain,
      rname: `hostmaster.${domain}`,
      serial: spec.serial >>> 0,
      refresh: 3600,
      retry: 600,
      expire: 1209600,
      minimum: 60,
    },
  };
  add("", soa);
  a("", edges);
  add("", { name: domain, ttl: ttlLong, data: { type: Type.CAA, flags: 0, tag: "issue", value: "letsencrypt.org" } });
  for (const [r, ips] of Object.entries(spec.hosts ?? {})) a(canon(r), ips);
  for (const [r, texts] of Object.entries(spec.txt ?? {}))
    if (texts.length) add(canon(r), { name: abs(canon(r), domain), ttl: ttlTxt, data: { type: Type.TXT, texts } });
  for (const s of spec.srv ?? []) {
    const r = canon(`_${s.service}._${s.proto}.${s.name}`);
    add(r, {
      name: abs(r, domain),
      ttl: ttlShort,
      data: { type: Type.SRV, priority: 0, weight: 0, port: s.port, target: canon(s.target) },
    });
  }
  const wildcard: RR[] = edges.map((ip) => ({ name: "", ttl: ttlShort, data: { type: Type.A, ip } }));
  return { domain, nameservers, names, soa, wildcard };
}

const inZone = (name: string, domain: string) => name === domain || name.endsWith(`.${domain}`);

// the records at name of type, the wildcard's for a name with none of its own
function lookup(z: Zone, name: string, type: number): { rrs: RR[]; exists: boolean } {
  const r = rel(name, z.domain);
  const own = z.names.get(r);
  if (own) return { rrs: type === Type.ANY ? own : own.filter((x) => x.data.type === type), exists: true };
  // every other name is the wildcard's, so it exists while there are edges
  const synth = type === Type.A || type === Type.ANY ? z.wildcard.map((x) => ({ ...x, name })) : [];
  return { rrs: synth, exists: z.wildcard.length > 0 };
}

// the reply to q, aa for the zone's names, REFUSED outside it
export function answer(z: Zone | undefined, q: Query): Reply {
  const base: Reply = {
    id: q.id,
    rd: q.rd,
    aa: false,
    rcode: Rcode.NOERROR,
    answer: [],
    authority: [],
    additional: [],
  };
  if (q.edns !== undefined) base.edns = true;
  if (q.bad) return { ...base, rcode: Rcode.FORMERR };
  if (q.opcode !== 0) return { ...base, question: q.question, rcode: Rcode.NOTIMP };
  const qq = q.question!;
  base.question = qq;
  if (!z || (qq.cls !== 1 && qq.cls !== 255) || !inZone(qq.name, z.domain)) return { ...base, rcode: Rcode.REFUSED };
  base.aa = true;
  const { rrs, exists } = lookup(z, qq.name, qq.type);
  if (rrs.length === 0) {
    // NODATA, or NXDOMAIN for a name nothing synthesizes
    return { ...base, rcode: exists ? Rcode.NOERROR : Rcode.NXDOMAIN, authority: [{ ...z.soa, ttl: 60 }] };
  }
  const additional: RR[] = [];
  // glue beside NS and SRV answers
  for (const r of rrs) {
    const t = r.data.type === Type.NS || r.data.type === Type.SRV ? r.data.target : "";
    if (t && inZone(t, z.domain)) for (const g of lookup(z, t, Type.A).rrs) additional.push(g);
  }
  return { ...base, answer: rrs, additional };
}
