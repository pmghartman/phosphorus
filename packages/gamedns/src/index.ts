// <game>.phosphorus to its host's tailnet IP, for the split DNS domain mesh
// keeps pointed here
import type { udp } from "bun";
import { envInt, errText, now } from "@phosphorus/util";

// fixed, GAME_ZONE retired
export const Zone = "phosphorus";
const ttlS = 5;
const retryMS = 10000;
const port = envInt("GAME_DNS_PORT", 53);

type Question = { labels: string[]; qtype: number; end: number };

const u16 = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const put16 = (b: Uint8Array, at: number, v: number) => ((b[at] = (v >> 8) & 0xff), (b[at + 1] = v & 0xff));

function readQuestion(msg: Uint8Array): Question | undefined {
  if (msg.length < 12 || u16(msg, 4) < 1) return;
  const labels: string[] = [];
  let off = 12;
  for (;;) {
    if (off >= msg.length) return;
    const l = msg[off]!;
    if (l === 0) {
      off++;
      break;
    }
    if (l > 63 || off + 1 + l > msg.length) return;
    // each byte one char, as Go's rune-per-byte did
    labels.push(String.fromCharCode(...msg.subarray(off + 1, off + 1 + l)).toLowerCase());
    off += 1 + l;
  }
  if (off + 4 > msg.length) return;
  return { labels, qtype: u16(msg, off), end: off + 4 };
}

function reply(msg: Uint8Array, q: Question, rcode: number, ip: string): Uint8Array {
  const h = new Uint8Array(12);
  h[0] = msg[0]!;
  h[1] = msg[1]!;
  h[2] = 0x80 | (msg[2]! & 0x78) | 0x04 | (msg[2]! & 0x01);
  h[3] = rcode;
  put16(h, 4, 1);
  if (ip) put16(h, 6, 1);
  const qs = msg.subarray(12, q.end);
  const rr = new Uint8Array(ip ? 16 : 0);
  if (ip) {
    put16(rr, 0, 0xc00c);
    put16(rr, 2, 1);
    put16(rr, 4, 1);
    put16(rr, 8, ttlS);
    put16(rr, 10, 4);
    ip.split(".").forEach((o, i) => {
      if (i < 4) rr[12 + i] = (Number.parseInt(o, 10) || 0) & 0xff;
    });
  }
  const out = new Uint8Array(12 + qs.length + rr.length);
  out.set(h);
  out.set(qs, 12);
  out.set(rr, 12 + qs.length);
  return out;
}

// one query, undefined to stay silent
export function answer(msg: Uint8Array, lookup: (name: string) => string): Uint8Array | undefined {
  if (msg.length < 12 || msg[2]! & 0x80) return;
  const q = readQuestion(msg);
  if (!q) return;
  if (msg[2]! & 0x78) return reply(msg, q, 4, "");
  if (!q.labels.length || q.labels[q.labels.length - 1] !== Zone) return reply(msg, q, 5, "");
  const ip = q.labels.length === 2 ? lookup(q.labels[0]!) : "";
  if (!ip) return reply(msg, q, 3, "");
  if (q.qtype === 1 || q.qtype === 255) return reply(msg, q, 0, ip);
  return reply(msg, q, 0, "");
}

// the .phosphorus listener, rebound on an IP change
export class Server {
  private sock?: udp.Socket<"buffer">;
  private boundIP = "";
  private failedAt = 0;
  private binding = false;

  // lookup(name) -> IPv4 or ""
  constructor(
    private lookup: (name: string) => string,
    private note: (key: string, msg: string) => void,
  ) {}

  private fail(ip: string, e: unknown) {
    this.failedAt = now();
    this.note("dns", `can't serve .${Zone} names on ${ip}:${port}, retrying: ${errText(e)}`);
  }

  // every tick, rebinding on a change
  bind(ip: string) {
    if (this.binding) return;
    if (ip === this.boundIP && (this.sock || now() - this.failedAt < retryMS)) return;
    this.sock?.close();
    this.sock = undefined;
    this.boundIP = ip;
    if (!ip) return;
    this.binding = true;
    Bun.udpSocket({
      hostname: ip,
      port,
      socket: {
        data: (s, buf, p, addr) => {
          let out: Uint8Array | undefined;
          try {
            out = answer(new Uint8Array(buf), this.lookup);
          } catch {}
          if (out) s.send(out, p, addr);
        },
        error: (s, e) => {
          if (this.sock !== s) return;
          this.sock = undefined;
          this.fail(ip, e);
        },
      },
    }).then(
      (s) => {
        this.binding = false;
        // the IP moved on while binding
        if (this.boundIP !== ip) return s.close();
        this.sock = s;
        this.note("dns", `serving .${Zone} names on ${ip}:${port}`);
      },
      (e) => {
        this.binding = false;
        if (this.boundIP === ip) this.fail(ip, e);
      },
    );
  }

  // the socket's port, 0 when not bound; for tests on GAME_DNS_PORT=0
  get port() {
    return this.sock?.port ?? 0;
  }
}
