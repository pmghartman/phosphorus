// scrypt hashes and aes-256-gcm boxes, byte for byte what the Go and Node
// frontends wrote: Node's scrypt defaults, hex iv and tag, base64 data
import { createCipheriv, createDecipheriv, randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";

const scryptOpts = { N: 16384, r: 8, p: 1 };
const hexRe = /^([0-9a-fA-F]{2})*$/;

// hex decoded, undefined when not hex
export const unhex = (s: unknown): Uint8Array | undefined =>
  typeof s === "string" && hexRe.test(s) ? Buffer.from(s, "hex") : undefined;
export const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
export const randHex = (n: number) => randomBytes(n).toString("hex");

// Derive 64 bytes: the hash's half stored, the key's never
export function Derive(pass: string, saltHex: string): Uint8Array {
  return scryptSync(pass, Buffer.from(saltHex, "hex"), 64, scryptOpts);
}

// Derive off the event loop, for the requests that log in
export function derive(pass: string, saltHex: string): Promise<Uint8Array> {
  return new Promise((res, rej) =>
    scrypt(pass, Buffer.from(saltHex, "hex"), 64, scryptOpts, (e, k) => (e ? rej(e) : res(k))),
  );
}

// Box an aes-256-gcm sealed text
export type Box = { iv: string; tag: string; data: string };

// Seal text under key
export function Seal(key: Uint8Array, text: string): Box {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return { iv: iv.toString("hex"), tag: c.getAuthTag().toString("hex"), data: ct.toString("base64") };
}

// a box as JSON held it, undefined when it isn't one
export function boxOf(v: unknown): Box | undefined {
  const b = v as Box | null;
  if (
    !b ||
    typeof b !== "object" ||
    typeof b.iv !== "string" ||
    typeof b.tag !== "string" ||
    typeof b.data !== "string"
  )
    return;
  return { iv: b.iv, tag: b.tag, data: b.data };
}

// Open a box, undefined on any failure
export function Open(key: Uint8Array | undefined, b: Box | undefined): string | undefined {
  if (!b || !key || key.length !== 32) return;
  const iv = unhex(b.iv),
    tag = unhex(b.tag);
  if (!iv || !tag || iv.length === 0 || tag.length !== 16) return;
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    d.setAuthTag(tag);
    return Buffer.concat([d.update(Buffer.from(b.data, "base64")), d.final()]).toString("utf8");
  } catch {
    return;
  }
}

// B64URL decode, padding or the standard alphabet tolerated as Node's
export function B64URL(s: string): Uint8Array | undefined {
  const t = s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  if (!/^[A-Za-z0-9_-]*$/.test(t) || t.length % 4 === 1) return;
  return Buffer.from(t, "base64url");
}

export const b64url = (s: string | Uint8Array) =>
  (typeof s === "string" ? Buffer.from(s, "utf8") : Buffer.from(s)).toString("base64url");

// a stored hash against a derivation's first half, in constant time
export function hashOK(out: Uint8Array, hashHex: unknown): boolean {
  const h = unhex(hashHex);
  return !!h && h.length === 32 && timingSafeEqual(out.subarray(0, 32), h);
}

// Go's subtle.ConstantTimeCompare on two strings
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
