// a WireGuard device: peers by key, their sessions and timers, packets routed
// by allowed IPs; a hub forwards between its own peers
import { addrs, contains, ipLength, type Prefix, prefix, v4 } from "./ip.ts";
import {
  after,
  dataHead,
  dataMessage,
  initiation,
  type Keys,
  MsgCookie,
  MsgData,
  MsgInit,
  MsgResp,
  mac1OK,
  openCookie,
  openData,
  type Pending,
  readInitiation,
  readResponse,
  response,
  stampMacs,
} from "./noise.ts";
import { Replay } from "./replay.ts";
import { b64, Static, unb64 } from "./x25519.ts";

export const RekeyAfterTime = 120_000;
export const RejectAfterTime = 180_000;
export const RekeyAttemptTime = 90_000;
export const RekeyTimeout = 5_000;
export const KeepaliveTimeout = 10_000;
const RekeyAfterMessages = 2 ** 52;
const RejectAfterMessages = 2 ** 53 - 2 ** 13;
const CookieLife = 120_000;
const QueueMax = 64;

// where a peer is reached: an address and port, as the transport takes it
export type Endpoint = string;

export type PeerConfig = {
  // base64 public key
  key: string;
  allowed: string[];
  // where to send; several: tried in turn until one answers
  endpoints?: Endpoint[];
  // seconds between keepalives, 0 for none
  keepalive?: number;
  // used only while a session is up, else the next prefix match carries the packet
  direct?: boolean;
};

export type DeviceOptions = {
  key: Uint8Array;
  // this device's own address: packets to it are delivered, never forwarded
  address?: string;
  send: (msg: Uint8Array, to: Endpoint) => void;
  deliver: (pkt: Uint8Array) => void;
  // forward packets between peers, as the mesh's hub
  hub?: boolean;
  now?: () => number;
};

class Session {
  sent = 0;
  replay = new Replay();
  // a responder's session, unusable for sending until the initiator's first data
  confirmed: boolean;
  constructor(
    readonly keys: Keys,
    readonly at: number,
  ) {
    this.confirmed = keys.initiator;
  }
}

export class Peer {
  readonly pub: Uint8Array;
  allowed: Prefix[] = [];
  endpoints: Endpoint[] = [];
  endpoint?: Endpoint;
  keepalive = 0;
  direct = false;
  current?: Session;
  previous?: Session;
  next?: Session;
  pending?: Pending & { at: number; mac1: Uint8Array };
  // the first attempt of the current run of handshakes, 0 when none
  tryingSince = 0;
  cookie?: { value: Uint8Array; at: number };
  lastTs = new Uint8Array(12);
  lastSent = 0;
  lastRecv = 0;
  lastData = 0;
  lastHandshake = 0;
  tryIndex = 0;
  queue: Uint8Array[] = [];
  rx = 0;
  tx = 0;

  constructor(readonly key: string) {
    const k = unb64(key);
    if (!k) throw new Error(`bad peer key ${key}`);
    this.pub = k;
  }

  // a session to send on: current, confirmed and within its life
  usable(now: number): Session | undefined {
    const s = this.current;
    if (s?.confirmed && now - s.at < RejectAfterTime && s.sent < RejectAfterMessages) return s;
    return undefined;
  }
}

export class Device {
  readonly self: Static;
  readonly peers = new Map<string, Peer>();
  private byIndex = new Map<number, { peer: Peer; session?: Session }>();
  private address?: number;
  private now: () => number;

  constructor(private o: DeviceOptions) {
    this.self = new Static(o.key);
    this.now = o.now ?? Date.now;
    if (o.address) this.address = v4(o.address);
  }

  get publicKey() {
    return b64(this.self.pub);
  }

  // the peers made to match the list; sessions kept for keys still in it
  setPeers(list: PeerConfig[]) {
    const want = new Map(list.map((c) => [c.key, c]));
    for (const [k, p] of this.peers)
      if (!want.has(k)) {
        this.drop(p);
        this.peers.delete(k);
      }
    for (const c of list) {
      let p = this.peers.get(c.key);
      if (!p) {
        p = new Peer(c.key);
        this.peers.set(c.key, p);
      }
      p.allowed = c.allowed.map(prefix).filter((x): x is Prefix => !!x);
      p.endpoints = c.endpoints ?? [];
      if (p.endpoint === undefined || !p.endpoints.includes(p.endpoint)) p.endpoint ??= p.endpoints[0];
      p.keepalive = (c.keepalive ?? 0) * 1000;
      p.direct = c.direct === true;
    }
  }

  private drop(p: Peer) {
    for (const [i, e] of this.byIndex) if (e.peer === p) this.byIndex.delete(i);
  }

