import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "phos-reconfig-"));
process.env.STATE_DIR = dir;
process.env.PHOSPHORUS_SYS_DIR = join(dir, "sys");
process.env.SELF_HOST = "mike";
process.env.IDLE_POLL_INTERVAL_MS = "20";
// this host's settings record, as the store keeps it
const rec = join(dir, "sys", "etc", "hosts", "mike", "config.json");
const put = (data: unknown) => writeFileSync(rec, JSON.stringify({ t: Date.now(), h: "mike", c: "x", data }));
mkdirSync(join(dir, "sys", "etc", "hosts", "mike"), { recursive: true });
put({
  shares: [
    { dir: "/srv/files", perms: "r" },
    { dir: "/srv/priv", perms: "rw" },
  ],
  model: { host: false, gpu: true },
});
const { current, start } = await import("@phosphorus/reconfig");
const { readJSON } = await import("@phosphorus/util");

test("signature as JS wrote it", () => {
  expect(current()).toBe('{"dir":"/srv/files, /srv/priv","priv":"r, rw","gpu":true,"model":false}');
});

test("the applied signature seeded on first start", async () => {
  start(() => true);
  expect(readJSON(join(dir, "run", "reconfig.json"))).toEqual({ sig: current() });
  // busy: a change seen but never applied
  put({ shares: [{ dir: "/elsewhere" }] });
  await Bun.sleep(100);
  expect(readJSON(join(dir, "run", "reconfig.json"))?.sig).not.toBe(current());
});
