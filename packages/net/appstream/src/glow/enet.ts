// glow's ENet: the one peer of the reliable-UDP protocol GameStream's control stream
// runs on, from ENet's published wire format. Only what a client needs against one
// host on loopback: connect, reliable sends on a channel with resends until acked,
// acks of what the host sends reliably, pings, disconnect. No fragments out (control
// messages are small), no throttling, no bandwidth limits: on loopback nothing waits

const CmdAck = 1;
const CmdConnect = 2;
const CmdVerify = 3;
const CmdDisconnect = 4;
const CmdPing = 5;
const CmdReliable = 6;
const CmdUnreliable = 7;
const CmdFragment = 8;
const CmdUnsequenced = 9;
const FlagAck = 0x80;
const FlagUnseq = 0x40;
const HeaderSentTime = 0x8000;
const MaxPeerId = 0x0fff;

const cmdSize = [0, 8, 48, 44, 8, 4, 6, 8, 24, 8, 12, 16, 24];

export type EnetEvents = {
  data(channel: number, payload: Uint8Array): void;
  close(why: string): void;
};

type Pending = { seq: number; channel: number; bytes: Uint8Array; sentAt: number; tries: number };

export class EnetPeer {
  private sock?: Bun.udp.ConnectedSocket<"buffer">;
  private peerId = MaxPeerId;
  private outSession = 0;
  private connectId = (Math.random() * 0xffffffff) >>> 0;
  private outSeq = new Map<number, number>();
  private unseqGroup = 0;
  private pending = new Map<string, Pending>();
  private acks: Uint8Array[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private lastHeard = Date.now();
  private connected = false;
  private closed = false;
  private onVerify?: () => void;
  rtt = 0;

  constructor(
    private host: string,
    private port: number,
    private channels: number,
    private ev: EnetEvents,
  ) {}

  private now16 = () => Date.now() & 0xffff;

  async connect(data: number, timeoutMs = 5000): Promise<void> {
    this.sock = await Bun.udpSocket({
      binaryType: "buffer",
      connect: { hostname: this.host, port: this.port },
      socket: {
        data: (_s, buf) => this.onPacket(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)),
        error: (_s, e) => this.close(`control socket: ${e.message}`),
      },
    });
    const c = new Uint8Array(48);
    const v = new DataView(c.buffer);
    c[0] = CmdConnect | FlagAck;
    c[1] = 0xff;
    v.setUint16(2, this.nextSeq(0xff));
    v.setUint16(4, 0); // our peer id at the host's end of this link
    c[6] = 0xff; // incoming session: the host picks
    c[7] = 0xff;
    v.setUint32(8, 1392); // mtu
    v.setUint32(12, 32768); // window
    v.setUint32(16, this.channels);
    v.setUint32(20, 0);
    v.setUint32(24, 0);
    v.setUint32(28, 5000); // throttle interval
    v.setUint32(32, 2);
    v.setUint32(36, 2);
    v.setUint32(40, this.connectId);
    v.setUint32(44, data >>> 0);
    const verified = new Promise<void>((ok, no) => {
      const t = setTimeout(() => no(new Error("the host's control stream didn't answer")), timeoutMs);
      this.onVerify = () => {
        clearTimeout(t);
        ok();
      };
    });
    this.track(0xff, v.getUint16(2), c);
    this.flush([c]);
    this.timer = setInterval(() => this.tick(), 20);
    await verified;
  }

  private nextSeq(ch: number) {
    const n = ((this.outSeq.get(ch) ?? 0) + 1) & 0xffff;
    this.outSeq.set(ch, n);
    return n;
  }

  private track(ch: number, seq: number, bytes: Uint8Array) {
    this.pending.set(`${ch}:${seq}`, { seq, channel: ch, bytes, sentAt: Date.now(), tries: 1 });
  }

  // one datagram of commands, the header in front
  private flush(cmds: Uint8Array[]) {
    if (!this.sock || this.closed) return;
    let n = 4;
    for (const c of cmds) n += c.length;
    const p = new Uint8Array(n);
    const v = new DataView(p.buffer);
    v.setUint16(0, (this.connected ? this.peerId | (this.outSession << 12) : MaxPeerId) | HeaderSentTime);
    v.setUint16(2, this.now16());
    let o = 4;
    for (const c of cmds) {
      p.set(c, o);
      o += c.length;
    }
    this.sock.send(p);
  }

