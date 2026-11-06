// the environment the tests here share, set before any package is imported: the
// cache under a temp dir, never this machine's state
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = mkdtempSync(join(tmpdir(), "phos-hostdesk-"));
process.env.STATE_DIR = join(root, "state");
