// the edge host's 443: TLS split by server name, the control server's bytes
// to headscale, everything else to the ingress's own TLS server on loopback

import { logf } from "@phosphorus/util";
import type { Socket, TCPSocketListener } from "bun";
import { finish, flush, type Out, outbox, send } from "./pipe.ts";

// the client behind each loopback connection the splitter made, by its source port
const clients = new Map<number, string>();

// the client's address for a connection the splitter made, blank for any other
export const splitClient = (addr: { address: string; port: number } | null): string =>
  addr && (addr.address === "127.0.0.1" || addr.address === "::ffff:127.0.0.1") ? (clients.get(addr.port) ?? "") : "";

// the server name in a TLS ClientHello: undefined while more bytes are needed,
// null when the bytes aren't a ClientHello, "" when it names no server
export function sniOf(b: Uint8Array): string | undefined | null {
  if (b.length < 5) return undefined;
  // a TLS handshake record, version 3.x
  if (b[0] !== 0x16 || b[1] !== 3) return null;
  const recLen = (b[3]! << 8) | b[4]!;
  if (b.length < 5 + recLen) return b.length < 5 + Math.min(recLen, 16384) ? undefined : null;
  const h = b.subarray(5, 5 + recLen);
  if (h[0] !== 1) return null;
  let p = 4 + 2 + 32;
  const u16 = (i: number) => (h[i]! << 8) | h[i + 1]!;
  if (p >= h.length) return null;
  p += 1 + h[p]!;
  if (p + 2 > h.length) return null;
  p += 2 + u16(p);
  if (p + 1 > h.length) return null;
  p += 1 + h[p]!;
  if (p + 2 > h.length) return "";
  const extEnd = p + 2 + u16(p);
  p += 2;
  while (p + 4 <= extEnd && p + 4 <= h.length) {
    const type = u16(p);
    const len = u16(p + 2);
    p += 4;
    if (type === 0) {
      let q = p + 2;
      while (q + 3 <= p + len) {
        const kind = h[q]!;
        const n = u16(q + 1);
        if (kind === 0) return new TextDecoder("latin1").decode(h.subarray(q + 3, q + 3 + n)).toLowerCase();
        q += 3 + n;
      }
      return "";
    }
    p += len;
  }
  return "";
}

// out: what's waiting to be written to this side
type Side = { peer?: Socket<Side>; buf: Uint8Array[]; pending: boolean; out: Out };

export type Split = {
  port: number;
  // the loopback port the ingress's TLS server is on now
  setIngress(port: number): void;
  // the control server's name and loopback port, none when it isn't behind this edge
  setControl(name: string, port: number): void;
  stop(): void;
};

const helloMax = 16 * 1024 + 5;
const helloWaitS = 5;

// 443 split: a listener whose targets can change while it runs
export function split(port: number, hostname?: string): Split {
  let ingress = 0;
  let control = { name: "", port: 0 };
  const target = (sni: string) => (sni && sni === control.name && control.port ? control.port : ingress);
  const listener: TCPSocketListener<Side> = Bun.listen<Side>({
    hostname: hostname ?? "0.0.0.0",
    port,
    socket: {
      open(s) {
        s.data = { buf: [], pending: true, out: outbox() };
        s.timeout(helloWaitS);
      },
      data(s, chunk) {
        const d = s.data;
        if (d.peer) {
          send(d.peer, d.peer.data.out, chunk, s);
          return;
        }
        d.buf.push(chunk);
        const all = joined(d.buf);
        const sni = sniOf(all);
        if (sni === undefined && all.length < helloMax) return;
        const to = sni === undefined || sni === null ? ingress : target(sni);
        if (!to) {
          s.end();
          return;
        }
        d.pending = false;
        s.timeout(0);
        connect(s, all, to);
      },
      close(s) {
        const up = s.data?.peer;
        if (up) finish(up, up.data.out);
      },
      timeout(s) {
        if (s.data?.pending) s.end();
      },
      error(s) {
        const up = s.data?.peer;
        if (up) finish(up, up.data.out);
      },
      drain(s) {
        flush(s, s.data.out);
      },
    },
  });
  return {
    port: listener.port,
    setIngress: (p) => void (ingress = p),
    setControl: (name, p) => void (control = { name: name.toLowerCase(), port: p }),
    stop: () => listener.stop(true),
  };
}

function joined(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

// the client's bytes so far and every one after piped to loopback:port
function connect(down: Socket<Side>, head: Uint8Array, port: number) {
  const client = down.remoteAddress.replace(/^::ffff:/, "");
  Bun.connect<Side>({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(up) {
        up.data = { peer: down, buf: [], pending: false, out: outbox() };
        down.data.peer = up;
        clients.set(up.localPort, client);
        send(up, up.data.out, head, down);
      },
      data(up, chunk) {
        send(down, down.data.out, chunk, up);
      },
      close(up) {
        clients.delete(up.localPort);
        finish(down, down.data.out);
      },
      error(up) {
        clients.delete(up.localPort);
        finish(down, down.data.out);
      },
      connectError() {
        down.end();
      },
      drain(up) {
        flush(up, up.data.out);
      },
    },
  }).catch((e) => {
    logf("[edge] loopback %d: %s", port, (e as Error).message);
    down.end();
  });
}