  // a payload on a channel, resent until the host acks it
  send(channel: number, payload: Uint8Array, reliable = true) {
    if (!this.connected || this.closed) return;
    if (!reliable) {
      const c = new Uint8Array(8 + payload.length);
      const v = new DataView(c.buffer);
      c[0] = CmdUnsequenced | FlagUnseq;
      c[1] = channel;
      v.setUint16(2, 0);
      this.unseqGroup = (this.unseqGroup + 1) & 0xffff;
      v.setUint16(4, this.unseqGroup);
      v.setUint16(6, payload.length);
      c.set(payload, 8);
      return this.flush([c]);
    }
    const c = new Uint8Array(6 + payload.length);
    const v = new DataView(c.buffer);
    c[0] = CmdReliable | FlagAck;
    c[1] = channel;
    const seq = this.nextSeq(channel);
    v.setUint16(2, seq);
    v.setUint16(4, payload.length);
    c.set(payload, 6);
    this.track(channel, seq, c);
    this.flush(this.acks.length ? [...this.acks.splice(0), c] : [c]);
  }

  private ack(ch: number, seq: number, sentTime: number) {
    const a = new Uint8Array(8);
    const v = new DataView(a.buffer);
    a[0] = CmdAck;
    a[1] = ch;
    v.setUint16(2, seq);
    v.setUint16(4, seq);
    v.setUint16(6, sentTime);
    this.acks.push(a);
  }

  private onPacket(p: Uint8Array) {
    if (p.length < 2) return;
    this.lastHeard = Date.now();
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const peer = v.getUint16(0);
    let o = 2;
    let sentTime = 0;
    if (peer & HeaderSentTime) {
      sentTime = v.getUint16(2);
      o = 4;
    }
    if (peer & 0x4000) return; // compressed: never asked for
    while (o + 4 <= p.length) {
      const cmd = p[o]! & 0x0f;
      const ackWanted = (p[o]! & FlagAck) !== 0;
      const ch = p[o + 1]!;
      const seq = v.getUint16(o + 2);
      const size = cmdSize[cmd] ?? 0;
      if (!size || o + size > p.length) break;
      let next = o + size;
      switch (cmd) {
        case CmdAck: {
          const got = v.getUint16(o + 4);
          const sent = v.getUint16(o + 6);
          this.rtt = (this.now16() - sent) & 0xffff;
          this.pending.delete(`${ch}:${got}`);
          break;
        }
        case CmdVerify: {
          this.peerId = v.getUint16(o + 4);
          this.outSession = p[o + 7]!;
          const cid = v.getUint32(o + 40);
          if (cid !== this.connectId) return;
          this.pending.delete(`255:1`);
          this.connected = true;
          this.onVerify?.();
          break;
        }
        case CmdDisconnect:
          if (ackWanted) this.ack(ch, seq, sentTime);
          this.flush(this.acks.splice(0));
          this.close("the host ended the control stream");
          return;
        case CmdPing:
          break;
        case CmdReliable: {
          const n = v.getUint16(o + 4);
          next = o + 6 + n;
          if (next > p.length) return;
          this.ev.data(ch, p.subarray(o + 6, next));
          break;
        }
        case CmdUnreliable:
        case CmdUnsequenced: {
          const n = v.getUint16(o + 6);
          next = o + 8 + n;
          if (next > p.length) return;
          this.ev.data(ch, p.subarray(o + 8, next));
          break;
        }
        case CmdFragment: {
          // the host's messages to us are small; a fragment is skipped whole
          next = o + 24 + v.getUint16(o + 6);
          break;
        }
      }
      if (ackWanted) this.ack(ch, seq, sentTime);
      o = next;
    }
    if (this.acks.length) this.flush(this.acks.splice(0));
  }

  private lastPing = 0;
  private tick() {
    const now = Date.now();
    if (now - this.lastHeard > 10_000) return this.close("the host's control stream went quiet");
    const resend: Uint8Array[] = [];
    for (const p of this.pending.values()) {
      // loopback: an unacked packet after 40ms was lost, not slow
      if (now - p.sentAt > 40 * p.tries) {
        p.tries++;
        p.sentAt = now;
        resend.push(p.bytes);
        if (p.tries > 30) return this.close("the host stopped acking the control stream");
      }
    }
    if (this.connected && now - this.lastPing > 500) {
      this.lastPing = now;
      const c = new Uint8Array(4);
      const v = new DataView(c.buffer);
      c[0] = CmdPing | FlagAck;
      c[1] = 0xff;
      const seq = this.nextSeq(0xff);
      v.setUint16(2, seq);
      this.track(0xff, seq, c);
      resend.push(c);
    }
    if (resend.length || this.acks.length) this.flush([...this.acks.splice(0), ...resend]);
  }

  close(why = "closed") {
    if (this.closed) return;
    if (this.connected) {
      const c = new Uint8Array(8);
      const v = new DataView(c.buffer);
      c[0] = CmdDisconnect | FlagUnseq;
      c[1] = 0xff;
      v.setUint32(4, 0);
      this.flush([c]);
    }
    this.closed = true;
    this.connected = false;
    clearInterval(this.timer);
    this.sock?.close();
    this.ev.close(why);
  }

  get open() {
    return this.connected && !this.closed;
  }
}
