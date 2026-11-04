// imported first by every test file here: bun runs them in one process in no set
// order, and @phosphorus/util reads this env on its first import. A fresh state dir
// and phosphorus home (the store under it), this host named a, docker a fake on PATH logging its argv (fake-docker.ts)
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const dir = mkdtempSync(join(tmpdir(), "phos-stacks-"));
process.env.PHOSPHORUS_REPO_DIR = dir;
process.env.STATE_DIR = join(dir, "state");
process.env.STACKS_DIR = join(dir, "stacks");
process.env.SELF_HOST = "a";
// the elector's timing these tests were written against
process.env.LEASE_MS = "4000";
process.env.LEASE_MARGIN_MS = "1500";
process.env.BASE_DOMAIN = "";
export const bin = join(dir, "bin");
export const log = join(bin, "docker.log");
mkdirSync(bin);
const fake = join(import.meta.dir, "fake-docker.ts");
if (process.platform === "win32")
  writeFileSync(join(bin, "docker.cmd"), `@"${process.execPath}" "${fake}" "${bin}" %*\r\n`);
else {
  writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "${bin}" "$@"\n`);
  chmodSync(join(bin, "docker"), 0o755);
}
process.env.PATH = bin + delimiter + process.env.PATH;
// gone once every file has run, not after the first
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
