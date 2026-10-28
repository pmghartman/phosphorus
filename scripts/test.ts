// test: each package's tests in their own bun process, since bun test shares
// one module cache across files and packages read their env on import
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dirs: string[] = [];
for (const ws of ["packages", "apps"]) for (const d of readdirSync(join(root, ws))) if (existsSync(join(root, ws, d, "test")) && readdirSync(join(root, ws, d, "test")).some((f) => /\.test\.[cm]?[jt]s$/.test(f))) dirs.push(`${ws}/${d}`);
if (existsSync(join(root, "web/tests"))) dirs.push("web");
const only = process.argv.slice(2);
let failed = 0;
for (const d of dirs) {
  if (only.length && !only.some((o) => d.includes(o))) continue;
  const p = Bun.spawn(["bun", "test", d], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) failed++;
}
if (failed) {
  console.error(`[test] ${failed} package(s) failed`);
  process.exit(1);
}
