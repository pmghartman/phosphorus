import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { install, ready } from "@phosphorus/tools";

// a tar header and its body, padded to 512
function entry(name: string, type: string, body = "", link = "", mode = 0o644) {
  const h = Buffer.alloc(512);
  h.write(name, 0);
  h.write(mode.toString(8).padStart(7, "0"), 100);
  h.write(body.length.toString(8).padStart(11, "0"), 124);
  h.write(type, 156);
  h.write(link, 157);
  h.write("ustar\x0000", 257);
  const b = Buffer.alloc(Math.ceil(body.length / 512) * 512);
  b.write(body);
  return Buffer.concat([h, b]);
}

const tarball = () =>
  Bun.gzipSync(
    Buffer.concat([
      entry("build/", "5", "", "", 0o755),
      entry("build/llama-server", "0", "#!/bin/sh\n", "", 0o755),
      entry("build/libx.so.1", "0", "lib"),
      entry("build/libx.so", "2", "", "libx.so.1"),
      entry("build/evil", "2", "", "../../etc/passwd"),
      entry("build/../../escape", "0", "no"),
      Buffer.alloc(1024),
    ]),
  );

const serve = (body: Uint8Array | null) => Bun.serve({ port: 0, fetch: () => (body ? new Response(body) : new Response("", { status: 404 })) });

test("install", async () => {
  const srv = serve(tarball());
  const dir = join(mkdtempSync(join(tmpdir(), "phos-tools-")), "llama-test");
  try {
    await install({ dir, urls: [`${srv.url}a.tar.gz`], strip: 1 });
  } finally {
    srv.stop();
  }
  expect(ready(dir)).toBe(true);
  expect(statSync(join(dir, "llama-server")).isFile()).toBe(true);
  if (process.platform !== "win32") {
    expect(statSync(join(dir, "llama-server")).mode & 0o100).toBeTruthy();
    expect(readlinkSync(join(dir, "libx.so"))).toBe("libx.so.1");
  }
  expect(() => lstatSync(join(dir, "evil"))).toThrow();
  expect(existsSync(join(dirname(dir), "escape"))).toBe(false);
  expect(existsSync(dir + ".part")).toBe(false);
});

test("failed fetch", async () => {
  const srv = serve(null);
  const dir = join(mkdtempSync(join(tmpdir(), "phos-tools-")), "tool-test");
  await expect(install({ dir, urls: [`${srv.url}x.tar.gz`], strip: 0 })).rejects.toThrow();
  srv.stop();
  expect(ready(dir)).toBe(false);
});
