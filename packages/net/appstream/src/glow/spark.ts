// spark: glow's control stream to the host, over ENet. Every message sealed with
// AES-128-GCM under the key handed over at launch; input packed as GameStream's
// input packets (a big-endian size, a little-endian magic, then the event), each
// kind on its own channel so a held key never waits behind a mouse move

import { createCipheriv, createDecipheriv } from "node:crypto";
import { EnetPeer } from "./enet.ts";

export const Msg = {
  encrypted: 0x0001,
  termination: 0x0109,
  periodicPing: 0x0200,
  lossStats: 0x0201,
  input: 0x0206,
  invalidateRefs: 0x0301,
  idr: 0x0302,
  startA: 0x0305,
  startB: 0x0307,
  hdr: 0x010e,
  rumble: 0x010b,
} as const;

export const Channel = { generic: 0, urgent: 1, keyboard: 2, mouse: 3, pen: 4, touch: 5, utf8: 6, count: 0x20 };

export const Magic = {
  keyDown: 0x03,
  keyUp: 0x04,
  mouseAbs: 0x05,
  mouseRel: 0x07,
  buttonDown: 0x08,
  buttonUp: 0x09,
  scroll: 0x0a,
  utf8: 0x17,
  hscroll: 0x55000001,
} as const;

export const Mod = { shift: 0x01, ctrl: 0x02, alt: 0x04, meta: 0x08 };

// sealed control packets: the header, the sequence number, the tag, the cipher text.
// v2 hosts take a 12-byte IV, the sequence number then a marker of who sent it
export class Sealer {
  private seq = 0;
  constructor(
    private key: Uint8Array,
    private v2: boolean,
  ) {}

  iv(seq: number, fromHost: boolean): Uint8Array {
    const iv = new Uint8Array(this.v2 ? 12 : 16);
    new DataView(iv.buffer).setUint32(0, seq, true);
    if (this.v2) {
      iv[10] = fromHost ? 0x48 : 0x43; // 'H' or 'C'
      iv[11] = 0x43; // 'C': control
    }
    return iv;
  }

  seal(type: number, payload: Uint8Array): Uint8Array {
    const plain = new Uint8Array(4 + payload.length);
    const pv = new DataView(plain.buffer);
    pv.setUint16(0, type, true);
    pv.setUint16(2, payload.length, true);
    plain.set(payload, 4);
    const seq = this.seq++;
    const c = createCipheriv("aes-128-gcm", this.key, this.iv(seq, false));
    const ct = c.update(plain);
    c.final();
    const tag = c.getAuthTag();
    const out = new Uint8Array(8 + 16 + ct.length);
    const v = new DataView(out.buffer);
    v.setUint16(0, Msg.encrypted, true);
    v.setUint16(2, 4 + 16 + ct.length, true);
    v.setUint32(4, seq, true);
    out.set(tag, 8);
    out.set(ct, 24);
    return out;
  }

  // a host's packet opened: its type and payload, undefined when it isn't sealed right
  open(p: Uint8Array): { type: number; payload: Uint8Array } | undefined {
    if (p.length < 4) return;
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const t = v.getUint16(0, true);
    if (t !== Msg.encrypted) return { type: t, payload: p.subarray(4) };
    if (p.length < 24) return;
    const seq = v.getUint32(4, true);
    try {
      const d = createDecipheriv("aes-128-gcm", this.key, this.iv(seq, true));
      d.setAuthTag(p.subarray(8, 24));
      const plain = Buffer.concat([d.update(p.subarray(24, 4 + v.getUint16(2, true))), d.final()]);
      const pv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
      return { type: pv.getUint16(0, true), payload: new Uint8Array(plain.subarray(4)) };
    } catch {
      return;
    }
  }
}

// one input packet: size (big-endian, of everything after it), magic, the event
function input(magic: number, body: number): [Uint8Array, DataView] {
  const b = new Uint8Array(8 + body);
  const v = new DataView(b.buffer);
  v.setUint32(0, 4 + body, false);
  v.setUint32(4, magic, true);
  return [b, v];
}

