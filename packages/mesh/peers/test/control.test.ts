import { expect, test } from "bun:test";
import { freeIP, meshZone } from "../src/control.ts";

test("the mesh's DNS zone sits under the domain", () => {
  expect(meshZone("philab.io")).toBe("mesh.philab.io");
  expect(meshZone("")).toBe("mesh.internal");
});

test("a new address: the lowest free in 100.64.0.0/10, never a .0 or .255", () => {
  expect(freeIP([])).toBe("100.64.0.1");
  expect(freeIP(["100.64.0.1", "100.64.0.2", "100.64.0.4"])).toBe("100.64.0.3");
  const full = Array.from({ length: 254 }, (_, i) => `100.64.0.${i + 1}`);
  expect(freeIP(full)).toBe("100.64.1.1");
});

test("a hub host needs an address of its own on the internet", async () => {
  const { isPublicIPv4 } = await import("@phosphorus/util");
  expect(isPublicIPv4("135.148.218.250")).toBe(true);
  for (const a of ["10.0.0.4", "172.20.1.1", "192.168.1.9", "100.64.0.4", "169.254.1.1", "127.0.0.1", "::1"])
    expect(isPublicIPv4(a)).toBe(false);
});
