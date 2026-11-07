// the authoritative server: UDP and TCP on each given address, every
// question answered from the zone handed back by zone(), one outside it
// forwarded when there's somewhere to forward it

import type { Socket, TCPSocketListener, udp } from "bun";
import type { Forward } from "./forward.ts";
import { MinUDP, parseQuery, type Query, Rcode, writeReply } from "./wire.ts";
import { answer, type Zone } from "./zone.ts";

export type Served = {
  addrs: string[];
  port: number;
  close(): void;
};

type Opts = {
  addrs: string[];
  port: number;
  zone: () => Zone | undefined;
  forward?: Forward;
  log?: (m: string) => void;
  // the UDP rate limit, a test's own; false on the mesh's own address, which no one spoofs
  limit?: ReturnType<typeof limiter> | false;
};

// a TCP client's bytes so far in buf[0, len), messages taken as their length prefix completes
type TCPData = { buf: Uint8Array; len: number; ip: string; counted?: boolean; life?: ReturnType<typeof setTimeout> };

// one query over TCP at most this long, a client sending more cut off
const maxMsg = 4096;
const tcpMax = 256;
const tcpPerIP = 8;
const tcpLifeS = 30;

// UDP replies per source network: rate a second and burst at once, then every
// slip'th reply sent truncated so a real resolver retries over TCP, the rest dropped
const rate = 50;
const burst = 100;
const slip = 2;
const maxBuckets = 50_000;
type Bucket = { tokens: number; at: number; over: number };

// IPv4 by its /24, IPv6 by its /48, a spoofer's neighbours sharing one bucket
export const netOf = (ip: string) =>
  ip.includes(".") ? ip.slice(0, ip.lastIndexOf(".")) : ip.split(":").slice(0, 3).join(":");

// "send", "tc" or "drop" for a reply to ip now
export function limiter(r = rate, b = burst, s = slip) {
  const buckets = new Map<string, Bucket>();
  return (ip: string, at = performance.now()): "send" | "tc" | "drop" => {
    const k = netOf(ip);
    let x = buckets.get(k);
    if (!x) {
      if (buckets.size >= maxBuckets) buckets.clear();
      x = { tokens: b, at, over: 0 };
      buckets.set(k, x);
    }
    x.tokens = Math.min(b, x.tokens + ((at - x.at) / 1000) * r);
    x.at = at;
    if (x.tokens >= 1) {
      x.tokens--;
      return "send";
    }
    return ++x.over % s === 0 ? "tc" : "drop";
  };
}

type Out = Uint8Array | Promise<Uint8Array | undefined> | undefined;

// the reply, a promise only for a question forwarded
function handle(o: Opts, q: Query | undefined, raw: Uint8Array, max: number, tc = false): Out {
  // a response or noise dropped, never answered
  if (!q || q.bad === "response") return;
  const r = answer(o.zone(), q);
  if (r.rcode === Rcode.REFUSED && !r.aa && o.forward && q.question && !tc)
    return o.forward(raw.slice()).then((got) => got ?? writeReply({ ...r, rcode: Rcode.SERVFAIL }, max));
  return writeReply(r, tc ? 0 : max);
}

const reply = (out: Out, fn: (b: Uint8Array) => void) =>
  out instanceof Promise ? void out.then((b) => b && fn(b)) : out && fn(out);

