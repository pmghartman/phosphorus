// the primitives against their RFC vectors and Bun's own BLAKE2s
import { expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { hash, mac } from "../src/blake2s.ts";
import { chacha20, hchacha20, open, poly1305, seal, xopen, xseal } from "../src/chacha.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/[\s:]/g, ""), "hex"));
const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const seq = (n: number, from = 0) => Uint8Array.from({ length: n }, (_, i) => from + i);

test("blake2s matches Bun's for every length to 300", () => {
  for (let n = 0; n <= 300; n++) {
    const m = randomBytes(n);
    expect(toHex(hash(m))).toBe(createHash("blake2s256").update(m).digest("hex"));
  }
});

test("keyed blake2s, the reference KAT", () => {
  // blake2s-kat.txt: key 00..1f, empty input
  const out = new (require("../src/blake2s.ts").Blake2s)(32, seq(32)).digest();
  expect(toHex(out)).toBe("48a8997da407876b3d79c0d92325ad3b89cbb754d86ab71aee047ad345fd2c49");
  expect(mac(seq(32), new Uint8Array(0)).length).toBe(16);
});

test("chacha20 block, RFC 8439 2.3.2", () => {
  const out = new Uint8Array(64);
  chacha20(seq(32), hex("000000090000004a00000000"), 1, out, out);
  expect(toHex(out.subarray(0, 16))).toBe("10f1e7e4d13b5915500fdd1fa32071c4");
});

test("poly1305, RFC 8439 2.5.2", () => {
  const key = hex("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b");
  expect(toHex(poly1305(key, new TextEncoder().encode("Cryptographic Forum Research Group")))).toBe(
    "a8061dc1305136c6c22b8baf0c0127a9",
  );
});

test("chacha20-poly1305, RFC 8439 2.8.2", () => {
  const key = seq(32, 0x80);
  const nonce = hex("070000004041424344454647");
  const aad = hex("50515253c0c1c2c3c4c5c6c7");
  const plain = new TextEncoder().encode(
    "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
  );
  const sealed = seal(key, nonce, plain, aad);
  expect(toHex(sealed.subarray(0, 16))).toBe("d31a8d34648e60db7b86afbc53ef7ec2");
  expect(toHex(sealed.subarray(sealed.length - 16))).toBe("1ae10b594f09e26a7e902ecbd0600691");
  expect(open(key, nonce, sealed, aad)).toEqual(plain);
  sealed[3]! ^= 1;
  expect(open(key, nonce, sealed, aad)).toBeUndefined();
});

test("hchacha20, the XChaCha20 draft 2.2.1, and xchacha round trips", () => {
  expect(toHex(hchacha20(seq(32), hex("000000090000004a0000000031415927")))).toBe(
    "82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc",
  );
  const key = randomBytes(32);
  const nonce = randomBytes(24);
  const m = randomBytes(77);
  expect(xopen(key, nonce, xseal(key, nonce, m, seq(5)), seq(5))).toEqual(Uint8Array.from(m));
});

test("seal and open agree at every length to 200", () => {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  for (let n = 0; n <= 200; n++) {
    const m = Uint8Array.from(randomBytes(n));
    expect(open(key, nonce, seal(key, nonce, m))).toEqual(m);
  }
});
