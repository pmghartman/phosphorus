// ChaCha20, Poly1305 and their AEADs (RFC 8439, XChaCha20 draft), in
// TypeScript: Bun's crypto has neither

const sigma = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

const u32 = (b: Uint8Array, i: number) => (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;

// 20 rounds over state x, from s; add: the input added back (ChaCha20, not HChaCha20)
function rounds(s: Uint32Array, x: Uint32Array, add: boolean) {
  let x0 = s[0]!,
    x1 = s[1]!,
    x2 = s[2]!,
    x3 = s[3]!,
    x4 = s[4]!,
    x5 = s[5]!,
    x6 = s[6]!,
    x7 = s[7]!,
    x8 = s[8]!,
    x9 = s[9]!,
    x10 = s[10]!,
    x11 = s[11]!,
    x12 = s[12]!,
    x13 = s[13]!,
    x14 = s[14]!,
    x15 = s[15]!;
  for (let i = 0; i < 10; i++) {
    x0 = (x0 + x4) | 0;
    x12 ^= x0;
    x12 = (x12 << 16) | (x12 >>> 16);
    x8 = (x8 + x12) | 0;
    x4 ^= x8;
    x4 = (x4 << 12) | (x4 >>> 20);
    x0 = (x0 + x4) | 0;
    x12 ^= x0;
    x12 = (x12 << 8) | (x12 >>> 24);
    x8 = (x8 + x12) | 0;
    x4 ^= x8;
    x4 = (x4 << 7) | (x4 >>> 25);
    x1 = (x1 + x5) | 0;
    x13 ^= x1;
    x13 = (x13 << 16) | (x13 >>> 16);
    x9 = (x9 + x13) | 0;
    x5 ^= x9;
    x5 = (x5 << 12) | (x5 >>> 20);
    x1 = (x1 + x5) | 0;
    x13 ^= x1;
    x13 = (x13 << 8) | (x13 >>> 24);
    x9 = (x9 + x13) | 0;
    x5 ^= x9;
    x5 = (x5 << 7) | (x5 >>> 25);
    x2 = (x2 + x6) | 0;
    x14 ^= x2;
    x14 = (x14 << 16) | (x14 >>> 16);
    x10 = (x10 + x14) | 0;
    x6 ^= x10;
    x6 = (x6 << 12) | (x6 >>> 20);
    x2 = (x2 + x6) | 0;
    x14 ^= x2;
    x14 = (x14 << 8) | (x14 >>> 24);
    x10 = (x10 + x14) | 0;
    x6 ^= x10;
    x6 = (x6 << 7) | (x6 >>> 25);
    x3 = (x3 + x7) | 0;
    x15 ^= x3;
    x15 = (x15 << 16) | (x15 >>> 16);
    x11 = (x11 + x15) | 0;
    x7 ^= x11;
    x7 = (x7 << 12) | (x7 >>> 20);
    x3 = (x3 + x7) | 0;
    x15 ^= x3;
    x15 = (x15 << 8) | (x15 >>> 24);
    x11 = (x11 + x15) | 0;
    x7 ^= x11;
    x7 = (x7 << 7) | (x7 >>> 25);
    x0 = (x0 + x5) | 0;
    x15 ^= x0;
    x15 = (x15 << 16) | (x15 >>> 16);
    x10 = (x10 + x15) | 0;
    x5 ^= x10;
    x5 = (x5 << 12) | (x5 >>> 20);
    x0 = (x0 + x5) | 0;
    x15 ^= x0;
    x15 = (x15 << 8) | (x15 >>> 24);
    x10 = (x10 + x15) | 0;
    x5 ^= x10;
    x5 = (x5 << 7) | (x5 >>> 25);
    x1 = (x1 + x6) | 0;
    x12 ^= x1;
    x12 = (x12 << 16) | (x12 >>> 16);
    x11 = (x11 + x12) | 0;
    x6 ^= x11;
    x6 = (x6 << 12) | (x6 >>> 20);
    x1 = (x1 + x6) | 0;
    x12 ^= x1;
    x12 = (x12 << 8) | (x12 >>> 24);
    x11 = (x11 + x12) | 0;
    x6 ^= x11;
    x6 = (x6 << 7) | (x6 >>> 25);
    x2 = (x2 + x7) | 0;
    x13 ^= x2;
    x13 = (x13 << 16) | (x13 >>> 16);
    x8 = (x8 + x13) | 0;
    x7 ^= x8;
    x7 = (x7 << 12) | (x7 >>> 20);
    x2 = (x2 + x7) | 0;
    x13 ^= x2;
    x13 = (x13 << 8) | (x13 >>> 24);
    x8 = (x8 + x13) | 0;
    x7 ^= x8;
    x7 = (x7 << 7) | (x7 >>> 25);
    x3 = (x3 + x4) | 0;
    x14 ^= x3;
    x14 = (x14 << 16) | (x14 >>> 16);
    x9 = (x9 + x14) | 0;
    x4 ^= x9;
    x4 = (x4 << 12) | (x4 >>> 20);
    x3 = (x3 + x4) | 0;
    x14 ^= x3;
    x14 = (x14 << 8) | (x14 >>> 24);
    x9 = (x9 + x14) | 0;
    x4 ^= x9;
    x4 = (x4 << 7) | (x4 >>> 25);
  }
  if (add) {
    x[0] = x0 + s[0]!;
    x[1] = x1 + s[1]!;
    x[2] = x2 + s[2]!;
    x[3] = x3 + s[3]!;
    x[4] = x4 + s[4]!;
    x[5] = x5 + s[5]!;
    x[6] = x6 + s[6]!;
    x[7] = x7 + s[7]!;
    x[8] = x8 + s[8]!;
    x[9] = x9 + s[9]!;
    x[10] = x10 + s[10]!;
    x[11] = x11 + s[11]!;
    x[12] = x12 + s[12]!;
    x[13] = x13 + s[13]!;
    x[14] = x14 + s[14]!;
    x[15] = x15 + s[15]!;
  } else {
    x[0] = x0;
    x[1] = x1;
    x[2] = x2;
    x[3] = x3;
    x[12] = x12;
    x[13] = x13;
    x[14] = x14;
    x[15] = x15;
  }
}

const state = new Uint32Array(16);
const block = new Uint32Array(16);
const blockBytes = new Uint8Array(block.buffer);
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

function setup(key: Uint8Array, counter: number, nonce: Uint8Array) {
  state[0] = sigma[0]!;
  state[1] = sigma[1]!;
  state[2] = sigma[2]!;
  state[3] = sigma[3]!;
  for (let i = 0; i < 8; i++) state[4 + i] = u32(key, i * 4);
  state[12] = counter;
  state[13] = u32(nonce, 0);
  state[14] = u32(nonce, 4);
  state[15] = u32(nonce, 8);
}

// src XORed with the keystream from counter into dst; dst may be src
export function chacha20(key: Uint8Array, nonce: Uint8Array, counter: number, src: Uint8Array, dst: Uint8Array) {
  if (!littleEndian) throw new Error("chacha20 needs a little endian machine");
  setup(key, counter, nonce);
  const n = src.length;
  for (let off = 0; off < n; off += 64) {
    rounds(state, block, true);
    state[12] = (state[12]! + 1) >>> 0;
    const end = Math.min(64, n - off);
    for (let i = 0; i < end; i++) dst[off + i] = src[off + i]! ^ blockBytes[i]!;
  }
}

// a 32 byte subkey from a key and a 16 byte nonce
export function hchacha20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  state[0] = sigma[0]!;
  state[1] = sigma[1]!;
  state[2] = sigma[2]!;
  state[3] = sigma[3]!;
  for (let i = 0; i < 8; i++) state[4 + i] = u32(key, i * 4);
  for (let i = 0; i < 4; i++) state[12 + i] = u32(nonce16, i * 4);
  rounds(state, block, false);
  const out = new Uint8Array(32);
  const w = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) {
    w.setUint32(i * 4, block[i]!, true);
    w.setUint32(16 + i * 4, block[12 + i]!, true);
  }
  return out;
}

