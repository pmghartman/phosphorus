// the authoritative server: UDP and TCP on each given address, every
// question answered from the zone handed back by zone()

import type { Socket, TCPSocketListener, udp } from "bun";
import { MinUDP, parseQuery, writeReply } from "./wire.ts";
import { type Zone, answer } from "./zone.ts";

export type Served = {
  addrs: string[];
  port: number;
  close(): void;
};

type Opts = {
  addrs: string[];
  port: number;
  zone: () => Zone | undefined;
  log?: (m: string) => void;
};

// a TCP client's bytes so far, messages taken as their length prefix completes
type TCPData = { buf: Uint8Array };

const maxTCP = 64 * 1024;

function handle(zone: () => Zone | undefined, b: Uint8Array, max: number): Uint8Array | undefined {
  const q = parseQuery(b);
  // a response or noise dropped, never answered
  if (!q || q.bad === "response") return;
  return writeReply(answer(zone(), q), max);
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
                const out = handle(o.zone, msg, Number.POSITIVE_INFINITY);
                if (out) send(s, out);
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

// port 0: a free port both UDP and TCP take, a few tries
async function serveAny(o: Opts): Promise<Served> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    // TCP picks: its free ports are the scarcer ones (Windows excludes ranges)
    const t = Bun.listen<TCPData>({ hostname: o.addrs[0]!, port: 0, socket: { data() {} } });
    const port = t.port;
    t.stop(true);
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
        const out = handle(o.zone, buf, q?.edns ?? MinUDP);
        if (out) s.send(out, from, fromAddr);
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
