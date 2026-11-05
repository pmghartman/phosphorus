// afterglow's own updates: the release manifest read only when the release key signed it,
// its shape checked, and this host's build named as the manifest names it

import { afterAll, expect, test } from "bun:test";
import { generate, parseSecretKey } from "@phosphorus/minisign";
import { latest, manifestOf, platformKey } from "../src/afterglow.ts";

const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});

const manifest = {
  version: "v0.4",
  proto: 1,
  assets: {
    "windows-x86_64": { name: "afterglow-0.4-windows-x86_64.zip", sha256: "a".repeat(64) },
    "linux-x86_64": { name: "../evil", sha256: "b".repeat(64) },
    "linux-aarch64": { name: "afterglow-0.4-linux-aarch64.tar.gz", sha256: "nope" },
  },
};

test("a manifest's shape: version, protocol, only well formed archives", () => {
  const m = manifestOf(manifest);
  expect(m.version).toBe("0.4");
  expect(m.proto).toBe(1);
  expect(Object.keys(m.assets)).toEqual(["windows-x86_64"]);
  expect(() => manifestOf({ proto: 1 })).toThrow("no version");
  expect(() => manifestOf({ version: "0.4" })).toThrow("no protocol");
  expect(platformKey()).toMatch(/^(windows|linux|darwin)-(x86_64|aarch64)$/);
});

test("the latest release read only when the release key signed it", async () => {
  const k = generate();
  const other = generate();
  process.env.APPS_PUBKEY = k.public;
  const body = new TextEncoder().encode(JSON.stringify(manifest));
  let signer = k.secret;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    if (u.endsWith(".minisig")) return new Response(parseSecretKey(signer, "").sign(body, "afterglow.json"));
    if (u.endsWith("afterglow.json")) return new Response(body);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  expect((await latest(true)).version).toBe("0.4");
  signer = other.secret;
  await expect(latest(true)).rejects.toThrow("signed by another key");
});
