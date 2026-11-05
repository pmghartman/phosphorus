// a host's afterglow copies: the release's seed and its own updates, the newest this
// phosphorus speaks with picked; the protocol's range and its refusals

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickAfterglow, protoOf, protoOfFeatures, protoOK, protoRange, protoWhy, versionCmp } from "../src/index.ts";

let home = "";
afterEach(() => home && rmSync(home, { recursive: true, force: true }));

const copy = (dir: string, version: string, proto?: number) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  writeFileSync(join(dir, "afterglow"), "");
  if (proto !== undefined) writeFileSync(join(dir, "PROTO"), `${proto}\n`);
};

test("versions compare part by part", () => {
  expect(versionCmp("0.10", "0.9")).toBeGreaterThan(0);
  expect(versionCmp("v0.3", "0.3")).toBe(0);
  expect(versionCmp("1.0", "1.0.1")).toBeLessThan(0);
});

test("the protocol: unnumbered is 1, the range kept, the refusal says what to update", () => {
  expect(protoOf(undefined)).toBe(1);
  expect(protoOf(2)).toBe(2);
  expect(protoOf("x")).toBe(1);
  expect(protoOfFeatures(["stdio", "proto=1"])).toBe(1);
  expect(protoOfFeatures(["stdio"])).toBe(1);
  expect(protoOK(protoRange.max + 1)).toBe(false);
  expect(protoWhy(protoRange.max + 1, "0.9")).toContain("update phosphorus");
  expect(protoWhy(0)).toContain("update afterglow");
});

test("the newest copy this phosphorus speaks with is run", () => {
  home = mkdtempSync(join(tmpdir(), "ag-"));
  expect(pickAfterglow(home, false)).toBeUndefined();
  copy(join(home, "afterglow"), "0.3");
  expect(pickAfterglow(home, false)?.from).toBe("release");
  copy(join(home, "afterglow-update", "0.4"), "0.4", 1);
  copy(join(home, "afterglow-update", "0.5"), "0.5", protoRange.max + 1);
  const p = pickAfterglow(home, false)!;
  expect([p.version, p.from]).toEqual(["0.4", "update"]);
  // a phosphorus update seeding a newer one than the updates put
  copy(join(home, "afterglow"), "0.6");
  expect(pickAfterglow(home, false)?.version).toBe("0.6");
});
