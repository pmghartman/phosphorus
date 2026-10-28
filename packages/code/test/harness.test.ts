import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSync } from "@phosphorus/util";
import { probeCommand } from "../src/harness.ts";
import { Claude, harnessByID, Harnesses, harnessOf, Opencode, parseProbe } from "../src/index.ts";
import { tmp } from "./fake.ts";

// the probe's lines off a PATH holding a fake opencode and no claude
test.skipIf(process.platform === "win32" || !Bun.which("sh"))("probe command", () => {
  const home = tmp("probe");
  const bin = join(home, ".opencode", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho 1.2.3\n", { mode: 0o755 });
  const r = runSync(["sh", "-c", probeCommand()], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
  expect(r.ok, r.output).toBe(true);
  const got = r.stdout.trim();
  expect(got).toContain("claude\t0\t");
  expect(got).toContain("opencode\t1\t1.2.3");
});

test("harness by id", () => {
  expect(harnessByID(Opencode)?.meshOnly).toBe(true);
  expect(harnessByID("nope")).toBeUndefined();
  expect(harnessOf({})).toBe(Claude);
  // the pages' view of a harness: no command, path or installer in it
  expect(Object.keys(Harnesses[0]!).sort()).toEqual(["about", "icon", "id", "label", "meshOnly", "site"]);
});

test("parse probe", () => {
  const st = parseProbe("claude\t1\t\r\nopencode\t0\t\nnoise\n");
  expect(st.length).toBe(Harnesses.length);
  expect([st[0]!.installed, st[0]!.version, st[1]!.installed]).toEqual([true, "", false]);
  expect(parseProbe("claude\t1\t2.0.1 (Claude Code)\n")[0]!.version).toBe("2.0.1 (Claude Code)");
});
