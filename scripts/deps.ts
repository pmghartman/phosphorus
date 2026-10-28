// deps: each workspace package's @phosphorus/* dependencies set from what its
// source imports, as workspace:* links; --check only reports what differs
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const checkOnly = process.argv.includes("--check");

// every package dir: apps/*, packages/*/*
const dirs: string[] = [];
for (const a of readdirSync(join(root, "apps"))) dirs.push(join("apps", a));
for (const g of readdirSync(join(root, "packages")))
  for (const p of readdirSync(join(root, "packages", g))) dirs.push(join("packages", g, p));

const names = new Map<string, string>();
for (const d of dirs) {
  const f = join(root, d, "package.json");
  if (existsSync(f)) names.set(JSON.parse(readFileSync(f, "utf8")).name, d);
}

function* files(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "dist") yield* files(p);
    } else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) yield p;
  }
}

const importRe = /from\s+["'](@phosphorus\/[a-z-]+)["']|import\(\s*["'](@phosphorus\/[a-z-]+)["']\s*\)/g;
let bad = 0;
for (const d of dirs) {
  const f = join(root, d, "package.json");
  if (!existsSync(f)) continue;
  const pj = JSON.parse(readFileSync(f, "utf8"));
  const want = new Set<string>();
  for (const sub of ["src", "test", "tests"]) {
    for (const file of files(join(root, d, sub))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(importRe)) {
        const name = m[1] ?? m[2]!;
        if (name !== pj.name) want.add(name);
      }
    }
  }
  for (const name of want) if (!names.has(name)) throw new Error(`${d} imports ${name}, which no package declares`);
  const deps: Record<string, string> = {};
  for (const [k, v] of Object.entries((pj.dependencies ?? {}) as Record<string, string>))
    if (!k.startsWith("@phosphorus/")) deps[k] = v;
  for (const name of [...want].sort()) deps[name] = "workspace:*";
  const sorted = Object.fromEntries(Object.entries(deps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const next = { ...pj, dependencies: Object.keys(sorted).length ? sorted : undefined };
  if (!next.dependencies) delete next.dependencies;
  const text = JSON.stringify(next, null, 2) + "\n";
  const cur = readFileSync(f, "utf8");
  if (JSON.stringify(JSON.parse(cur)) === JSON.stringify(next)) continue;
  bad++;
  if (checkOnly) console.error(`[deps] ${d}/package.json is out of date; run bun scripts/deps.ts`);
  else {
    writeFileSync(f, text);
    console.log(
      `[deps] ${d}: ${Object.keys(sorted).filter((k) => k.startsWith("@phosphorus/")).length} workspace deps`,
    );
  }
}
if (checkOnly && bad) process.exit(1);
void statSync;
