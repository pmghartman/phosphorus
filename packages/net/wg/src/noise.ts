// WireGuard's handshake: Noise_IKpsk2 as the whitepaper lays it out, the four
// message formats, mac1 and mac2, and cookie replies
import { cat, hash, kdf, mac } from "./blake2s.ts";
import { open, seal, xopen, xseal } from "./chacha.ts";
import { dh, keyPair, type Static } from "./x25519.ts";

const enc = new TextEncoder();
const construction = enc.encode("Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s");
const identifier = enc.encode("WireGuard v1 zx2c4 Jason@zx2c4.com");
const labelMac1 = enc.encode("mac1----");
const labelCookie = enc.encode("cookie--");
const ck0 = hash(construction);
const h0 = hash(ck0, identifier);
const zero12 = new Uint8Array(12);
const empty = new Uint8Array(0);

export const MsgInit = 1;
export const MsgResp = 2;
export const MsgCookie = 3;
export const MsgData = 4;
export const InitLen = 148;
export const RespLen = 92;
export const CookieLen = 64;
export const DataHead = 16;

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);
const putU32 = (b: Uint8Array, at: number, v: number) => new DataView(b.buffer, b.byteOffset).setUint32(at, v, true);

// TAI64N now: seconds plus 2^62, nanoseconds, big endian
export function tai64n(ms = Date.now()): Uint8Array {
  const out = new Uint8Array(12);
  const v = new DataView(out.buffer);
  const s = Math.floor(ms / 1000);
  v.setUint32(0, 0x40000000 + Math.floor(s / 2 ** 32));
  v.setUint32(4, s >>> 0);
  v.setUint32(8, (ms % 1000) * 1e6);
  return out;
}

