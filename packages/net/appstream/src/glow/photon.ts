// photon: glow's video stream. The host's RTP datagrams put back into whole frames
// and handed on the moment a frame's last data packet lands: no jitter buffer, no
// waiting on parity (on loopback nothing is lost, so FEC is never needed; a frame
// that does lose a packet is dropped and a keyframe asked for over the control
// stream, not repaired). Each frame leaves as the viewer's message: 8 bytes kept
// in front for its header, then AVCC (length-prefixed NAL units), built in place
// over the host's own frame header when it can be, so a P-frame is copied once

import dgram from "node:dgram";

// the datagram: 12 bytes of RTP, 4 more, then the 16 of the video packet header
export const RtpLen = 16;
export const NvLen = 16;
export const PktHead = RtpLen + NvLen;
// what the host puts in front of a frame's data, in its first packet
export const FrameHeadLen = 8;

const FlagSOF = 0x4;

export type Nal = { type: number; start: number; end: number };

// the NAL units of an Annex B stream: where each one's bytes start (after its start
// code) and end. Start codes are found with the native indexOf, not a JS loop
const sc3 = Buffer.from([0, 0, 1]);
export function nalsOf(b: Uint8Array, from = 0, to = b.length): Nal[] {
  const buf = Buffer.from(b.buffer, b.byteOffset, to);
  const out: Nal[] = [];
  let i = buf.indexOf(sc3, from);
  while (i >= 0 && i + 3 <= to) {
    const start = i + 3;
    let next = buf.indexOf(sc3, start);
    if (next < 0 || next + 3 > to) next = -1;
    let end = next < 0 ? to : next;
    // a 4-byte start code's leading zero belongs to it, not the NAL before
    if (next >= 0 && end > start && b[end - 1] === 0) end--;
    // trailing zero padding isn't the NAL's
    if (next < 0) while (end > start && b[end - 1] === 0) end--;
    if (end > start) out.push({ type: b[start]! & 0x1f, start, end });
    i = next;
  }
  return out;
}

// an avcC record from one SPS and one PPS: what VideoDecoder takes as description
export function avccOf(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(11 + sps.length + pps.length);
  out[0] = 1;
  out[1] = sps[1]!;
  out[2] = sps[2]!;
  out[3] = sps[3]!;
  out[4] = 0xff;
  out[5] = 0xe1;
  out[6] = sps.length >> 8;
  out[7] = sps.length & 0xff;
  out.set(sps, 8);
  let o = 8 + sps.length;
  out[o++] = 1;
  out[o++] = pps.length >> 8;
  out[o++] = pps.length & 0xff;
  out.set(pps, o);
  return out;
}

export type PhotonOut = {
  // new parameter sets: the decoder configured again
  config(avcc: Uint8Array): void;
  // one frame: msg[0..8) free for the header, AVCC after
  frame(msg: Uint8Array, key: boolean, index: number, hostMs: number): void;
  // a frame lost a packet: ask the host for a keyframe
  lost(index: number): void;
};

type Block = { buf: Uint8Array; data: number; got: number };

// datagrams in, frames out. shardLen: one packet's payload (packetSize - NvLen)
export class Depacketizer {
  private index = -1;
  private blocks: (Block | undefined)[] = [];
  private lastBlock = 0;
  private done = false;
  private lastPayload = 0;
  private hostMs = 0;
  private sps?: Uint8Array;
  private pps?: Uint8Array;
  frames = 0;
  dropped = 0;

  constructor(
    private shardLen: number,
    private out: PhotonOut,
  ) {}

  push(p: Uint8Array) {
    if (p.length < PktHead) return;
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const index = v.getUint32(RtpLen + 4, true);
    const flags = p[RtpLen + 8]!;
    const mfb = p[RtpLen + 11]!;
    const fec = v.getUint32(RtpLen + 12, true);
    const shard = (fec >>> 12) & 0x3ff;
    const data = fec >>> 22;
    // parity: never needed on loopback
    if (shard >= data) return;
    if (index !== this.index) {
      // a newer frame: the one before it, if not whole, is gone
      if ((index - this.index) | 0) {
        if (((index - this.index) | 0) < 0) return;
        if (this.index >= 0 && !this.done) {
          this.dropped++;
          this.out.lost(this.index);
        }
      }
      this.index = index;
      this.blocks = [];
      this.done = false;
      this.lastPayload = 0;
    }
    if (this.done) return;
    const blk = (mfb >> 4) & 3;
    this.lastBlock = (mfb >> 6) & 3;
    let b = this.blocks[blk];
    if (!b) {
      b = { buf: new Uint8Array(data * this.shardLen), data, got: 0 };
      this.blocks[blk] = b;
    }
    const payload = p.subarray(PktHead);
    if (blk === 0 && shard === 0 && flags & FlagSOF) {
      const fv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      this.hostMs = fv.getUint16(1, true) / 10;
      this.lastPayload = fv.getUint16(4, true);
    }
    b.buf.set(payload.subarray(0, Math.min(payload.length, this.shardLen)), shard * this.shardLen);
    b.got++;
    if (b.got < b.data) return;
    for (let i = 0; i <= this.lastBlock; i++) {
      const x = this.blocks[i];
      if (!x || x.got < x.data) return;
    }
    this.done = true;
    this.emit();
  }

