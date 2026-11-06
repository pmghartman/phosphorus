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
  // the desktop (afterglow's docs/protocol.md, "The desktop"): JSON {all, id}, answered by
  // Out.processes
  processes: 0x0c,
  // JSON {pid, started, shell, name, w, h, fps, ...}: a running process taken as the app,
  // answered by Out.launched
  attach: 0x0d,
  // JSON {pid, started, kill, shell, wait_ms, id}: answered by Out.ended
  end: 0x0e,
  // JSON {path, permanent, id}: answered by Out.deleted
  delete: 0x0f,
} as const;

export const Out = {
  ready: 0x81,
  launched: 0x82,
  exited: 0x83,
  videoEnded: 0x84,
  // JSON {t: "title" | "windows" | "clip", ...}
  note: 0x85,
  // JSON {ok, id, list} or {ok: false, id, error}
  processes: 0x86,
  // JSON {ok, id, pid, how, gone} or {ok: false, id, pid, error}
  ended: 0x87,
  pong: 0x88,
  // JSON {ok, id, path, recycled} or {ok: false, id, path, error}
  deleted: 0x89,
  config: 0x90,
  frame: 0x91,
  cursor: 0x92,
  // pixels: [pad][u16 gen][u16 w][u16 h]
  size: 0x93,
  // pixels: [u8 flags][u16 gen][u32 seq][u16 x][u16 y][u16 w][u16 h] then the pixels
  rect: 0x94,
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

// a size message: the pixels' view
export const sizeOf = (msg: Uint8Array) => ({ gen: u16(msg, 2), w: u16(msg, 4), h: u16(msg, 6) });
// a rect message: one rectangle of the view, its pixels after the header
export const rectOf = (msg: Uint8Array) => ({
  deflated: (msg[1]! & 1) === 1,
  msbFirst: (msg[1]! & 2) === 2,
  gen: u16(msg, 2),
  x: u16(msg, 8),
  y: u16(msg, 10),
  w: u16(msg, 12),
  h: u16(msg, 14),
  data: msg.subarray(16),
});

// a cursor message: the pointer's shape as a PNG with its hotspot, none when hidden
export const cursorOf = (msg: Uint8Array) => ({
  visible: msg[1] === 1,
  x: u16(msg, 2),
  y: u16(msg, 4),
  w: u16(msg, 6),
  h: u16(msg, 8),
  png: msg.subarray(10),
});

export type Ready = {
  version: string;
  proto?: number;
  virtual_display: boolean;
  hostname: string;
  running: boolean;
  // what the host's desktop can be asked: some of "processes", "attach", "delete"
  features?: string[];
};

// one of the host user's processes: with the pid, `started` (ms since the epoch) says
// which process it is, for an end or attach that mustn't reach another by that pid
export type Proc = {
  pid: number;
  ppid: number;
  exe: string;
  name: string;
  started: number;
  // its windows, topmost first: [id, title]
  windows: [number, string][];
};

export type EndOpts = {
  // killed at once, rather than its windows asked to close
  kill?: boolean;
  // the desktop shell (explorer.exe, gnome-shell) may be ended too
  shell?: boolean;
  // from the process list: refused if the pid is another process by now
  started?: number;
  // how long the host waits for it to go (default 5 s, 2 s for a kill; at most 30 s)
  waitMs?: number;
};

// "closed": its windows asked; "terminated": asked to end (Linux, no window);
// "killed". gone: whether it had gone by the end of the wait
export type Ended = { how: "closed" | "terminated" | "killed"; gone: boolean };

// the replies matched to their asks by id
const replies = new Set<number>([Out.processes, Out.ended, Out.deleted]);

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
  // the desktop's asks waiting for their replies, by id
  private asks = new Map<number, (j: Record<string, unknown>) => void>();
  private ids = 0;
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
    if (replies.has(m[0]!)) {
      const j = jsonOf(m);
      const f = typeof j.id === "number" ? this.asks.get(j.id) : undefined;
      if (f) {
        this.asks.delete(j.id as number);
        return f(j);
      }
    }
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

  // one of the desktop's asks, its reply matched by id; an error thrown with the
  // host's reason when it says no
  private ask(type: number, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    return new Promise((res, rej) => {
      if (this.closed) return rej(new Error("afterglow closed the link"));
      const id = ++this.ids;
      const fail = (e: Error) => {
        clearTimeout(t);
        this.asks.delete(id);
        this.failers.delete(fail);
        rej(e);
      };
      const t = setTimeout(() => fail(new Error("afterglow didn't answer")), timeoutMs);
      this.failers.add(fail);
      this.asks.set(id, (j) => {
        clearTimeout(t);
        this.failers.delete(fail);
        if (j.ok === true) res(j);
        else rej(new Error(String(j.error ?? "afterglow refused it")));
      });
      this.json(type, { ...body, id });
    });
  }

  // the host user's processes: those with windows first, topmost first; with all, the
  // rest too. Needs "processes" in ready.features
  async processes(all = false, timeoutMs = 15_000): Promise<Proc[]> {
    const j = await this.ask(In.processes, { all }, timeoutMs);
    return Array.isArray(j.list) ? (j.list as Proc[]) : [];
  }

  // one of them asked to close as its close buttons would, or killed with o.kill
  async end(pid: number, o: EndOpts = {}): Promise<Ended> {
    const waitMs = o.waitMs ?? (o.kill ? 2000 : 5000);
    const j = await this.ask(
      In.end,
      {
        pid,
        kill: !!o.kill,
        shell: !!o.shell,
        wait_ms: waitMs,
        ...(o.started !== undefined ? { started: o.started } : {}),
      },
      waitMs + 15_000,
    );
    return { how: j.how as Ended["how"], gone: j.gone === true };
  }

  // a file or folder within the user's folders deleted: to the Recycle Bin (Linux: the
  // trash) unless permanent. Needs "delete" in ready.features
  async delete(path: string, permanent = false, timeoutMs = 150_000): Promise<{ recycled: boolean }> {
    const j = await this.ask(In.delete, { path, permanent }, timeoutMs);
    return { recycled: j.recycled === true };
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