  private newIndex(peer: Peer, session?: Session): number {
    for (;;) {
      const i = crypto.getRandomValues(new Uint32Array(1))[0]!;
      if (!this.byIndex.has(i)) {
        this.byIndex.set(i, { peer, session });
        return i;
      }
    }
  }

  private emit(p: Peer, msg: Uint8Array) {
    if (p.endpoint === undefined) return;
    p.lastSent = this.now();
    this.o.send(msg, p.endpoint);
  }

  // --- routing ----------------------------------------------------------------------

  // the peer for an address: the longest prefix among peers that can take it now
  route(dst: number): Peer | undefined {
    let best: Peer | undefined;
    let bits = -1;
    const t = this.now();
    for (const p of this.peers.values()) {
      if (p.direct && !p.usable(t)) continue;
      for (const a of p.allowed) if (a.bits > bits && contains(a, dst)) [best, bits] = [p, a.bits];
    }
    return best;
  }

  // a packet from the tunnel, out to its peer
  send(pkt: Uint8Array) {
    const a = addrs(pkt);
    if (!a) return;
    const p = this.route(a.dst);
    if (p) this.sendTo(p, pkt);
  }

  private sendTo(p: Peer, pkt: Uint8Array) {
    const t = this.now();
    const s = p.usable(t);
    if (!s) {
      if (p.queue.length >= QueueMax) p.queue.shift();
      p.queue.push(pkt);
      this.handshake(p, false);
      return;
    }
    this.emit(p, dataMessage(s.keys.send, s.keys.remote, s.sent++, pkt));
    p.tx += pkt.length;
    if (pkt.length) p.lastData = t;
    if (s.keys.initiator && (t - s.at > RekeyAfterTime || s.sent > RekeyAfterMessages)) this.handshake(p, false);
  }

  private flush(p: Peer) {
    const q = p.queue;
    p.queue = [];
    if (q.length) for (const pkt of q) this.sendTo(p, pkt);
    else {
      // the initiator confirms a new session at once
      const s = p.usable(this.now());
      if (s) this.emit(p, dataMessage(s.keys.send, s.keys.remote, s.sent++, new Uint8Array(0)));
    }
  }

  // --- handshakes ---------------------------------------------------------------------

  // an initiation to p, at most one per rekey timeout unless forced
  handshake(p: Peer, force: boolean) {
    const t = this.now();
    if (!force && p.pending && t - p.pending.at < RekeyTimeout) return;
    if (p.tryingSince && t - p.tryingSince > RekeyAttemptTime && !p.queue.length) return;
    if (!p.endpoints.length && p.endpoint === undefined) return;
    if (!p.tryingSince) p.tryingSince = t;
    // a direct peer with several candidates: the next one each try
    if (p.endpoints.length > 1 && !p.usable(t)) p.endpoint = p.endpoints[p.tryIndex++ % p.endpoints.length];
    if (p.pending) this.byIndex.delete(p.pending.local);
    const local = this.newIndex(p);
    const made = initiation(this.self, p.pub, local);
    if (!made) return;
    const cookie = p.cookie && t - p.cookie.at < CookieLife ? p.cookie.value : undefined;
    const m1 = stampMacs(made.msg, p.pub, cookie);
    p.pending = { ...made.pending, at: t, mac1: m1 };
    this.emit(p, made.msg);
  }

  // --- what arrives -------------------------------------------------------------------

  // a datagram from the transport
  receive(msg: Uint8Array, from: Endpoint) {
    if (msg.length < 4) return;
    switch (msg[0]) {
      case MsgInit:
        return this.onInit(msg, from);
      case MsgResp:
        return this.onResp(msg, from);
      case MsgCookie:
        return this.onCookie(msg);
      case MsgData:
        return this.onData(msg, from);
    }
  }

  private onInit(msg: Uint8Array, from: Endpoint) {
    if (!mac1OK(msg, this.self.pub)) return;
    const r = readInitiation(this.self, msg);
    if (!r) return;
    const p = this.peers.get(b64(r.peerPub));
    if (!p || !after(r.ts, p.lastTs)) return;
    p.lastTs = r.ts;
    const local = this.newIndex(p);
    const made = response(r, local);
    if (!made) return;
    const t = this.now();
    const s = new Session(made.keys, t);
    this.byIndex.set(local, { peer: p, session: s });
    if (p.next) this.byIndex.delete(p.next.keys.local);
    p.next = s;
    p.endpoint = from;
    p.lastRecv = t;
    stampMacs(made.msg, p.pub, p.cookie && t - p.cookie.at < CookieLife ? p.cookie.value : undefined);
    this.emit(p, made.msg);
  }

