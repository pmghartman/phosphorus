import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-reconfig-"));
process.env.STATE_DIR = dir;
process.env.PHOSPHORUS_INI_FILE = join(dir, "phosphorus.ini");
process.env.IDLE_POLL_INTERVAL_MS = "20";
writeFileSync(
  process.env.PHOSPHORUS_INI_FILE,
  "[files]\ndir = /srv/files\npriv = /srv/priv\n[home]\ndir = /srv/home\n[git]\nhost = true\n[model]\nhost = false\ngpu = true\n",
);
const { current, start } = await import("@phosphorus/reconfig");
const { readJSON } = await import("@phosphorus/util");

test("signature as JS wrote it", () => {
  expect(current()).toBe(
    '{"dir":"/srv/files","priv":"/srv/priv","home":"/srv/home","git":true,"gpu":true,"model":false}',
  );
});

test("the applied signature seeded on first start", async () => {
  start(() => true);
  expect(readJSON(join(dir, "reconfig.json"))).toEqual({ sig: current() });
  // busy: a change seen but never applied
  writeFileSync(process.env.PHOSPHORUS_INI_FILE!, "[files]\ndir = /elsewhere\n");
  await Bun.sleep(100);
  expect(readJSON(join(dir, "reconfig.json"))?.sig).not.toBe(current());
});