export const pack = {
  mouseAbs(x: number, y: number, w: number, h: number) {
    const [b, v] = input(Magic.mouseAbs, 10);
    v.setInt16(8, x, false);
    v.setInt16(10, y, false);
    v.setInt16(12, 0, false);
    v.setInt16(14, w - 1, false);
    v.setInt16(16, h - 1, false);
    return b;
  },
  mouseRel(dx: number, dy: number) {
    const [b, v] = input(Magic.mouseRel, 4);
    v.setInt16(8, dx, false);
    v.setInt16(10, dy, false);
    return b;
  },
  button(down: boolean, button: number) {
    const [b] = input(down ? Magic.buttonDown : Magic.buttonUp, 1);
    b[8] = button;
    return b;
  },
  key(down: boolean, vk: number, mods: number, flags = 0) {
    const [b, v] = input(down ? Magic.keyDown : Magic.keyUp, 6);
    b[8] = flags;
    v.setUint16(9, (vk & 0xff) | 0x8000, true);
    b[11] = mods;
    v.setUint16(12, 0, true);
    return b;
  },
  // one notch is 120
  scroll(amount: number) {
    const [b, v] = input(Magic.scroll, 6);
    v.setInt16(8, amount, false);
    v.setInt16(10, amount, false);
    v.setInt16(12, 0, false);
    return b;
  },
  hscroll(amount: number) {
    const [b, v] = input(Magic.hscroll, 2);
    v.setInt16(8, amount, false);
    return b;
  },
  utf8(text: string) {
    const t = new TextEncoder().encode(text);
    const [b] = input(Magic.utf8, t.length);
    b.set(t, 8);
    return b;
  },
};

export type SparkEvents = {
  // the host ended the stream: its code, 0 when it just quit
  ended(why: string): void;
};

export class Spark {
  private enet: EnetPeer;
  private sealer: Sealer;
  private pingT?: ReturnType<typeof setInterval>;
  private pingSeq = 0;

  constructor(
    host: string,
    port: number,
    key: Uint8Array,
    v2: boolean,
    private ev: SparkEvents,
  ) {
    this.sealer = new Sealer(key, v2);
    this.enet = new EnetPeer(host, port, Channel.count, {
      data: (_ch, p) => this.fromHost(p),
      close: (why) => this.ev.ended(why),
    });
  }

  async open(connectData: number) {
    await this.enet.connect(connectData);
    this.send(Msg.startA, new Uint8Array([0, 0]));
    this.send(Msg.startB, new Uint8Array([0]));
    this.pingT = setInterval(() => {
      const p = new Uint8Array(8);
      new DataView(p.buffer).setUint32(4, ++this.pingSeq, true);
      p[0] = 4;
      this.send(Msg.periodicPing, p);
    }, 100);
  }

  get rtt() {
    return this.enet.rtt;
  }

  send(type: number, payload: Uint8Array, channel: number = Channel.generic) {
    this.enet.send(channel, this.sealer.seal(type, payload));
  }

  input(channel: number, pkt: Uint8Array) {
    this.send(Msg.input, pkt, channel);
  }

  // a fresh keyframe, without restarting the stream
  idr() {
    this.send(Msg.idr, new Uint8Array([0, 0]), Channel.urgent);
  }

  private fromHost(p: Uint8Array) {
    const m = this.sealer.open(p);
    if (!m) return;
    if (m.type === Msg.termination) {
      const v = new DataView(m.payload.buffer, m.payload.byteOffset, m.payload.byteLength);
      const code = m.payload.length >= 4 ? v.getUint32(0, false) : 0;
      // 0x80030023: the app quit, as a host says it
      this.ev.ended(
        code === 0x80030023 || code === 0 ? "the app quit" : `the host ended the stream (0x${code.toString(16)})`,
      );
    }
  }

  close() {
    clearInterval(this.pingT);
    this.enet.close("closed");
  }
}
