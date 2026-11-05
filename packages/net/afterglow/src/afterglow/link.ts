// the local link to afterglow, phosphorus's streaming host (github.com/pmghartman/afterglow,
// its docs/protocol.md the contract): one loopback TCP connection in place of GameStream's
// HTTPS, RTSP, ENet and RTP. A message is a u32 little-endian length of what follows, a
// type byte, the body (afterglow's host/src/wire.rs and link.rs the other side). Frames
// come already shaped for the viewer: 8 bytes of room for its header, then AVCC, so each
// is copied once, out of the socket's bytes into its own message

import { protoOf, protoOK, protoWhy } from "./proto.ts";

export const In = {
  hello: 0x01,
  launch: 0x02,
  video: 0x03,
  stopVideo: 0x04,
  idr: 0x05,
  input: 0x06,
  quit: 0x07,
  ping: 0x08,
  // the viewer's clipboard, for the app's own paste
  clip: 0x09,
  // u32 LE: a window from a windows note brought to the front
  raise: 0x0a,
  // ask the app to close as its own close button does
  close: 0x0b,
} as const;

export const Out = {
  ready: 0x81,
  launched: 0x82,
  exited: 0x83,
  videoEnded: 0x84,
  // JSON {t: "title" | "windows" | "clip", ...}
  note: 0x85,
  pong: 0x88,
  config: 0x90,
  frame: 0x91,
  cursor: 0x92,
} as const;

export const maxLen = 64 << 20;

// one message: its length, type and body
export function message(type: number, body: Uint8Array | string = new Uint8Array(0)): Uint8Array {
  const b = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const out = new Uint8Array(5 + b.length);
  new DataView(out.buffer).setUint32(0, 1 + b.length, true);
  out[4] = type;
  out.set(b, 5);
  return out;
}

// what afterglow sends, out of its byte stream however it was cut: each message the
// type byte and body as one fresh array, so a frame can be handed on as it is. Every
// byte is copied once: a message whole in a chunk is sliced out of it, one that spans
// chunks is put together in its own array as they come
export class LinkReader {
  private head = new Uint8Array(4);
  private headN = 0;
  private msg?: Uint8Array;
  private msgN = 0;
  broken = false;

  constructor(private out: (msg: Uint8Array) => void) {}

  feed(chunk: Uint8Array) {
    const len = chunk.length;
    let i = 0;
    while (i < len && !this.broken) {
      const m = this.msg;
      if (m) {
        const k = Math.min(m.length - this.msgN, len - i);
        m.set(chunk.subarray(i, i + k), this.msgN);
        this.msgN += k;
        i += k;
        if (this.msgN === m.length) {
          this.msg = undefined;
          this.out(m);
        }
        continue;
      }
      let n: number;
      if (this.headN === 0 && len - i >= 4) {
        n = (chunk[i]! | (chunk[i + 1]! << 8) | (chunk[i + 2]! << 16) | (chunk[i + 3]! << 24)) >>> 0;
        i += 4;
      } else {
        while (this.headN < 4 && i < len) this.head[this.headN++] = chunk[i++]!;
        if (this.headN < 4) return;
        const h = this.head;
        n = (h[0]! | (h[1]! << 8) | (h[2]! << 16) | (h[3]! << 24)) >>> 0;
        this.headN = 0;
      }
      if (n < 1 || n > maxLen) {
        this.broken = true;
        return;
      }
      if (len - i >= n) {
        this.out(chunk.slice(i, i + n));
        i += n;
      } else {
        this.msg = new Uint8Array(n);
        this.msgN = 0;
      }
    }
  }
}

