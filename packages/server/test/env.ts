// the environment every test here shares, set before any package is imported:
// bun test loads every file of this package into one module cache
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const root = mkdtempSync(join(tmpdir(), "phos-server-"));
for (const d of ["repo", "state", "files"]) mkdirSync(join(root, d), { recursive: true });
process.env.PHOSPHORUS_HOME = join(root, "repo");
process.env.STATE_DIR = join(root, "state");
process.env.FILES_ROOT = join(root, "files");
process.env.HOME_FS = join(root, "files");
process.env.SELF_HOST = "testhost";
process.env.FRONTEND_PORT = "0";
process.env.INGRESS_PORT = "0";
delete process.env.BASE_DOMAIN;
delete process.env.ADMIN_PASS;
delete process.env.PHOSPHORUS_UPDATE_PASSWORD;
delete process.env.TUNNEL_TOKEN;
