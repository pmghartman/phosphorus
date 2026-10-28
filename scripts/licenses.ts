// licenses: the production dependencies of every workspace package, from the
// installed node_modules, checked against the allowed SPDX licenses (any
// other fails the build), and from them THIRD_PARTY_NOTICES.txt, every license
// text once with the components it covers, plus a CycloneDX SBOM. Bun itself
// and the pinned tools of packaging/tools-licenses.json are put in too.
//   bun scripts/licenses.ts --check            policy only, no network
//   bun scripts/licenses.ts [OUTDIR]           notices and sbom into OUTDIR (default dist/)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const allowed = new Set(["MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0", "0BSD", "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "Python-2.0", "PSF-2.0", "MIT-0", "Zlib", "CC-BY-4.0", "LGPL-3.0-or-later"]);
const licenseFile = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;
const root = resolve(import.meta.dir, "..");
const checkOnly = process.argv.includes("--check");
const outDir = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "dist";
const log = (s: string) => console.error(`[licenses] ${s}`);
const die = (s: string): never => (log(s), process.exit(1));

type Part = { group: string; name: string; version: string; spdx: string; source: string; texts: string[]; purl?: string };
const npmGroup = "npm packages in the phosphorus binary and web client";
const bundled = "Programs bundled with the host installers", fetched = "Programs a model host downloads at run time";

const filesIn = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && licenseFile.test(e.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((e) => readFileSync(join(dir, e.name), "utf8"));

// an installed package's folder: hoisted beside a dependant, or under bun's store
function find(name: string, from: string): string {
  for (let d = from; ; d = dirname(d)) {
    const p = join(d, "node_modules", name);
    if (existsSync(join(p, "package.json"))) return p;
    if (d === root || dirname(d) === d) break;
  }
  const store = join(root, "node_modules", ".bun");
  const prefix = name.replaceAll("/", "+") + "@";
  const hit = existsSync(store) ? readdirSync(store).filter((e) => e.startsWith(prefix)).sort() : [];
  if (hit.length) return join(store, hit.at(-1)!, "node_modules", name);
  return die(`${name} isn't installed (from ${from}); run bun install`);
}

// the SPDX expression of a package.json, the old forms normalised
function spdxOf(pj: any): string {
  const l = pj.license ?? pj.licenses;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === "string" ? x : x?.type)).filter(Boolean).join(" OR ");
  if (l && typeof l === "object" && l.type) return l.type;
  return "";
}
// one allowed license the expression offers, else ""
function pick(expr: string): string {
  const opts = expr.replace(/[()]/g, "").split(/\s+OR\s+|\//i).map((s) => s.trim());
  return opts.find((o) => allowed.has(o)) ?? "";
}

const parts = new Map<string, Part>();
const bad: string[] = [];
function walk(name: string, from: string) {
  const dir = find(name, from);
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const key = `${name}@${pj.version}`;
  if (parts.has(key)) return;
  const spdx = spdxOf(pj);
  if (!pick(spdx)) bad.push(`${key}: ${spdx || "no license field"}`);
  // a package shipping no text gets the standard SPDX one, fetched below
  const texts = filesIn(dir);
  parts.set(key, { group: npmGroup, name, version: pj.version, spdx, source: `https://www.npmjs.com/package/${name}`, texts, purl: `pkg:npm/${name}@${pj.version}` });
  for (const dep of Object.keys(pj.dependencies ?? {})) walk(dep, dir);
  // an optional dependency that didn't install is left out
  for (const dep of Object.keys(pj.optionalDependencies ?? {})) {
    try {
      walk(dep, dir);
    } catch {}
  }
}
for (const ws of ["apps", "packages", "web"]) {
  const dirs = ws === "web" ? [join(root, "web")] : readdirSync(join(root, ws)).map((d) => join(root, ws, d));
  for (const d of dirs) {
    const f = join(d, "package.json");
    if (!existsSync(f)) continue;
    for (const dep of Object.keys(JSON.parse(readFileSync(f, "utf8")).dependencies ?? {})) if (!dep.startsWith("@phosphorus/")) walk(dep, d);
  }
}
if (bad.length) die(`licenses outside the allowed set:\n  ${bad.join("\n  ")}`);
log(`${parts.size} npm packages, all under allowed licenses`);
if (checkOnly) process.exit(0);

// --- bun and the tools, their texts fetched at their pins ----------------------
async function fetchText(url: string): Promise<string> {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (r.ok) return await r.text();
      if (i === 3) die(`${url}: ${r.status}`);
    } catch (e) {
      if (i === 3) die(`${url}: ${e}`);
    }
    await Bun.sleep(2000 << i);
  }
}
const pinned = (file: string, re: string) => {
  const m = readFileSync(join(root, file), "utf8").match(new RegExp(re, "m"));
  return m?.[1] ?? die(`no version in ${file}`);
};
const all: Part[] = [...parts.values()];
const spdxTag = "v3.27.0";
const standard = new Map<string, string>();
for (const p of all)
  if (!p.texts.length) {
    const id = pick(p.spdx);
    if (!standard.has(id)) standard.set(id, await fetchText(`https://raw.githubusercontent.com/spdx/license-list-data/${spdxTag}/text/${id}.txt`));
    p.texts = [standard.get(id)!];
  }
