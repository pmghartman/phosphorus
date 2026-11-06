// BLAKE2s (RFC 7693) keyed and unkeyed, any output length up to 32; and the
// HMAC and HKDF WireGuard builds on it

const iv = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const sigma = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Blake2s {
  private h = new Uint32Array(8);
  private buf = new Uint8Array(64);
  private len = 0;
  private t = 0;
  private v = new Uint32Array(16);
  private m = new Uint32Array(16);

  constructor(
    private outLen = 32,
    key?: Uint8Array,
  ) {
    const kl = key?.length ?? 0;
    if (outLen < 1 || outLen > 32 || kl > 32) throw new Error("blake2s: bad lengths");
    for (let i = 0; i < 8; i++) this.h[i] = iv[i]!;
    this.h[0] = (this.h[0]! ^ 0x01010000 ^ (kl << 8) ^ outLen) >>> 0;
    if (kl) {
      this.buf.set(key!);
      this.len = 64;
    }
  }

  private compress(last: boolean) {
    const v = this.v,
      m = this.m,
      b = this.buf;
    for (let i = 0; i < 16; i++)
      m[i] = b[i * 4]! | (b[i * 4 + 1]! << 8) | (b[i * 4 + 2]! << 16) | (b[i * 4 + 3]! << 24);
    for (let i = 0; i < 8; i++) {
      v[i] = this.h[i]!;
      v[i + 8] = iv[i]!;
    }
    v[12] ^= this.t >>> 0;
    v[13] ^= Math.floor(this.t / 2 ** 32);
    if (last) v[14] = ~v[14]!;
    const g = (a: number, bb: number, c: number, d: number, x: number, y: number) => {
      v[a] = v[a]! + v[bb]! + x;
      v[d] = rotr(v[d]! ^ v[a]!, 16);
      v[c] = v[c]! + v[d]!;
      v[bb] = rotr(v[bb]! ^ v[c]!, 12);
      v[a] = v[a]! + v[bb]! + y;
      v[d] = rotr(v[d]! ^ v[a]!, 8);
      v[c] = v[c]! + v[d]!;
      v[bb] = rotr(v[bb]! ^ v[c]!, 7);
    };
    for (let r = 0; r < 10; r++) {
      const s = sigma[r]!;
      g(0, 4, 8, 12, m[s[0]!]!, m[s[1]!]!);
      g(1, 5, 9, 13, m[s[2]!]!, m[s[3]!]!);
      g(2, 6, 10, 14, m[s[4]!]!, m[s[5]!]!);
      g(3, 7, 11, 15, m[s[6]!]!, m[s[7]!]!);
      g(0, 5, 10, 15, m[s[8]!]!, m[s[9]!]!);
      g(1, 6, 11, 12, m[s[10]!]!, m[s[11]!]!);
      g(2, 7, 8, 13, m[s[12]!]!, m[s[13]!]!);
      g(3, 4, 9, 14, m[s[14]!]!, m[s[15]!]!);
    }
    for (let i = 0; i < 8; i++) this.h[i] = this.h[i]! ^ v[i]! ^ v[i + 8]!;
  }

  update(data: Uint8Array): this {
    for (let i = 0; i < data.length; ) {
      if (this.len === 64) {
        this.t += 64;
        this.compress(false);
        this.len = 0;
      }
      const take = Math.min(64 - this.len, data.length - i);
      this.buf.set(data.subarray(i, i + take), this.len);
      this.len += take;
      i += take;
    }
    return this;
  }

  digest(): Uint8Array {
    this.t += this.len;
    this.buf.fill(0, this.len);
    this.compress(true);
    const out = new Uint8Array(32);
    const w = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) w.setUint32(i * 4, this.h[i]!, true);
    return out.slice(0, this.outLen);
  }
}

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// HASH(parts...): BLAKE2s-256
export const hash = (...parts: Uint8Array[]) => {
  const b = new Blake2s(32);
  for (const p of parts) b.update(p);
  return b.digest();
};

// MAC(key, input): keyed BLAKE2s-128
export const mac = (key: Uint8Array, input: Uint8Array) => new Blake2s(16, key).update(input).digest();

// HMAC-BLAKE2s-256, a 64 byte block
export function hmac(key: Uint8Array, input: Uint8Array): Uint8Array {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? hash(key) : key);
  const ipad = k.map((x) => x ^ 0x36);
  const opad = k.map((x) => x ^ 0x5c);
  return hash(opad, hash(ipad, input));
}

// HKDF with n outputs of 32 bytes, as WireGuard's KDF1..KDF3
export function kdf(key: Uint8Array, input: Uint8Array, n: 1 | 2 | 3): Uint8Array[] {
  const prk = hmac(key, input);
  const out: Uint8Array[] = [];
  let prev: Uint8Array = new Uint8Array(0);
  for (let i = 1; i <= n; i++) {
    prev = hmac(prk, cat(prev, new Uint8Array([i])));
    out.push(prev);
  }
  return out;
}

export { cat };