// a later TAI64N than b
export function after(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < 12; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

// --- mac1, mac2 and cookies --------------------------------------------------------------

// mac1's key for a receiver
export const mac1Key = (pub: Uint8Array) => hash(labelMac1, pub);
// the key a cookie reply from pub is sealed with
export const cookieKey = (pub: Uint8Array) => hash(labelCookie, pub);

// mac1 and mac2 stamped onto a handshake message, mac2 zero without a cookie
export function stampMacs(msg: Uint8Array, toPub: Uint8Array, cookie?: Uint8Array): Uint8Array {
  const at = msg.length - 32;
  const m1 = mac(mac1Key(toPub), msg.subarray(0, at));
  msg.set(m1, at);
  msg.set(cookie ? mac(cookie, msg.subarray(0, at + 16)) : new Uint8Array(16), at + 16);
  return m1;
}

// a handshake message's mac1 right for this receiver
export function mac1OK(msg: Uint8Array, selfPub: Uint8Array): boolean {
  const at = msg.length - 32;
  const want = mac(mac1Key(selfPub), msg.subarray(0, at));
  let d = 0;
  for (let i = 0; i < 16; i++) d |= want[i]! ^ msg[at + i]!;
  return d === 0;
}

// a cookie reply to a sender, sealed under this host's key
export function cookieReply(selfPub: Uint8Array, receiver: number, msgMac1: Uint8Array, cookie: Uint8Array) {
  const out = new Uint8Array(CookieLen);
  out[0] = MsgCookie;
  putU32(out, 4, receiver);
  const nonce = crypto.getRandomValues(new Uint8Array(24));
  out.set(nonce, 8);
  out.set(xseal(cookieKey(selfPub), nonce, cookie, msgMac1), 32);
  return out;
}

// the cookie out of a reply from peerPub, to the mac1 last sent it
export function openCookie(msg: Uint8Array, peerPub: Uint8Array, sentMac1: Uint8Array) {
  if (msg.length !== CookieLen) return undefined;
  return xopen(cookieKey(peerPub), msg.subarray(8, 32), msg.subarray(32), sentMac1);
}

// --- the handshake ---------------------------------------------------------------------

export type Keys = { send: Uint8Array; recv: Uint8Array; local: number; remote: number; initiator: boolean };

// an initiation in flight: what the response is read against
export type Pending = { ck: Uint8Array; h: Uint8Array; ePriv: Uint8Array; local: number; peerPub: Uint8Array };

// message 1 to peerPub
export function initiation(self: Static, peerPub: Uint8Array, local: number, ts = tai64n()) {
  const e = keyPair();
  let h = hash(h0, peerPub);
  let ck = kdf(ck0, e.pub, 1)[0]!;
  h = hash(h, e.pub);
  const es = dh(e.priv, peerPub);
  if (!es) return undefined;
  let k: Uint8Array;
  [ck, k] = kdf(ck, es, 2) as [Uint8Array, Uint8Array];
  const encStatic = seal(k, zero12, self.pub, h);
  h = hash(h, encStatic);
  const ss = dh(self, peerPub);
  if (!ss) return undefined;
  [ck, k] = kdf(ck, ss, 2) as [Uint8Array, Uint8Array];
  const encTime = seal(k, zero12, ts, h);
  h = hash(h, encTime);
  const msg = new Uint8Array(InitLen);
  msg[0] = MsgInit;
  putU32(msg, 4, local);
  msg.set(e.pub, 8);
  msg.set(encStatic, 40);
  msg.set(encTime, 88);
  const pending: Pending = { ck, h, ePriv: e.priv, local, peerPub };
  return { msg, pending };
}

// message 1 read by its receiver: who sent it, its timestamp, and the state to answer with
export function readInitiation(self: Static, msg: Uint8Array) {
  if (msg.length !== InitLen || msg[0] !== MsgInit) return undefined;
  const remote = u32(msg, 4);
  const ePub = msg.slice(8, 40);
  let h = hash(h0, self.pub);
  let ck = kdf(ck0, ePub, 1)[0]!;
  h = hash(h, ePub);
  const es = dh(self, ePub);
  if (!es) return undefined;
  let k: Uint8Array;
  [ck, k] = kdf(ck, es, 2) as [Uint8Array, Uint8Array];
  const encStatic = msg.subarray(40, 88);
  const peerPub = open(k, zero12, encStatic, h);
  if (!peerPub) return undefined;
  h = hash(h, encStatic);
  const ss = dh(self, peerPub);
  if (!ss) return undefined;
  [ck, k] = kdf(ck, ss, 2) as [Uint8Array, Uint8Array];
  const encTime = msg.subarray(88, 116);
  const ts = open(k, zero12, encTime, h);
  if (!ts) return undefined;
  h = hash(h, encTime);
  return { peerPub, ts, remote, ePub, ck, h };
}

// message 2 answering a read initiation; the session's keys
export function response(
  r: NonNullable<ReturnType<typeof readInitiation>>,
  local: number,
  psk: Uint8Array = new Uint8Array(32),
) {
  const e = keyPair();
  let ck = kdf(r.ck, e.pub, 1)[0]!;
  let h = hash(r.h, e.pub);
  const ee = dh(e.priv, r.ePub);
  const se = dh(e.priv, r.peerPub);
  if (!ee || !se) return undefined;
  ck = kdf(ck, ee, 1)[0]!;
  ck = kdf(ck, se, 1)[0]!;
  const [ck2, tau, k] = kdf(ck, psk, 3) as [Uint8Array, Uint8Array, Uint8Array];
  h = hash(h, tau);
  const encNothing = seal(k, zero12, empty, h);
  const msg = new Uint8Array(RespLen);
  msg[0] = MsgResp;
  putU32(msg, 4, local);
  putU32(msg, 8, r.remote);
  msg.set(e.pub, 12);
  msg.set(encNothing, 44);
  const [recv, send] = kdf(ck2, empty, 2) as [Uint8Array, Uint8Array];
  const keys: Keys = { send, recv, local, remote: r.remote, initiator: false };
  return { msg, keys };
}

// message 2 read by the initiator; the session's keys
export function readResponse(self: Static, p: Pending, msg: Uint8Array, psk: Uint8Array = new Uint8Array(32)) {
  if (msg.length !== RespLen || msg[0] !== MsgResp || u32(msg, 8) !== p.local) return undefined;
  const remote = u32(msg, 4);
  const ePub = msg.subarray(12, 44);
  let ck = kdf(p.ck, ePub, 1)[0]!;
  let h = hash(p.h, ePub);
  const ee = dh(p.ePriv, ePub);
  const se = dh(self, ePub);
  if (!ee || !se) return undefined;
  ck = kdf(ck, ee, 1)[0]!;
  ck = kdf(ck, se, 1)[0]!;
  const [ck2, tau, k] = kdf(ck, psk, 3) as [Uint8Array, Uint8Array, Uint8Array];
  h = hash(h, tau);
  if (!open(k, zero12, msg.subarray(44, 60), h)) return undefined;
  const [send, recv] = kdf(ck2, empty, 2) as [Uint8Array, Uint8Array];
  const keys: Keys = { send, recv, local: p.local, remote, initiator: true };
  return keys;
}

// --- transport data ------------------------------------------------------------------

const nonceOf = (counter: number) => {
  const n = new Uint8Array(12);
  const v = new DataView(n.buffer);
  v.setUint32(4, counter >>> 0, true);
  v.setUint32(8, Math.floor(counter / 2 ** 32), true);
  return n;
};

// one packet sealed for the peer, padded to 16; empty: a keepalive
export function dataMessage(key: Uint8Array, remote: number, counter: number, packet: Uint8Array): Uint8Array {
  const padded = new Uint8Array((packet.length + 15) & ~15);
  padded.set(packet);
  const sealed = seal(key, nonceOf(counter), padded);
  const out = new Uint8Array(DataHead + sealed.length);
  out[0] = MsgData;
  putU32(out, 4, remote);
  const v = new DataView(out.buffer);
  v.setUint32(8, counter >>> 0, true);
  v.setUint32(12, Math.floor(counter / 2 ** 32), true);
  out.set(sealed, DataHead);
  return out;
}

// a data message's receiver index and counter
export function dataHead(msg: Uint8Array): { receiver: number; counter: number } | undefined {
  if (msg.length < DataHead + 16 || msg[0] !== MsgData) return undefined;
  const v = new DataView(msg.buffer, msg.byteOffset);
  return { receiver: v.getUint32(4, true), counter: v.getUint32(8, true) + v.getUint32(12, true) * 2 ** 32 };
}

// a data message opened, undefined when forged
export const openData = (key: Uint8Array, counter: number, msg: Uint8Array) =>
  open(key, nonceOf(counter), msg.subarray(DataHead));

export { cat };
