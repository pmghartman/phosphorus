// DNS messages on the wire: the header and question read, answers written;
// names read with compression pointers, written plain

export const Type = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  OPT: 41,
  CAA: 257,
  ANY: 255,
} as const;
export const Rcode = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;
export const ClassIN = 1;
// the UDP payload every resolver takes without fragmenting
export const MaxUDP = 1232;
export const MinUDP = 512;

export type Question = { name: string; type: number; cls: number };

export type Query = {
  id: number;
  opcode: number;
  rd: boolean;
  question?: Question;
  // EDNS asked, the payload size the asker takes
  edns?: number;
  // more than one question, or a response: answered FORMERR or dropped
  bad?: string;
};

export type RData =
  | { type: 1; ip: string }
  | { type: 28; ip: string }
  | { type: 2; target: string }
  | { type: 5; target: string }
  | { type: 15; priority: number; target: string }
  | { type: 16; texts: string[] }
  | {
      type: 6;
      mname: string;
      rname: string;
      serial: number;
      refresh: number;
      retry: number;
      expire: number;
      minimum: number;
    }
  | { type: 33; priority: number; weight: number; port: number; target: string }
  | { type: 257; flags: number; tag: string; value: string };

export type RR = { name: string; ttl: number; data: RData };

export type Reply = {
  id: number;
  rd: boolean;
  aa: boolean;
  rcode: number;
  question?: Question;
  answer: RR[];
  authority: RR[];
  additional: RR[];
  // an OPT record echoed when the query had one
  edns?: boolean;
};

// a name as the zone keeps it: lowercase, no trailing dot, "" for the root
export const canon = (n: string) => n.toLowerCase().replace(/\.+$/, "");

const labelsOf = (n: string) => (canon(n) ? canon(n).split(".") : []);

const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder();
const enc = new TextEncoder();

// name read at off, pointers followed at most 32 times; [name, offset after it]
export function readName(b: Uint8Array, off: number): [string, number] {
  const parts: string[] = [];
  let end = -1;
  let hops = 0;
  let p = off;
  for (;;) {
    if (p >= b.length) throw new Error("name past the end");
    const len = b[p]!;
    if (len === 0) {
      p++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (p + 1 >= b.length) throw new Error("pointer past the end");
      if (end < 0) end = p + 2;
      p = ((len & 0x3f) << 8) | b[p + 1]!;
      if (++hops > 32) throw new Error("pointer loop");
      continue;
    }
    if (len > 63) throw new Error("label too long");
    if (p + 1 + len > b.length) throw new Error("label past the end");
    parts.push(latin1.decode(b.subarray(p + 1, p + 1 + len)));
    p += 1 + len;
  }
  return [parts.join("."), end < 0 ? p : end];
}

const u16at = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32at = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

// the query parsed as far as answering it needs
export function parseQuery(b: Uint8Array): Query | undefined {
  if (b.length < 12) return;
  const flags = u16at(b, 2);
  const q: Query = { id: u16at(b, 0), opcode: (flags >> 11) & 0xf, rd: !!(flags & 0x100) };
  if (flags & 0x8000) {
    q.bad = "response";
    return q;
  }
  if (u16at(b, 4) !== 1) {
    q.bad = "questions";
    return q;
  }
  try {
    const [name, after] = readName(b, 12);
    if (after + 4 > b.length) throw new Error("question cut");
    q.question = { name: canon(name), type: u16at(b, after), cls: u16at(b, after + 2) };
    // the additional section walked for OPT, answers and authority skipped
    const an = u16at(b, 6),
      ns = u16at(b, 8),
      ar = u16at(b, 10);
    let p = after + 4;
    for (let i = 0; i < an + ns + ar; i++) {
      const [, np] = readName(b, p);
      if (np + 10 > b.length) break;
      const type = u16at(b, np);
      if (type === Type.OPT && i >= an + ns) q.edns = Math.max(MinUDP, u16at(b, np + 2));
      p = np + 10 + u16at(b, np + 8);
    }
  } catch {
    q.bad = "malformed";
  }
  return q;
}

// --- writing ---------------------------------------------------------------

