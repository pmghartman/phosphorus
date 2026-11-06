import { expect, test } from "bun:test";
import { magicDomain } from "../src/control.ts";

test("the MagicDNS domain sits beside the control server's name, never above it", () => {
  expect(magicDomain("https://hs.mulab.dev", "mulab.dev")).toBe("mesh.mulab.dev");
  expect(magicDomain("https://hs.mulab.dev", "")).toBe("mesh.internal");
  // headscale refuses a base domain holding its own server's name
  expect(magicDomain("https://hs.mesh.mulab.dev", "mulab.dev")).toBe("tailnet.mesh.mulab.dev");
});

test("a control host needs an address of its own on the internet", async () => {
  const { isPublicIPv4 } = await import("@phosphorus/util");
  expect(isPublicIPv4("135.148.218.250")).toBe(true);
  for (const a of ["10.0.0.4", "172.20.1.1", "192.168.1.9", "100.64.0.4", "169.254.1.1", "127.0.0.1", "::1"])
    expect(isPublicIPv4(a)).toBe(false);
});
