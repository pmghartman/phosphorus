// the link's frames as the server sees them: length prefixed on the wire, a head (op, the
// window, an id) the server routes by, values in the codec the app and the page share

import codecSrc from "./inject/codec.js" with { type: "text" };
import opsSrc from "./inject/ops.js" with { type: "text" };

export type Codec = {
  Head: number;
  frame(op: number, wc: number, id: number, v?: unknown): Uint8Array;
  head(b: Uint8Array): { op: number; wc: number; id: number };
  body(b: Uint8Array): any;
  raw(op: number, wc: number, id: number, bytes: Uint8Array): Uint8Array;
  encode(v: unknown): Uint8Array;
  decode(b: Uint8Array): any;
};

export const codecText = codecSrc;
export const opsText = opsSrc;

export const ops: Record<string, number> = new Function(`${opsSrc}\nreturn phosOps;`)();
export const codec: Codec = new Function(`${codecSrc}\nreturn phosCodec(true);`)();

export const Op = {
  hello: ops.hello!,
  send: ops.send!,
  invoke: ops.invoke!,
  sync: ops.sync!,
  post: ops.post!,
  wev: ops.wev!,
  fetch: ops.fetch!,
  port: ops.port!,
  portClose: ops.portClose!,
  reply: ops.reply!,
  resHead: ops.resHead!,
  resBody: ops.resBody!,
  resEnd: ops.resEnd!,
  ready: ops.ready!,
  win: ops.win!,
  load: ops.load!,
  call: ops.call!,
  msg: ops.msg!,
  gone: ops.gone!,
  ask: ops.ask!,
  tell: ops.tell!,
} as const;

// the frames a page may send its app
export const fromPage = new Set<number>([
  Op.send,
  Op.invoke,
  Op.sync,
  Op.post,
  Op.wev,
  Op.port,
  Op.portClose,
  Op.reply,
]);

const maxFrame = 64 << 20;

// frames cut from a byte stream as they complete; whole runs handed on with each
export class Reader {
  private buf = new Uint8Array(0);
  constructor(private onFrame: (f: Uint8Array, wire: Uint8Array) => void) {}

  push(chunk: Uint8Array): void {
    let b: Uint8Array;
    if (this.buf.length) {
      b = new Uint8Array(this.buf.length + chunk.length);
      b.set(this.buf);
      b.set(chunk, this.buf.length);
    } else b = chunk;
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let at = 0;
    while (b.length - at >= 4) {
      const len = d.getUint32(at, true);
      if (len > maxFrame) throw new Error(`a frame of ${len} bytes`);
      if (b.length - at - 4 < len) break;
      this.onFrame(b.subarray(at + 4, at + 4 + len), b.subarray(at, at + 4 + len));
      at += 4 + len;
    }
    this.buf = at === b.length ? new Uint8Array(0) : b.slice(at);
  }
}

// one frame as it goes on the wire
export function wire(f: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + f.length);
  new DataView(out.buffer).setUint32(0, f.length, true);
  out.set(f, 4);
  return out;
}

export const headOf = (f: Uint8Array) => {
  const d = new DataView(f.buffer, f.byteOffset, f.byteLength);
  return { op: f[0]!, wc: d.getUint32(1, true), id: d.getUint32(5, true) };
};
