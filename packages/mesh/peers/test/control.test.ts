import { expect, test } from "bun:test";
import { magicDomain } from "../src/control.ts";

test("the MagicDNS domain sits beside the control server's name, never above it", () => {
  expect(magicDomain("https://hs.mulab.dev", "mulab.dev")).toBe("mesh.mulab.dev");
  expect(magicDomain("https://hs.mulab.dev", "")).toBe("mesh.internal");
  // headscale refuses a base domain holding its own server's name
  expect(magicDomain("https://hs.mesh.mulab.dev", "mulab.dev")).toBe("tailnet.mesh.mulab.dev");
});