  private emit() {
    const blocks = this.blocks as Block[];
    let frame: Uint8Array;
    if (blocks.length === 1) frame = blocks[0]!.buf;
    else {
      frame = new Uint8Array(blocks.reduce((n, b) => n + b.buf.length, 0));
      let o = 0;
      for (const b of blocks) {
        frame.set(b.buf, o);
        o += b.buf.length;
      }
    }
    // the last packet's real length: what's past it is padding
    let end = frame.length;
    if (this.lastPayload > 0 && this.lastPayload <= this.shardLen)
      end = frame.length - this.shardLen + this.lastPayload;
    const nals = nalsOf(frame, FrameHeadLen, end);
    if (!nals.length) return;
    let key = false;
    let inPlace = nals[0]!.start - FrameHeadLen === 4;
    let size = 0;
    for (let i = 0; i < nals.length; i++) {
      const n = nals[i]!;
      if (n.type === 7) this.sps = frame.slice(n.start, n.end);
      else if (n.type === 8) this.pps = frame.slice(n.start, n.end);
      if (n.type === 5) key = true;
      if (n.type === 7 || n.type === 8 || n.type === 9) {
        inPlace = false;
        continue;
      }
      // each NAL must sit right after a 4-byte start code that follows the one before
      if (i > 0 && n.start - nals[i - 1]!.end !== 4) inPlace = false;
      size += 4 + n.end - n.start;
    }
    if (key && this.sps && this.pps) this.out.config(avccOf(this.sps, this.pps));
    this.frames++;
    if (inPlace) {
      // the host's frame header becomes ours, each start code a length
      const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      for (const n of nals) v.setUint32(n.start - 4, n.end - n.start);
      this.out.frame(frame.subarray(0, 8 + size), key, this.index, this.hostMs);
      return;
    }
    const msg = new Uint8Array(8 + size);
    const mv = new DataView(msg.buffer);
    let o = 8;
    for (const n of nals) {
      if (n.type === 7 || n.type === 8 || n.type === 9) continue;
      mv.setUint32(o, n.end - n.start);
      msg.set(frame.subarray(n.start, n.end), o + 4);
      o += 4 + n.end - n.start;
    }
    this.out.frame(msg, key, this.index, this.hostMs);
  }
}

type Udp = dgram.Socket & { on(ev: string, fn: (...a: any[]) => void): Udp };

// the socket: pinged at the host's video port (and its audio one, so the host can
// tear the stream down at once when it ends) until it stops; datagrams into the
// depacketizer straight from the receive callback
export class Photon {
  private sock?: Udp;
  private audio?: Udp;
  private pingT?: ReturnType<typeof setInterval>;
  private seq = 0;
  readonly dp: Depacketizer;
  lastPacket = 0;

  constructor(
    private host: string,
    private videoPort: number,
    private audioPort: number,
    private ping: Uint8Array | undefined,
    packetSize: number,
    out: PhotonOut,
  ) {
    this.dp = new Depacketizer(packetSize - NvLen, out);
  }

  async open() {
    // a large receive buffer: an IDR's burst lands whole even when the event loop is busy
    const sock = dgram.createSocket({ type: "udp4", recvBufferSize: 16 << 20 }) as Udp;
    const audio = dgram.createSocket({ type: "udp4" }) as Udp;
    sock.on("message", (m: Buffer) => {
      this.lastPacket = Date.now();
      this.dp.push(m);
    });
    audio.on("message", () => {});
    sock.on("error", () => {});
    audio.on("error", () => {});
    // on the loopback only, never a port open to the network, when the host is here
    const at = /^127\./.test(this.host) ? "127.0.0.1" : undefined;
    await new Promise<void>((ok) => sock.bind(0, at, () => ok()));
    await new Promise<void>((ok) => audio.bind(0, at, () => ok()));
    this.sock = sock;
    this.audio = audio;
    const send = () => {
      const p = new Uint8Array((this.ping?.length ?? 4) + 4);
      if (this.ping) p.set(this.ping);
      else p.set([0x50, 0x49, 0x4e, 0x47]); // PING
      new DataView(p.buffer).setUint32(p.length - 4, ++this.seq, false);
      sock.send(p, this.videoPort, this.host);
      audio.send(p, this.audioPort, this.host);
    };
    send();
    this.pingT = setInterval(send, 500);
  }

  close() {
    clearInterval(this.pingT);
    try {
      this.sock?.close();
    } catch {}
    try {
      this.audio?.close();
    } catch {}
  }
}
