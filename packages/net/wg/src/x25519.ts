// X25519 on raw 32 byte keys, through node:crypto's key objects
import { createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, type KeyObject } from "node:crypto";

const pkcs8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const spki = Buffer.from("302a300506032b656e032100", "hex");

const privObj = (k: Uint8Array) => createPrivateKey({ key: Buffer.concat([pkcs8, k]), format: "der", type: "pkcs8" });
const pubObj = (k: Uint8Array) => createPublicKey({ key: Buffer.concat([spki, k]), format: "der", type: "spki" });
const raw = (b64url: unknown) => Uint8Array.from(Buffer.from(String(b64url), "base64url"));

export type KeyPair = { priv: Uint8Array; pub: Uint8Array };

export function keyPair(): KeyPair {
  const jwk = generateKeyPairSync("x25519").privateKey.export({ format: "jwk" });
  return { priv: raw(jwk.d), pub: raw(jwk.x) };
}

export const publicOf = (priv: Uint8Array) => raw(createPublicKey(privObj(priv)).export({ format: "jwk" }).x);

// a private key kept as an object for many exchanges
export class Static {
  readonly obj: KeyObject;
  readonly pub: Uint8Array;
  constructor(readonly priv: Uint8Array) {
    this.obj = privObj(priv);
    this.pub = publicOf(priv);
  }
}

// the shared secret, undefined for a low order point
export function dh(priv: Uint8Array | Static, pub: Uint8Array): Uint8Array | undefined {
  try {
    const out = Uint8Array.from(
      diffieHellman({ privateKey: priv instanceof Static ? priv.obj : privObj(priv), publicKey: pubObj(pub) }),
    );
    return out.some((b) => b !== 0) ? out : undefined;
  } catch {
    return undefined;
  }
}

export const b64 = (k: Uint8Array) => Buffer.from(k).toString("base64");
export const unb64 = (s: string) => {
  const k = Uint8Array.from(Buffer.from(s, "base64"));
  return k.length === 32 ? k : undefined;
};
