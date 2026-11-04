// glow's identity: the RSA key and self-signed X.509 certificate phosphorus shows a
// GameStream host (Sunshine, Apollo) when it pairs and on every HTTPS call after.
// The certificate is built here as DER by hand, node:crypto having no way to make one

import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export type Identity = {
  // PEM, as the host stores and compares it
  cert: string;
  key: string;
  // the certificate's signature bytes, which pairing hashes
  sig: Uint8Array;
  // the id GameStream calls hand over with every request
  uniqueid: string;
};

const len = (n: number): number[] => {
  if (n < 0x80) return [n];
  const b: number[] = [];
  while (n > 0) {
    b.unshift(n & 0xff);
    n >>>= 8;
  }
  return [0x80 | b.length, ...b];
};
const tlv = (tag: number, body: Uint8Array): Uint8Array => {
  const h = [tag, ...len(body.length)];
  const out = new Uint8Array(h.length + body.length);
  out.set(h);
  out.set(body, h.length);
  return out;
};
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
const seq = (...p: Uint8Array[]) => tlv(0x30, cat(...p));
const oid = (dotted: string) => {
  const parts = dotted.split(".").map(Number);
  const b: number[] = [parts[0]! * 40 + parts[1]!];
  for (const v of parts.slice(2)) {
    const s: number[] = [v & 0x7f];
    for (let x = v >>> 7; x > 0; x >>>= 7) s.unshift(0x80 | (x & 0x7f));
    b.push(...s);
  }
  return tlv(0x06, new Uint8Array(b));
};
const int = (b: Uint8Array) => tlv(0x02, b[0]! & 0x80 ? cat(new Uint8Array([0]), b) : b);
const utc = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, new TextEncoder().encode(s));
};
const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, new TextEncoder().encode(cn)))));
const sha256RSA = seq(oid("1.2.840.113549.1.1.11"), new Uint8Array([0x05, 0x00]));

const pem = (label: string, der: Uint8Array) =>
  `-----BEGIN ${label}-----\n${(
    Buffer.from(der)
      .toString("base64")
      .match(/.{1,64}/g) ?? []
  ).join("\n")}\n-----END ${label}-----\n`;

export const derOf = (p: string) =>
  new Uint8Array(Buffer.from(p.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"));

// one DER element at off: its tag, where its body starts and ends
function element(d: Uint8Array, off: number): { tag: number; start: number; end: number } {
  const tag = d[off]!;
  let l = d[off + 1]!;
  let start = off + 2;
  if (l & 0x80) {
    const n = l & 0x7f;
    l = 0;
    for (let i = 0; i < n; i++) l = l * 256 + d[start + i]!;
    start += n;
  }
  return { tag, start, end: start + l };
}

// a certificate's signature: the bit string after its tbs and algorithm
export function signatureOf(certPem: string): Uint8Array {
  const d = derOf(certPem);
  const top = element(d, 0);
  const tbs = element(d, top.start);
  const alg = element(d, tbs.end);
  const bits = element(d, alg.end);
  if (bits.tag !== 0x03) throw new Error("not an x.509 certificate");
  return d.slice(bits.start + 1, bits.end);
}

// a fresh identity: RSA 2048, valid twenty years from yesterday
export function makeIdentity(cn = "phosphorus"): Identity {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const from = new Date(Date.now() - 86_400_000);
  const to = new Date(from.getTime() + 20 * 365 * 86_400_000);
  const serial = randomBytes(8);
  serial[0]! &= 0x7f;
  const tbs = seq(
    tlv(0xa0, int(new Uint8Array([2]))),
    int(serial),
    sha256RSA,
    name(cn),
    seq(utc(from), utc(to)),
    name(cn),
    spki,
  );
  const sig = new Uint8Array(sign("sha256", tbs, privateKey));
  const der = seq(tbs, sha256RSA, tlv(0x03, cat(new Uint8Array([0]), sig)));
  const key = String(privateKey.export({ type: "pkcs8", format: "pem" }));
  const uniqueid = createHash("sha256").update(der).digest("hex").slice(0, 16).toUpperCase();
  return { cert: pem("CERTIFICATE", der), key, sig, uniqueid };
}

// the public key a certificate holds, to check what the host signed
export const publicKeyOf = (certPem: string) => createPublicKey(certPem);
