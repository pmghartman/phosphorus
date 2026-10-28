import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { encrypted, generate, parsePublicKey, parseSecretKey } from "@phosphorus/minisign";

const read = (n: string) => readFileSync(`${import.meta.dir}/testdata/${n}`, "latin1");
const b64 = (s: string) => Buffer.from(s, "latin1").toString("base64");

test("generate", () => {
  const { secret, public: pub } = generate();
  expect(encrypted(secret)).toBe(false);
  const sk = parseSecretKey(secret, "");
  const pk = parsePublicKey(pub);
  expect(pk.id.equals(sk.id)).toBe(true);
  pk.verify(Buffer.from("x"), sk.sign(Buffer.from("x"), "x"));
});

// a key and signature made by rsign2, password hunter2
test("reference", () => {
  const data = Buffer.from(read("data.bin"), "latin1");
  const pub = parsePublicKey(b64(read("e.pub")));
  pub.verify(data, read("data.e.sig"));
  expect(() => parseSecretKey(read("e.key"), "wrong")).toThrow();
  const sk = parseSecretKey(b64(read("e.key")), "hunter2");
  const sig = sk.sign(data, "data.bin");
  pub.verify(data, sig);
  expect(() => pub.verify(Buffer.concat([data, Buffer.from("x")]), sig)).toThrow();
});
