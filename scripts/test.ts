// test: each package's tests in their own bun process, since bun test shares
// one module cache across files and packages read their env on import
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dirs: string[] = [];
const hasTests = (d: string) => ["test", "tests"].some((t) => existsSync(join(root, d, t)) && readdirSync(join(root, d, t)).some((f) => /\.test\.[cm]?[jt]s$/.test(f)));
for (const a of readdirSync(join(root, "apps"))) if (hasTests(`apps/${a}`)) dirs.push(`apps/${a}`);
for (const g of readdirSync(join(root, "packages"))) for (const p of readdirSync(join(root, "packages", g))) if (hasTests(`packages/${g}/${p}`)) dirs.push(`packages/${g}/${p}`);
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