export async function serve(o: Opts): Promise<Served> {
  if (o.port === 0) return serveAny(o);
  const log = o.log ?? (() => {});
  const udps: udp.Socket<"uint8array">[] = [];
  const tcps: TCPSocketListener<TCPData>[] = [];
  let open = 0;
  const conns = new Map<string, number>();
  // a counted connection's place given back, once
  const release = (d: TCPData | undefined) => {
    if (!d?.counted) return;
    d.counted = false;
    clearTimeout(d.life);
    open--;
    const n = (conns.get(d.ip) ?? 1) - 1;
    if (n > 0) conns.set(d.ip, n);
    else conns.delete(d.ip);
  };
  const allow = o.limit === false ? false : (o.limit ?? limiter());
  const close = () => {
    for (const u of udps) u.close();
    for (const t of tcps) t.stop(true);
  };
  try {
    for (const addr of o.addrs) {
      udps.push(await bindUDP(o, addr, o.port, allow));
      tcps.push(
        Bun.listen<TCPData>({
          hostname: addr,
          port: o.port,
          socket: {
            open(s) {
              const ip = s.remoteAddress;
              const n = conns.get(ip) ?? 0;
              s.data = { buf: new Uint8Array(2 + maxMsg), len: 0, ip };
              if (open >= tcpMax || n >= tcpPerIP) return void s.end();
              open++;
              conns.set(ip, n + 1);
              s.data.counted = true;
              s.timeout(10);
              // a trickling client cut off whatever it sends
              s.data.life = setTimeout(() => s.end(), tcpLifeS * 1000);
            },
            data(s, chunk) {
              const d = s.data;
              // taken a buffer's room at a time, pipelined queries read as each completes
              for (let off = 0; off < chunk.length; ) {
                const take = Math.min(chunk.length - off, d.buf.length - d.len);
                if (take === 0) return void s.end();
                d.buf.set(chunk.subarray(off, off + take), d.len);
                d.len += take;
                off += take;
                let at = 0;
                while (d.len - at >= 2) {
                  const n = (d.buf[at]! << 8) | d.buf[at + 1]!;
                  if (n > maxMsg) return void s.end();
                  if (d.len - at < 2 + n) break;
                  const msg = d.buf.subarray(at + 2, at + 2 + n);
                  reply(handle(o, parseQuery(msg), msg, Number.POSITIVE_INFINITY), (b) => send(s, b));
                  at += 2 + n;
                }
                if (at) {
                  d.buf.copyWithin(0, at, d.len);
                  d.len -= at;
                }
              }
            },
            close(s) {
              release(s.data);
            },
            timeout(s) {
              s.end();
            },
            error(s, e) {
              release(s.data);
              log(`tcp ${addr}: ${e.message}`);
            },
          },
        }),
      );
    }
  } catch (e) {
    close();
    throw e;
  }
  return { addrs: o.addrs, port: o.port, close };
}

// port 0: a free port both UDP and TCP take, each picking in turn (Windows
// excludes ranges per protocol) until one suits both
async function serveAny(o: Opts): Promise<Served> {
  let last: unknown;
  for (let i = 0; i < 16; i++) {
    let port: number;
    if (i % 2 === 0) {
      const t = Bun.listen<TCPData>({ hostname: o.addrs[0]!, port: 0, socket: { data() {} } });
      port = t.port;
      t.stop(true);
    } else {
      const u = await Bun.udpSocket({ hostname: o.addrs[0]!, port: 0 });
      port = u.port;
      u.close();
    }
    try {
      return await serve({ ...o, port });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

function bindUDP(o: Opts, addr: string, port: number, allow: ReturnType<typeof limiter> | false) {
  return Bun.udpSocket<"uint8array">({
    hostname: addr,
    port,
    binaryType: "uint8array",
    socket: {
      data(s, buf, from, fromAddr) {
        const say = allow ? allow(fromAddr) : "send";
        if (say === "drop") return;
        const q = parseQuery(buf);
        reply(handle(o, q, buf, q?.edns ?? MinUDP, say === "tc"), (b) => s.send(b, from, fromAddr));
      },
      error(_s, e) {
        o.log?.(`udp ${addr}: ${e.message}`);
      },
    },
  });
}

function send(s: Socket<TCPData>, msg: Uint8Array) {
  const framed = new Uint8Array(2 + msg.length);
  framed[0] = msg.length >> 8;
  framed[1] = msg.length & 0xff;
  framed.set(msg, 2);
  s.write(framed);
}
