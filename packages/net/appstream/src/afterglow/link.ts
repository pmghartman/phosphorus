// the local link to afterglow, phosphorus's fork of Apollo (native/afterglow): one
// loopback TCP connection in place of GameStream's HTTPS, RTSP, ENet and RTP. A
// message is a u32 little-endian length of what follows, a type byte, the body
// (native/afterglow/src/phos_wire.h is the other side). Frames come already shaped
// for the viewer: 8 bytes of room for its header, then AVCC, so each is copied once,
// out of the socket's bytes into its own message

export const In = {
  hello: 0x01,
  launch: 0x02,
  video: 0x03,
  stopVideo: 0x04,
  idr: 0x05,
  input: 0x06,
  quit: 0x07,
  ping: 0x08,
} as const;

export const Out = {
  ready: 0x81,
  launched: 0x82,
  exited: 0x83,
  videoEnded: 0x84,
  pong: 0x88,
  config: 0x90,
  frame: 0x91,
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
// type byte and body as one fresh array, so a frame can be handed on as it is
export class LinkReader {
  private buf = new Uint8Array(1 << 20);
  private start = 0;
  private end = 0;
  broken = false;

  constructor(private out: (msg: Uint8Array) => void) {}

  feed(chunk: Uint8Array) {
    if (this.broken) return;
    this.room(chunk.length);
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
    for (;;) {
      const have = this.end - this.start;
      if (have < 4) break;
      const n = new DataView(this.buf.buffer, this.start, 4).getUint32(0, true);
      if (n < 1 || n > maxLen) {
        this.broken = true;
        return;
      }
      if (have < 4 + n) {
        this.room(4 + n - have);
        break;
      }
      const msg = this.buf.slice(this.start + 4, this.start + 4 + n);
      this.start += 4 + n;
      this.out(msg);
    }
    if (this.start === this.end) this.start = this.end = 0;
  }

  // room for n more bytes after what's held, the held moved to the front first
  private room(n: number) {
    if (this.end + n <= this.buf.length) return;
    const held = this.end - this.start;
    if (held + n > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, held + n));
      next.set(this.buf.subarray(this.start, this.end));
      this.buf = next;
    } else this.buf.copyWithin(0, this.start, this.end);
    this.start = 0;
    this.end = held;
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

export type Ready = { version: string; virtual_display: boolean; hostname: string; running: boolean };

export type LinkEvents = {
  message(msg: Uint8Array): void;
  closed(why: string): void;
};

// where afterglow listens and what it wants said first, as phosphorus wrote it
export type LinkAddr = { port: number; token: string; host?: string };

// one connection: open, the token said, afterglow's ready answer back
export class Link {
  private sock?: Awaited<ReturnType<typeof Bun.connect>>;
  private queue: Uint8Array[] = [];
  private closed = false;
  private waiting = new Map<number, ((m: Uint8Array) => void)[]>();
  ready?: Ready;

  constructor(
    private addr: LinkAddr,
    private ev: LinkEvents,
  ) {}

  async open(timeoutMs = 3000): Promise<Ready> {
    const reader = new LinkReader((m) => this.got(m));
    this.sock = await Bun.connect({
      hostname: this.addr.host ?? "127.0.0.1",
      port: this.addr.port,
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
    this.send(In.hello, this.addr.token);
    this.ready = jsonOf(await r) as unknown as Ready;
    return this.ready;
  }

  // the next message of this type, or an error past the time
  next(type: number, timeoutMs: number): Promise<Uint8Array> {
    return new Promise((res, rej) => {
      const t = setTimeout(() => {
        const l = this.waiting.get(type) ?? [];
        this.waiting.set(
          type,
          l.filter((f) => f !== done),
        );
        rej(new Error(this.closed ? "afterglow closed the link" : "afterglow didn't answer"));
      }, timeoutMs);
      const done = (m: Uint8Array) => {
        clearTimeout(t);
        res(m);
      };
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
    this.ev.closed(why);
  }
}
