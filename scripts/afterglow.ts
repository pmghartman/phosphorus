// afterglow: @phosphorus/afterglow pinned to a release of github.com/pmghartman/afterglow
// in every package.json that names it; the latest release when no tag is given.
// The release workflow runs it before installing; run bun install after it by hand
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = "pmghartman/afterglow";
const root = resolve(import.meta.dir, "..");

async function latest(): Promise<string> {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!r.ok) throw new Error(`${repo}'s latest release: HTTP ${r.status}`);
  return String(((await r.json()) as { tag_name?: unknown }).tag_name ?? "");
}

const tag = process.argv[2] || (await latest());
// the release workflow downloads the host zip by this form
if (!/^v\d+\.\d+$/.test(tag)) throw new Error(`not an afterglow release tag: ${tag || "(none)"}`);
const pin = `github:${repo}#${tag}`;

const files = [join(root, "package.json")];
for (const g of readdirSync(join(root, "packages")))
  for (const p of readdirSync(join(root, "packages", g))) files.push(join(root, "packages", g, p, "package.json"));
for (const a of readdirSync(join(root, "apps"))) files.push(join(root, "apps", a, "package.json"));

let changed = 0;
for (const f of files) {
  if (!existsSync(f)) continue;
  const text = readFileSync(f, "utf8");
  const next = text.replace(/("@phosphorus\/afterglow":\s*")[^"]*"/, `$1${pin}"`);
  if (next === text) continue;
  writeFileSync(f, next);
  changed++;
}
console.log(`[afterglow] ${tag}${changed ? `, ${changed} package.json changed` : ", already pinned"}`);