export const jsonOf = (msg: Uint8Array): Record<string, unknown> => {
  try {
    const v = JSON.parse(new TextDecoder().decode(msg.subarray(1)));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);

// a config message: its video's gen, the size and the avcC record
export const configOf = (msg: Uint8Array) => ({
  gen: u16(msg, 2),
  w: u16(msg, 4),
  h: u16(msg, 6),
  avcc: msg.subarray(8),
});
// a frame message: key, gen; the message itself is the viewer's, its first 8 bytes room
export const frameOf = (msg: Uint8Array) => ({ key: msg[1] === 1, gen: u16(msg, 2) });

// a cursor message: the pointer's shape as a PNG with its hotspot, none when hidden
export const cursorOf = (msg: Uint8Array) => ({
  visible: msg[1] === 1,
  x: u16(msg, 2),
  y: u16(msg, 4),
  w: u16(msg, 6),
  h: u16(msg, 8),
  png: msg.subarray(10),
});

export type Ready = { version: string; virtual_display: boolean; hostname: string; running: boolean; proto?: number };

export type LinkEvents = {
  message(msg: Uint8Array): void;
  closed(why: string): void;
};

// where afterglow listens and what it wants said first, as phosphorus wrote it
export type LinkAddr = { port: number; token: string; host?: string };

// a byte stream to an afterglow some other way: `afterglow --stdio` run over ssh, say.
// Its writes are whole messages, in order; what comes back is the link's bytes however cut
export interface Transport {
  write(b: Uint8Array): void;
  onData(f: (b: Uint8Array) => void): void;
  onClose(f: () => void): void;
  close(): void;
}

// one connection: open, the token said, afterglow's ready answer back
export class Link {
  private sock?: Awaited<ReturnType<typeof Bun.connect>>;
  private pipe?: Transport;
  private queue: Uint8Array[] = [];
  private closed = false;
  private waiting = new Map<number, ((m: Uint8Array) => void)[]>();
  // what each wait does when the link closes first: fail at once, not at its timeout
  private failers = new Set<(e: Error) => void>();
  ready?: Ready;

  constructor(
    private addr: LinkAddr | Transport,
    private ev: LinkEvents,
  ) {}

  async open(timeoutMs = 3000): Promise<Ready> {
    const reader = new LinkReader((m) => this.got(m));
    if (!("port" in this.addr)) {
      // a stream already let in by whatever carries it: the hello says nothing
      const p = this.addr;
      this.pipe = p;
      p.onData((d) => {
        reader.feed(d);
        if (reader.broken) this.close("afterglow sent a message past the limit");
      });
      p.onClose(() => this.close("afterglow closed the link"));
      const r = this.next(Out.ready, timeoutMs);
      this.send(In.hello, "");
      return this.agreed(jsonOf(await r) as unknown as Ready);
    }
    const addr = this.addr;
    this.sock = await Bun.connect({
      hostname: addr.host ?? "127.0.0.1",
      port: addr.port,
      socket: {
        data: (_s, d) => {
          reader.feed(d);
          if (reader.broken) this.close("afterglow sent a message past the limit");
        },
        drain: () => this.flush(),
        close: () => this.close("afterglow closed the link"),
        error: (_s, e) => this.close(`the link failed: ${e?.message ?? e}`),
      },
    });
    this.sock.setNoDelay(true);
    const r = this.next(Out.ready, timeoutMs);
    this.send(In.hello, addr.token);
    return this.agreed(jsonOf(await r) as unknown as Ready);
  }

  // ready kept when afterglow speaks a protocol this client does, else the link closed
  private agreed(r: Ready): Ready {
    const n = protoOf(r.proto);
    if (!protoOK(n)) {
      const why = protoWhy(n, r.version);
      this.close(why);
      throw new Error(why);
    }
    this.ready = r;
    return r;
  }

  // the next message of this type, or an error past the time
  next(type: number, timeoutMs: number): Promise<Uint8Array> {
    return new Promise((res, rej) => {
      if (this.closed) return rej(new Error("afterglow closed the link"));
      const fail = (e: Error) => {
        clearTimeout(t);
        const l = this.waiting.get(type) ?? [];
        this.waiting.set(
          type,
          l.filter((f) => f !== done),
        );
        this.failers.delete(fail);
        rej(e);
      };
      const t = setTimeout(() => fail(new Error("afterglow didn't answer")), timeoutMs);
      const done = (m: Uint8Array) => {
        clearTimeout(t);
        this.failers.delete(fail);
        res(m);
      };
      this.failers.add(fail);
      const l = this.waiting.get(type) ?? [];
      l.push(done);
      this.waiting.set(type, l);
    });
  }

  private got(m: Uint8Array) {
    const l = this.waiting.get(m[0]!);
    const f = l?.shift();
    if (f) return f(m);
    this.ev.message(m);
  }

  send(type: number, body?: Uint8Array | string) {
    if (this.closed) return;
    const m = message(type, body);
    if (this.pipe) return this.pipe.write(m);
    if (this.queue.length) {
      this.queue.push(m);
      return;
    }
    const n = this.sock?.write(m) ?? 0;
    if (n < m.length) this.queue.push(m.subarray(n));
  }

  json(type: number, v: unknown) {
    this.send(type, JSON.stringify(v));
  }

  private flush() {
    while (this.queue.length && this.sock) {
      const m = this.queue[0]!;
      const n = this.sock.write(m);
      if (n < m.length) {
        this.queue[0] = m.subarray(n);
        return;
      }
      this.queue.shift();
    }
  }

  get alive() {
    return !this.closed;
  }

  close(why = "closed") {
    if (this.closed) return;
    this.closed = true;
    this.sock?.end();
    this.pipe?.close();
    for (const f of [...this.failers]) f(new Error(`afterglow closed the link: ${why}`));
    this.ev.closed(why);
  }
}
