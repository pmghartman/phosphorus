// ASN.1 DER, as much as a certificate request needs: the encoder and a
// PKCS#10 request for a P-256 key over a list of names

import { createPublicKey, type KeyObject, sign } from "node:crypto";

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
};

function len(n: number): Uint8Array {
  if (n < 0x80) return new Uint8Array([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

export const tlv = (tag: number, body: Uint8Array) => concat([new Uint8Array([tag]), len(body.length), body]);

export const seq = (...items: Uint8Array[]) => tlv(0x30, concat(items));
export const set = (...items: Uint8Array[]) => tlv(0x31, concat(items));
export const octets = (b: Uint8Array) => tlv(0x04, b);
export const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
export const ia5 = (s: string) => tlv(0x16, new TextEncoder().encode(s));
export const int = (n: number) => tlv(0x02, new Uint8Array([n]));
export const bits = (b: Uint8Array) => tlv(0x03, concat([new Uint8Array([0]), b]));
// context-specific, constructed
export const ctx = (n: number, body: Uint8Array) => tlv(0xa0 | n, body);
// context-specific, primitive: a SAN dNSName
export const ctxPrim = (n: number, body: Uint8Array) => tlv(0x80 | n, body);

export function oid(s: string): Uint8Array {
  const parts = s.split(".").map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) stack.unshift((v & 0x7f) | 0x80);
    out.push(...stack);
  }
  return tlv(0x06, new Uint8Array(out));
}

const OID = {
  commonName: "2.5.4.3",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
};

// a PKCS#10 request for key over names, the first its common name, signed ECDSA SHA-256
export function csr(key: KeyObject, names: string[]): Uint8Array {
  const spki = new Uint8Array(createPublicKey(key).export({ type: "spki", format: "der" }));
  const subject = seq(set(seq(oid(OID.commonName), utf8(names[0]!))));
  const san = seq(...names.map((n) => ctxPrim(2, new TextEncoder().encode(n))));
  const extensions = seq(seq(oid(OID.subjectAltName), octets(san)));
  const attrs = ctx(0, seq(oid(OID.extensionRequest), set(extensions)));
  const info = seq(int(0), subject, spki, attrs);
  const sig = new Uint8Array(sign("sha256", info, key));
  return seq(info, seq(oid(OID.ecdsaWithSHA256)), bits(sig));
}

export const b64url = (b: Uint8Array | string) => Buffer.from(b).toString("base64url");