// --- Poly1305: ten 13 bit limbs, products exact in doubles -------------------------

export class Poly1305 {
  private r = new Float64Array(10);
  private r5 = new Float64Array(10);
  private h = new Float64Array(10);
  private d = new Float64Array(10);
  private pad = new Uint16Array(8);
  private buf = new Uint8Array(16);
  private left = 0;

  constructor(key: Uint8Array) {
    const t = (i: number) => key[i]! | (key[i + 1]! << 8);
    const t0 = t(0),
      t1 = t(2),
      t2 = t(4),
      t3 = t(6),
      t4 = t(8),
      t5 = t(10),
      t6 = t(12),
      t7 = t(14);
    const r = this.r;
    r[0] = t0 & 0x1fff;
    r[1] = ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
    r[2] = ((t1 >>> 10) | (t2 << 6)) & 0x1f03;
    r[3] = ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
    r[4] = ((t3 >>> 4) | (t4 << 12)) & 0x00ff;
    r[5] = (t4 >>> 1) & 0x1ffe;
    r[6] = ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
    r[7] = ((t5 >>> 11) | (t6 << 5)) & 0x1f81;
    r[8] = ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
    r[9] = (t7 >>> 5) & 0x007f;
    for (let i = 0; i < 10; i++) this.r5[i] = r[i]! * 5;
    for (let i = 0; i < 8; i++) this.pad[i] = t(16 + i * 2);
  }