  private onResp(msg: Uint8Array, from: Endpoint) {
    if (!mac1OK(msg, this.self.pub)) return;
    const local = new DataView(msg.buffer, msg.byteOffset).getUint32(8, true);
    const e = this.byIndex.get(local);
    const p = e?.peer;
    if (!p?.pending || p.pending.local !== local) return;
    const keys = readResponse(this.self, p.pending, msg);
    if (!keys) return;
    const t = this.now();
    const s = new Session(keys, t);
    this.byIndex.set(local, { peer: p, session: s });
    this.rotate(p, s);
    p.pending = undefined;
    p.tryingSince = 0;
    p.endpoint = from;
    p.lastRecv = t;
    p.lastHandshake = t;
    this.flush(p);
  }

  private onCookie(msg: Uint8Array) {
    const local = new DataView(msg.buffer, msg.byteOffset).getUint32(4, true);
    const p = this.byIndex.get(local)?.peer;
    if (!p?.pending) return;
    const c = openCookie(msg, p.pub, p.pending.mac1);
    if (c) p.cookie = { value: c, at: this.now() };
  }

  private rotate(p: Peer, s: Session) {
    if (p.previous) this.byIndex.delete(p.previous.keys.local);
    p.previous = p.current;
    p.current = s;
  }

  private onData(msg: Uint8Array, from: Endpoint) {
    const h = dataHead(msg);
    if (!h) return;
    const e = this.byIndex.get(h.receiver);
    const s = e?.session;
    if (!e || !s) return;
    const t = this.now();
    if (t - s.at > RejectAfterTime) return;
    const plain = openData(s.keys.recv, h.counter, msg);
    if (!plain || !s.replay.check(h.counter)) return;
    const p = e.peer;
    p.endpoint = from;
    p.lastRecv = t;
    // the initiator's first data confirms a responder's session
    if (p.next === s) {
      p.next = undefined;
      s.confirmed = true;
      this.rotate(p, s);
      p.lastHandshake = t;
      p.tryingSince = 0;
      this.flush(p);
    }
    if (!plain.length) return;
    const pkt = plain.subarray(0, ipLength(plain));
    const a = addrs(pkt);
    if (!a || !p.allowed.some((x) => contains(x, a.src))) return;
    p.rx += pkt.length;
    if (this.o.hub && a.dst !== this.address) {
      const to = this.route(a.dst);
      if (to && to !== p) this.sendTo(to, pkt);
      return;
    }
    this.o.deliver(pkt);
  }

  // --- timers, once a second ------------------------------------------------------------

  tick() {
    const t = this.now();
    for (const p of this.peers.values()) {
      const s = p.current;
      // no answer to an initiation: again
      if (p.pending && t - p.pending.at > RekeyTimeout + Math.random() * 333) {
        if (t - p.tryingSince > RekeyAttemptTime) {
          if (p.pending) this.byIndex.delete(p.pending.local);
          p.pending = undefined;
          p.tryingSince = 0;
          p.queue = [];
        } else this.handshake(p, true);
      }
      // a direct peer with no session: tried now and then, without data to send
      if (p.direct && !p.usable(t) && !p.pending && t - p.lastHandshake > RekeyTimeout * 6) this.handshake(p, true);
      // an old session the initiator still hears from: renewed before it is rejected
      if (s?.keys.initiator && t - s.at > RejectAfterTime - KeepaliveTimeout - RekeyTimeout && t - p.lastRecv < 1000)
        this.handshake(p, false);
      // data sent, nothing back: a new handshake
      if (s && p.lastData > p.lastRecv && t - p.lastData > KeepaliveTimeout + RekeyTimeout && !p.pending) {
        this.handshake(p, false);
        p.lastData = 0;
      }
      // heard from, nothing sent: a keepalive
      if (p.usable(t) && p.lastRecv > p.lastSent && t - p.lastRecv > KeepaliveTimeout)
        this.sendTo(p, new Uint8Array(0));
      // persistent keepalive
      if (p.keepalive && p.usable(t) && t - p.lastSent > p.keepalive) this.sendTo(p, new Uint8Array(0));
      if (p.keepalive && !p.usable(t) && !p.pending) this.handshake(p, false);
      // sessions past three lifetimes forgotten
      for (const k of ["previous", "current", "next"] as const) {
        const x = p[k];
        if (x && t - x.at > RejectAfterTime * 3) {
          this.byIndex.delete(x.keys.local);
          p[k] = undefined;
        }
      }
    }
  }

  // each peer as it stands, for status pages
  status() {
    const t = this.now();
    return [...this.peers.values()].map((p) => ({
      key: p.key,
      endpoint: p.endpoint ?? "",
      up: !!p.usable(t),
      handshakeAgoMs: p.lastHandshake ? t - p.lastHandshake : -1,
      rx: p.rx,
      tx: p.tx,
    }));
  }
}