class Out {
  buf = new Uint8Array(4096);
  len = 0;
  private room(n: number) {
    if (this.len + n <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(v: number) {
    this.room(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v: number) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v: number) {
    this.u16(v >>> 16);
    this.u16(v & 0xffff);
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  name(n: string) {
    for (const l of labelsOf(n)) {
      const b = enc.encode(l);
      if (b.length > 63) throw new Error("label too long");
      this.u8(b.length);
      this.bytes(b);
    }
    this.u8(0);
  }
  // a character string, 255 at most
  chars(s: string) {
    const b = enc.encode(s);
    if (b.length > 255) throw new Error("text too long");
    this.u8(b.length);
    this.bytes(b);
  }
  out() {
    return this.buf.slice(0, this.len);
  }
}

const ip4 = (ip: string) => {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`bad IPv4 ${ip}`);
  return new Uint8Array(p);
};

// an IPv6 as 16 bytes, :: expanded
export function ip6(ip: string): Uint8Array {
  const halves = ip.split("::");
  if (halves.length > 2) throw new Error(`bad IPv6 ${ip}`);
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array(Math.max(fill, 0)).fill("0"), ...tail];
  if (groups.length !== 8) throw new Error(`bad IPv6 ${ip}`);
  const out = new Uint8Array(16);
  groups.forEach((g, i) => {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) throw new Error(`bad IPv6 ${ip}`);
    const v = Number.parseInt(g, 16);
    out[i * 2] = v >> 8;
    out[i * 2 + 1] = v & 0xff;
  });
  return out;
}

function rdata(o: Out, d: RData) {
  switch (d.type) {
    case Type.A:
      o.bytes(ip4(d.ip));
      return;
    case Type.AAAA:
      o.bytes(ip6(d.ip));
      return;
    case Type.NS:
    case Type.CNAME:
      o.name(d.target);
      return;
    case Type.MX:
      o.u16(d.priority);
      o.name(d.target);
      return;
    case Type.TXT:
      for (const t of d.texts) {
        // long text split into 255 byte strings
        const b = enc.encode(t);
        for (let i = 0; i < Math.max(b.length, 1); i += 255) {
          const part = b.subarray(i, i + 255);
          o.u8(part.length);
          o.bytes(part);
        }
      }
      return;
    case Type.SOA:
      o.name(d.mname);
      o.name(d.rname);
      o.u32(d.serial);
      o.u32(d.refresh);
      o.u32(d.retry);
      o.u32(d.expire);
      o.u32(d.minimum);
      return;
    case Type.SRV:
      o.u16(d.priority);
      o.u16(d.weight);
      o.u16(d.port);
      o.name(d.target);
      return;
    case Type.CAA:
      o.u8(d.flags);
      o.chars(d.tag);
      o.bytes(enc.encode(d.value));
      return;
  }
}

function rr(o: Out, r: RR) {
  o.name(r.name);
  o.u16(r.data.type);
  o.u16(ClassIN);
  o.u32(r.ttl);
  const at = o.len;
  o.u16(0);
  rdata(o, r.data);
  const n = o.len - at - 2;
  o.buf[at] = n >> 8;
  o.buf[at + 1] = n & 0xff;
}

// the reply as bytes; over max (UDP) the records are dropped and TC set
export function writeReply(r: Reply, max = Number.POSITIVE_INFINITY): Uint8Array {
  const build = (truncate: boolean) => {
    const o = new Out();
    o.u16(r.id);
    o.u16(0x8000 | (r.aa ? 0x400 : 0) | (r.rd ? 0x100 : 0) | (truncate ? 0x200 : 0) | (r.rcode & 0xf));
    const ans = truncate ? [] : r.answer;
    const auth = truncate ? [] : r.authority;
    const add = truncate ? [] : r.additional;
    o.u16(r.question ? 1 : 0);
    o.u16(ans.length);
    o.u16(auth.length);
    o.u16(add.length + (r.edns ? 1 : 0));
    if (r.question) {
      o.name(r.question.name);
      o.u16(r.question.type);
      o.u16(r.question.cls);
    }
    for (const x of ans) rr(o, x);
    for (const x of auth) rr(o, x);
    for (const x of add) rr(o, x);
    if (r.edns) {
      o.u8(0);
      o.u16(Type.OPT);
      o.u16(MaxUDP);
      o.u32(0);
      o.u16(0);
    }
    return o.out();
  };
  const b = build(false);
  return b.length > max ? build(true) : b;
}