  private blocks(m: Uint8Array, at: number, bytes: number, hibit: number) {
    const h = this.h,
      r = this.r,
      r5 = this.r5,
      d = this.d;
    while (bytes >= 16) {
      const t0 = m[at]! | (m[at + 1]! << 8),
        t1 = m[at + 2]! | (m[at + 3]! << 8),
        t2 = m[at + 4]! | (m[at + 5]! << 8),
        t3 = m[at + 6]! | (m[at + 7]! << 8),
        t4 = m[at + 8]! | (m[at + 9]! << 8),
        t5 = m[at + 10]! | (m[at + 11]! << 8),
        t6 = m[at + 12]! | (m[at + 13]! << 8),
        t7 = m[at + 14]! | (m[at + 15]! << 8);
      h[0]! += t0 & 0x1fff;
      h[1]! += ((t0 >>> 13) | (t1 << 3)) & 0x1fff;
      h[2]! += ((t1 >>> 10) | (t2 << 6)) & 0x1fff;
      h[3]! += ((t2 >>> 7) | (t3 << 9)) & 0x1fff;
      h[4]! += ((t3 >>> 4) | (t4 << 12)) & 0x1fff;
      h[5]! += (t4 >>> 1) & 0x1fff;
      h[6]! += ((t4 >>> 14) | (t5 << 2)) & 0x1fff;
      h[7]! += ((t5 >>> 11) | (t6 << 5)) & 0x1fff;
      h[8]! += ((t6 >>> 8) | (t7 << 8)) & 0x1fff;
      h[9]! += (t7 >>> 5) | hibit;
      let c = 0;
      for (let i = 0; i < 10; i++) {
        let s = c;
        for (let j = 0; j <= i; j++) s += h[j]! * r[i - j]!;
        for (let j = i + 1; j < 10; j++) s += h[j]! * r5[i - j + 10]!;
        c = Math.floor(s / 8192);
        d[i] = s - c * 8192;
      }
      c = c * 5 + d[0]!;
      d[0] = c % 8192;
      d[1]! += Math.floor(c / 8192);
      h.set(d);
      at += 16;
      bytes -= 16;
    }
  }

  update(m: Uint8Array): this {
    let at = 0;
    let n = m.length;
    if (this.left) {
      const take = Math.min(16 - this.left, n);
      this.buf.set(m.subarray(0, take), this.left);
      this.left += take;
      at += take;
      n -= take;
      if (this.left < 16) return this;
      this.blocks(this.buf, 0, 16, 1 << 11);
      this.left = 0;
    }
    const full = n & ~15;
    if (full) this.blocks(m, at, full, 1 << 11);
    if (n > full) {
      this.buf.set(m.subarray(at + full, at + n));
      this.left = n - full;
    }
    return this;
  }

  // zero bytes to the next 16 byte boundary, the AEAD's padding
  pad16(): this {
    if (this.left) this.update(new Uint8Array(16 - this.left));
    return this;
  }

