// the update feed's signatures in minisign's format; keys and signatures as
// base64 of their files
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  scryptSync,
  sign,
  verify,
} from "node:crypto";

const algLegacy = Buffer.from("Ed");
const algHashed = Buffer.from("ED");
const kdfScrypt = Buffer.from("Sc");
const chkBlake = Buffer.from("B2");
const COMMENT = "untrusted comment:";

const blake2b = (bits: 256 | 512, ...parts: Uint8Array[]) => {
  const h = new Bun.CryptoHasher(bits === 256 ? "blake2b256" : "blake2b512");
  for (const p of parts) h.update(p);
  return Buffer.from(h.digest());
};
const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.compare(a, b) === 0;

// a file's base64 line: given as the file itself, base64 of the file, or the line alone
function unwrap(s: string, line: number): [Buffer, string[]] {
  s = s.trim();
  if (!s.startsWith(COMMENT)) {
    const b = Buffer.from(s, "base64");
    if (b.toString().startsWith(COMMENT)) s = b.toString();
  }
  let lines = s.trim().replaceAll("\r\n", "\n").split("\n");
  if (!lines[0]!.startsWith(COMMENT)) lines = [COMMENT, ...lines];
  if (lines.length <= line) throw new Error("minisign: truncated");
  return [Buffer.from(lines[line]!.trim(), "base64"), lines];
}

// a key id and its ed25519 public half
export class PublicKey {
  private key: KeyObject;
  constructor(
    public id: Buffer,
    raw: Buffer,
  ) {
    this.key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: b64url(raw) }, format: "jwk" });
  }

  // data checked against a signature file, base64 of one, by this key
  verify(data: Uint8Array, sig: string) {
    const [b, lines] = unwrap(sig, 1);
    if (b.length !== 74 || lines.length < 4) throw new Error("minisign: malformed signature");
    if (!eq(b.subarray(2, 10), this.id)) throw new Error("minisign: signed by another key");
    let msg: Uint8Array = data;
    if (eq(b.subarray(0, 2), algHashed)) msg = blake2b(512, data);
    else if (!eq(b.subarray(0, 2), algLegacy)) throw new Error("minisign: unknown signature algorithm");
    const s = b.subarray(10);
    if (!verify(null, msg, this.key, s)) throw new Error("minisign: bad signature");
    const tc = "trusted comment: ";
    const global = Buffer.from(lines[3]!.trim(), "base64");
    if (
      !lines[2]!.startsWith(tc) ||
      !verify(null, Buffer.concat([s, Buffer.from(lines[2]!.slice(tc.length))]), this.key, global)
    )
      throw new Error("minisign: bad trusted comment");
  }
}

// a key id and its ed25519 private half
export class SecretKey {
  private key: KeyObject;
  // priv: the 32-byte seed then the 32-byte public key
  constructor(
    public id: Buffer,
    priv: Buffer,
  ) {
    this.key = createPrivateKey({
      key: { kty: "OKP", crv: "Ed25519", d: b64url(priv.subarray(0, 32)), x: b64url(priv.subarray(32)) },
      format: "jwk",
    });
  }

  // data prehashed, its trusted comment the time and file name; base64 of the signature file
  sign(data: Uint8Array, file: string): string {
    const s = sign(null, blake2b(512, data), this.key);
    const trusted = `timestamp:${Math.floor(Date.now() / 1000)}\tfile:${file}`;
    const global = sign(null, Buffer.concat([s, Buffer.from(trusted)]), this.key);
    const line = Buffer.concat([algHashed, this.id, s]);
    const text = `untrusted comment: signature from phosphorus secret key\n${line.toString("base64")}\ntrusted comment: ${trusted}\n${global.toString("base64")}\n`;
    return Buffer.from(text).toString("base64");
  }
}

// a public key file, base64 of one, or its key line
export function parsePublicKey(s: string): PublicKey {
  const [b] = unwrap(s, 1);
  if (b.length !== 42 || !eq(b.subarray(0, 2), algLegacy)) throw new Error("minisign: not an ed25519 public key");
  return new PublicKey(b.subarray(2, 10), b.subarray(10));
}

// whether a secret key needs a password to open
export function encrypted(s: string): boolean {
  try {
    const [b] = unwrap(s, 1);
    return b.length === 158 && eq(b.subarray(2, 4), kdfScrypt);
  } catch {
    return false;
  }
}

// libsodium's choice of n (as log2), r and p from its ops and memory limits
function scryptParams(ops: number, mem: number): [number, number, number] {
  ops = Math.max(ops, 32768);
  const r = 8;
  const pick = (maxN: number) => {
    let n = 1;
    for (; n < 63; n++) if (2 ** n > maxN / 2) break;
    return n;
  };
  if (ops < mem / 32) return [pick(Math.floor(ops / (r * 4))), r, 1];
  const n = pick(Math.floor(mem / (r * 128)));
  const maxrp = Math.min(Math.floor(Math.floor(ops / 4) / 2 ** n), 0x3fffffff);
  return [n, r, Math.floor(maxrp / r)];
}

// a secret key file or base64 of one, opened with password when encrypted
export function parseSecretKey(s: string, password: string): SecretKey {
  const [b] = unwrap(s, 1);
  if (b.length !== 158 || !eq(b.subarray(0, 2), algLegacy) || !eq(b.subarray(4, 6), chkBlake))
    throw new Error("minisign: not an ed25519 secret key");
  const salt = b.subarray(6, 38);
  const ops = Number(b.readBigUInt64LE(38));
  const mem = Number(b.readBigUInt64LE(46));
  const body = Buffer.from(b.subarray(54));
  if (eq(b.subarray(2, 4), kdfScrypt)) {
    const [n, r, p] = scryptParams(ops, mem);
    const stream = scryptSync(password, salt, body.length, {
      N: 2 ** n,
      r,
      p,
      maxmem: 128 * r * 2 ** n * 2 + 1024 * 1024,
    });
    for (let i = 0; i < body.length; i++) body[i]! ^= stream[i]!;
  } else if (b[2] !== 0 || b[3] !== 0) throw new Error("minisign: unknown key derivation");
  if (!eq(blake2b(256, b.subarray(0, 2), body.subarray(0, 72)), body.subarray(72, 104)))
    throw new Error("minisign: wrong password or damaged key");
  return new SecretKey(Buffer.from(body.subarray(0, 8)), Buffer.from(body.subarray(8, 72)));
}

// a fresh key pair, its secret unencrypted: base64 of each file
export function generate(): { secret: string; public: string } {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  const priv = Buffer.concat([Buffer.from(jwk.d!, "base64url"), Buffer.from(jwk.x!, "base64url")]);
  const id = randomBytes(8);
  const sum = blake2b(256, algLegacy, id, priv);
  const sk = Buffer.concat([algLegacy, Buffer.from([0, 0]), chkBlake, Buffer.alloc(48), id, priv, sum]);
  const pk = Buffer.concat([algLegacy, id, priv.subarray(32)]);
  const file = (what: string, b: Buffer) =>
    Buffer.from(`untrusted comment: phosphorus update ${what}\n${b.toString("base64")}\n`).toString("base64");
  return { secret: file("secret key", sk), public: file("public key", pk) };
}