// a question as bytes, EDNS asking for MaxUDP; the asking side
export function writeQuery(id: number, name: string, type: number, rd = false): Uint8Array {
  const o = new Out();
  o.u16(id);
  o.u16(rd ? 0x100 : 0);
  o.u16(1);
  o.u16(0);
  o.u16(0);
  o.u16(1);
  o.name(name);
  o.u16(type);
  o.u16(ClassIN);
  o.u8(0);
  o.u16(Type.OPT);
  o.u16(MaxUDP);
  o.u32(0);
  o.u16(0);
  return o.out();
}

export type Parsed = { id: number; rcode: number; tc: boolean; aa: boolean; answer: RR[]; authority: RR[] };

function readRR(b: Uint8Array, p: number): [RR | undefined, number] {
  const [name, np] = readName(b, p);
  if (np + 10 > b.length) throw new Error("record cut");
  const type = u16at(b, np);
  const ttl = u32at(b, np + 4);
  const s = np + 10;
  const e = s + u16at(b, np + 8);
  if (e > b.length) throw new Error("rdata cut");
  let data: RData | undefined;
  switch (type) {
    case Type.A:
      if (e - s === 4) data = { type, ip: Array.from(b.subarray(s, e)).join(".") };
      break;
    case Type.AAAA:
      if (e - s === 16) {
        const g: string[] = [];
        for (let i = 0; i < 16; i += 2) g.push(u16at(b, s + i).toString(16));
        data = { type, ip: g.join(":") };
      }
      break;
    case Type.NS:
    case Type.CNAME:
      data = { type, target: canon(readName(b, s)[0]) };
      break;
    case Type.MX:
      data = { type, priority: u16at(b, s), target: canon(readName(b, s + 2)[0]) };
      break;
    case Type.TXT: {
      const texts: string[] = [];
      for (let q = s; q < e; ) {
        const n = b[q]!;
        texts.push(utf8.decode(b.subarray(q + 1, q + 1 + n)));
        q += 1 + n;
      }
      data = { type, texts };
      break;
    }
    case Type.SOA: {
      const [mname, a] = readName(b, s);
      const [rname, c] = readName(b, a);
      data = {
        type,
        mname: canon(mname),
        rname: canon(rname),
        serial: u32at(b, c),
        refresh: u32at(b, c + 4),
        retry: u32at(b, c + 8),
        expire: u32at(b, c + 12),
        minimum: u32at(b, c + 16),
      };
      break;
    }
    case Type.SRV:
      data = {
        type,
        priority: u16at(b, s),
        weight: u16at(b, s + 2),
        port: u16at(b, s + 4),
        target: canon(readName(b, s + 6)[0]),
      };
      break;
    case Type.CAA: {
      const tl = b[s + 1]!;
      data = {
        type,
        flags: b[s]!,
        tag: utf8.decode(b.subarray(s + 2, s + 2 + tl)),
        value: utf8.decode(b.subarray(s + 2 + tl, e)),
      };
      break;
    }
  }
  return [data ? { name: canon(name), ttl, data } : undefined, e];
}

// a reply parsed, unknown types skipped; the asking side
export function parseReply(b: Uint8Array): Parsed {
  if (b.length < 12) throw new Error("reply too short");
  const flags = u16at(b, 2);
  const qd = u16at(b, 4),
    an = u16at(b, 6),
    ns = u16at(b, 8);
  let p = 12;
  for (let i = 0; i < qd; i++) p = readName(b, p)[1] + 4;
  const answer: RR[] = [];
  const authority: RR[] = [];
  for (let i = 0; i < an; i++) {
    const [r, np] = readRR(b, p);
    if (r) answer.push(r);
    p = np;
  }
  for (let i = 0; i < ns; i++) {
    const [r, np] = readRR(b, p);
    if (r) authority.push(r);
    p = np;
  }
  return { id: u16at(b, 0), rcode: flags & 0xf, tc: !!(flags & 0x200), aa: !!(flags & 0x400), answer, authority };
}
