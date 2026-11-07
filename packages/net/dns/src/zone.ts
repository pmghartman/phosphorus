// the mesh's zone: the domain and every name under it at the edge hosts,
// names of its own beside them, and the answer to a question about it

import { canon, type Query, Rcode, type Reply, type RR, Type } from "./wire.ts";

export type Srv = { name: string; service: string; proto: "tcp" | "udp"; port: number; target: string };

// a record an admin added: name relative to the domain, "" the apex
export type RecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT";
export type Custom = { name: string; type: RecordType; value: string; priority?: number; ttl?: number };

export type ZoneSpec = {
  domain: string;
  // the edge hosts' public IPv4s: the nameservers, the apex and every name not named below
  edges: string[];
  // names of their own under the domain, relative, each to its IPv4s
  hosts?: Record<string, string[]>;
  // texts under the domain, relative: the ACME challenge
  txt?: Record<string, string[]>;
  srv?: Srv[];
  records?: Custom[];
  // the ACME account's URL, the one CAA lets issue
  acmeAccount?: string;
  serial: number;
};

const ttlShort = 60;
const ttlLong = 3600;
const ttlTxt = 30;
// short, a new ACME account soon past a cached CAA naming the old one
const ttlCAA = 300;

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
  // RFC 8657: issuance by this account alone, over DNS alone
  const ca = spec.acmeAccount
    ? `letsencrypt.org; accounturi=${spec.acmeAccount}; validationmethods=dns-01`
    : "letsencrypt.org";
  for (const tag of ["issue", "issuewild"])
    add("", { name: domain, ttl: ttlCAA, data: { type: Type.CAA, flags: 0, tag, value: ca } });
  for (const [r, ips] of Object.entries(spec.hosts ?? {})) a(canon(r), ips);
  // a record per value: one record's strings read as one joined value
  for (const [r, texts] of Object.entries(spec.txt ?? {}))
    for (const t of texts)
      add(canon(r), { name: abs(canon(r), domain), ttl: ttlTxt, data: { type: Type.TXT, texts: [t] } });
  for (const s of spec.srv ?? []) {
    const r = canon(`_${s.service}._${s.proto}.${s.name}`);
    add(r, {
      name: abs(r, domain),
      ttl: ttlShort,
      data: { type: Type.SRV, priority: 0, weight: 0, port: s.port, target: canon(s.target) },
    });
  }
  for (const c of spec.records ?? []) {
    const r = canon(c.name);
    const ttl = c.ttl ?? ttlShort;
    const at = abs(r, domain);
    if (c.type === "A") add(r, { name: at, ttl, data: { type: Type.A, ip: c.value } });
    else if (c.type === "AAAA") add(r, { name: at, ttl, data: { type: Type.AAAA, ip: c.value } });
    else if (c.type === "CNAME") add(r, { name: at, ttl, data: { type: Type.CNAME, target: canon(c.value) } });
    else if (c.type === "MX")
      add(r, { name: at, ttl, data: { type: Type.MX, priority: c.priority ?? 10, target: canon(c.value) } });
    else add(r, { name: at, ttl, data: { type: Type.TXT, texts: [c.value] } });
  }
  const wildcard: RR[] = edges.map((ip) => ({ name: "", ttl: ttlShort, data: { type: Type.A, ip } }));
  return { domain, nameservers, names, soa, wildcard };
}

const inZone = (name: string, domain: string) => name === domain || name.endsWith(`.${domain}`);

// ANY as RFC 8482 answers it: one record set, the A records when there are any,
// never the whole name drawn back at a spoofed victim
function anyOf(rrs: RR[]): RR[] {
  const t = rrs.some((x) => x.data.type === Type.A) ? Type.A : rrs[0]!.data.type;
  return rrs.filter((x) => x.data.type === t);
}

// the records at name of type, the wildcard's for a name with none of its own
function lookup(z: Zone, name: string, type: number): { rrs: RR[]; exists: boolean } {
  const r = rel(name, z.domain);
  const own = z.names.get(r);
  if (own) {
    // a CNAME stands for every type but its own
    const alias = own.filter((x) => x.data.type === Type.CNAME);
    if (alias.length && type !== Type.CNAME) return { rrs: alias, exists: true };
    return { rrs: type === Type.ANY ? anyOf(own) : own.filter((x) => x.data.type === type), exists: true };
  }
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
  // glue beside NS, SRV and MX answers
  for (const r of rrs) {
    const d = r.data;
    const t = d.type === Type.NS || d.type === Type.SRV || d.type === Type.MX ? d.target : "";
    if (t && inZone(t, z.domain)) for (const g of lookup(z, t, Type.A).rrs) additional.push(g);
  }
  // an alias inside the zone followed once
  const answer = [...rrs];
  const a = rrs[0]?.data;
  if (a?.type === Type.CNAME && inZone(a.target, z.domain) && qq.type !== Type.CNAME)
    for (const r of lookup(z, a.target, qq.type).rrs) if (r.data.type !== Type.CNAME) answer.push(r);
  return { ...base, answer, additional };
}