  digest(): Uint8Array {
    if (this.left) {
      this.buf[this.left] = 1;
      this.buf.fill(0, this.left + 1);
      this.blocks(this.buf, 0, 16, 0);
      this.left = 0;
    }
    const h = Array.from(this.h, (v) => v);
    const g = new Array<number>(10);
    let c = h[1]! >>> 13;
    h[1]! &= 0x1fff;
    for (let i = 2; i < 10; i++) {
      h[i]! += c;
      c = h[i]! >>> 13;
      h[i]! &= 0x1fff;
    }
    h[0]! += c * 5;
    c = h[0]! >>> 13;
    h[0]! &= 0x1fff;
    h[1]! += c;
    c = h[1]! >>> 13;
    h[1]! &= 0x1fff;
    h[2]! += c;
    g[0] = h[0]! + 5;
    c = g[0] >>> 13;
    g[0] &= 0x1fff;
    for (let i = 1; i < 10; i++) {
      g[i] = h[i]! + c;
      c = g[i]! >>> 13;
      g[i]! &= 0x1fff;
    }
    g[9] = g[9]! - (1 << 13);
    let mask = (c ^ 1) - 1;
    for (let i = 0; i < 10; i++) g[i]! &= mask;
    mask = ~mask;
    for (let i = 0; i < 10; i++) h[i] = (h[i]! & mask) | g[i]!;
    const o = new Uint16Array(8);
    o[0] = (h[0]! | (h[1]! << 13)) & 0xffff;
    o[1] = ((h[1]! >>> 3) | (h[2]! << 10)) & 0xffff;
    o[2] = ((h[2]! >>> 6) | (h[3]! << 7)) & 0xffff;
    o[3] = ((h[3]! >>> 9) | (h[4]! << 4)) & 0xffff;
    o[4] = ((h[4]! >>> 12) | (h[5]! << 1) | (h[6]! << 14)) & 0xffff;
    o[5] = ((h[6]! >>> 2) | (h[7]! << 11)) & 0xffff;
    o[6] = ((h[7]! >>> 5) | (h[8]! << 8)) & 0xffff;
    o[7] = ((h[8]! >>> 8) | (h[9]! << 5)) & 0xffff;
    let f = o[0]! + this.pad[0]!;
    o[0] = f & 0xffff;
    for (let i = 1; i < 8; i++) {
      f = o[i]! + this.pad[i]! + (f >>> 16);
      o[i] = f & 0xffff;
    }
    const out = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      out[i * 2] = o[i]! & 0xff;
      out[i * 2 + 1] = o[i]! >>> 8;
    }
    return out;
  }
}

export const poly1305 = (key: Uint8Array, m: Uint8Array) => new Poly1305(key).update(m).digest();

// --- the AEADs ----------------------------------------------------------------------

const lengths = (aad: number, ct: number) => {
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, aad >>> 0, true);
  v.setUint32(4, Math.floor(aad / 2 ** 32), true);
  v.setUint32(8, ct >>> 0, true);
  v.setUint32(12, Math.floor(ct / 2 ** 32), true);
  return b;
};

function tag(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const otk = new Uint8Array(32);
  chacha20(key, nonce, 0, otk, otk);
  return new Poly1305(otk).update(aad).pad16().update(ct).pad16().update(lengths(aad.length, ct.length)).digest();
}

// constant time equality of two tags
function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

// plaintext sealed: ciphertext then its 16 byte tag
export function seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: Uint8Array = new Uint8Array(0)) {
  const out = new Uint8Array(plain.length + 16);
  const ct = out.subarray(0, plain.length);
  chacha20(key, nonce, 1, plain, ct);
  out.set(tag(key, nonce, aad, ct), plain.length);
  return out;
}

// a sealed box opened, undefined when its tag fails
export function open(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array = new Uint8Array(0)) {
  if (sealed.length < 16) return undefined;
  const ct = sealed.subarray(0, sealed.length - 16);
  if (!same(tag(key, nonce, aad, ct), sealed.subarray(sealed.length - 16))) return undefined;
  const out = new Uint8Array(ct.length);
  chacha20(key, nonce, 1, ct, out);
  return out;
}

// XChaCha20-Poly1305: a 24 byte nonce
function xkey(key: Uint8Array, nonce24: Uint8Array): [Uint8Array, Uint8Array] {
  const n = new Uint8Array(12);
  n.set(nonce24.subarray(16, 24), 4);
  return [hchacha20(key, nonce24.subarray(0, 16)), n];
}

export const xseal = (key: Uint8Array, nonce24: Uint8Array, plain: Uint8Array, aad?: Uint8Array) =>
  seal(...xkey(key, nonce24), plain, aad);

export const xopen = (key: Uint8Array, nonce24: Uint8Array, sealed: Uint8Array, aad?: Uint8Array) =>
  open(...xkey(key, nonce24), sealed, aad);
