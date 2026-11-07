// the authoritative server: UDP and TCP on each given address, every
// question answered from the zone handed back by zone(), one outside it
// forwarded when there's somewhere to forward it

import type { Socket, TCPSocketListener, udp } from "bun";
import type { Forward } from "./forward.ts";
import { MinUDP, parseQuery, Rcode, writeReply } from "./wire.ts";
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
};

// a TCP client's bytes so far, messages taken as their length prefix completes
type TCPData = { buf: Uint8Array };

const maxTCP = 64 * 1024;

async function handle(o: Opts, b: Uint8Array, max: number): Promise<Uint8Array | undefined> {
  const q = parseQuery(b);
  // a response or noise dropped, never answered
  if (!q || q.bad === "response") return;
  const r = answer(o.zone(), q);
  if (r.rcode === Rcode.REFUSED && !r.aa && o.forward && q.question) {
    const got = await o.forward(b);
    if (got) return got;
    return writeReply({ ...r, rcode: Rcode.SERVFAIL }, max);
  }
  return writeReply(r, max);
}

export async function serve(o: Opts): Promise<Served> {
  if (o.port === 0) return serveAny(o);
  const log = o.log ?? (() => {});
  const udps: udp.Socket<"uint8array">[] = [];
  const tcps: TCPSocketListener<TCPData>[] = [];
  const close = () => {
    for (const u of udps) u.close();
    for (const t of tcps) t.stop(true);
  };
  try {
    for (const addr of o.addrs) {
      udps.push(await bindUDP(o, addr, o.port));
      tcps.push(
        Bun.listen<TCPData>({
          hostname: addr,
          port: o.port,
          socket: {
            open(s) {
              s.data = { buf: new Uint8Array(0) };
              s.timeout(10);
            },
            data(s, chunk) {
              const d = s.data;
              const joined = new Uint8Array(d.buf.length + chunk.length);
              joined.set(d.buf);
              joined.set(chunk, d.buf.length);
              d.buf = joined;
              if (d.buf.length > maxTCP) {
                s.end();
                return;
              }
              while (d.buf.length >= 2) {
                const n = (d.buf[0]! << 8) | d.buf[1]!;
                if (d.buf.length < 2 + n) break;
                const msg = d.buf.slice(2, 2 + n);
                d.buf = d.buf.slice(2 + n);
                void handle(o, msg, Number.POSITIVE_INFINITY).then((out) => out && send(s, out));
              }
            },
            timeout(s) {
              s.end();
            },
            error(_s, e) {
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

function bindUDP(o: Opts, addr: string, port: number) {
  return Bun.udpSocket<"uint8array">({
    hostname: addr,
    port,
    binaryType: "uint8array",
    socket: {
      data(s, buf, from, fromAddr) {
        const q = parseQuery(buf);
        const msg = buf.slice();
        void handle(o, msg, q?.edns ?? MinUDP).then((out) => out && s.send(out, from, fromAddr));
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