all.push({ group: "Runtime compiled into the phosphorus binary", name: "Bun", version: Bun.version, spdx: "MIT", source: "https://bun.sh", texts: [await fetchText(`https://raw.githubusercontent.com/oven-sh/bun/bun-v${Bun.version}/LICENSE.md`)] });
const tools = JSON.parse(readFileSync(join(root, "packaging/tools-licenses.json"), "utf8"));
const forgejo = pinned("packaging/tools.sh", "^FORGEJO=(\\S+)");
for (const [group, list] of [[bundled, tools.bundled], [fetched, tools.fetched]] as [string, any[]][])
  for (const t of list) {
    const v = pinned(t.pin[0], t.pin[1]);
    all.push({ group, name: t.name, version: v, spdx: t.spdx, source: t.source.replaceAll("{v}", v), texts: [await fetchText(t.license.replaceAll("{v}", v))] });
  }

// --- output: each component under its group, then each distinct text once ----
const norm = (s: string) => s.replaceAll("\r\n", "\n").trim();
const groups = ["Runtime compiled into the phosphorus binary", npmGroup, bundled, fetched];
all.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
type Text = { id: number; body: string; users: string[] };
const byHash = new Map<string, Text>();
const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
for (const p of all)
  for (const t of p.texts) {
    const body = norm(t);
    let x = byHash.get(hash(body));
    if (!x) byHash.set(hash(body), (x = { id: 0, body, users: [] }));
    x.users.push(`${p.name} ${p.version}`);
  }
const order = [...byHash.values()].sort((a, b) => (a.users[0]! < b.users[0]! ? -1 : a.users[0]! > b.users[0]! ? 1 : 0));
order.forEach((x, i) => (x.id = i + 1));
let out = `Third-party notices

Generated by bun scripts/licenses.ts at build time. Each component below stays
under its own license; the phosphorus license (LICENSE) covers none of them.
Components are listed by group, then every distinct license text follows once,
with the components it covers.

Forgejo runs as a separate, unmodified program; phosphorus only writes its
configuration. Its complete corresponding source, forgejo-src-${forgejo}.tar.gz, is at:
https://codeberg.org/forgejo/forgejo/releases/download/v${forgejo}/forgejo-src-${forgejo}.tar.gz

With [model] gpu on an nvidia gpu, the model host also downloads NVIDIA's CUDA
runtime from llama.cpp's releases, under the NVIDIA CUDA EULA
(https://docs.nvidia.com/cuda/eula/). phosphorus ships no model; a model's
weights come under its own license.

Cloudflare, Forgejo and Tailscale are trademarks of their respective owners;
phosphorus is not affiliated with or endorsed by any of them.
`;
for (const g of groups) {
  out += `\n\n== ${g} ==\n\n`;
  for (const p of all) {
    if (p.group !== g) continue;
    const ids = p.texts.map((t) => `[${byHash.get(hash(norm(t)))!.id}]`);
    out += `${p.name} ${p.version}${p.spdx ? ", " + p.spdx : ""}, text ${ids.join(" ")}\n    ${p.source}\n`;
  }
}
out += "\n\n== License texts ==\n";
for (const x of order) out += `\n\n---- [${x.id}] ${x.users.join(", ")} ----\n\n${x.body}\n`;
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "THIRD_PARTY_NOTICES.txt"), out);

// the SBOM: CycloneDX 1.5 json, every npm package, bun and the tools
const version = existsSync(join(root, "VERSION")) ? readFileSync(join(root, "VERSION"), "utf8").trim() : "dev";
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: { timestamp: new Date().toISOString(), component: { type: "application", name: "phosphorus", version, licenses: [{ license: { id: "Apache-2.0" } }] } },
  components: all.map((p) => ({
    type: p.group === fetched || p.group === bundled ? "application" : "library",
    name: p.name,
    version: p.version,
    ...(p.purl ? { purl: p.purl } : {}),
    licenses: [pick(p.spdx) || !p.spdx.includes(" ") ? { license: { id: p.spdx || "NOASSERTION" } } : { expression: p.spdx }],
    externalReferences: [{ type: "website", url: p.source }],
  })),
};
writeFileSync(join(outDir, "phosphorus.cdx.json"), JSON.stringify(sbom, null, 1) + "\n");
log(`${all.length} components into ${outDir}/THIRD_PARTY_NOTICES.txt and phosphorus.cdx.json`);
