// the catalogue's recipes checked without installing anything: each step's sh
// parsed, every release asset it asks GitHub for found for amd64 and arm64, its
// apt repositories, Debian packages and literal downloads answering.
//   bun scripts/recipes.ts [id ...]        (no ids: every recipe)
//   bun scripts/recipes.ts path/to/list.ts  (one recipe list alone)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Recipe, servicesOf } from "../packages/mesh/webapps/src/services/native.ts";
import { type Service, script } from "../packages/mesh/webapps/src/services/scripts.ts";

const args = process.argv.slice(2);
const file = args[0]?.endsWith(".ts") ? args.shift() : undefined;
const want = new Set(args);
const Services: Service[] = file
  ? servicesOf(((await import(join(process.cwd(), file))) as { recipes: Recipe[] }).recipes)
  : (await import("../packages/mesh/webapps/src/services.ts")).Services;
const where = { ip: "100.64.0.9", domain: "example.test", url: "https://x.example.test" };
const arches = [
  { A: "amd64", X: "x86_64", XA: "x64", DISTRO: "debian", CODENAME: "trixie" },
  { A: "arm64", X: "aarch64", XA: "arm64", DISTRO: "debian", CODENAME: "trixie" },
];
const dist = "trixie";
const tmp = mkdtempSync(join(tmpdir(), "phos-recipes-"));
const ghToken = Bun.spawnSync(["gh", "auth", "token"]).stdout.toString().trim();

const cache = new Map<string, Promise<any>>();
function cached<T>(k: string, f: () => Promise<T>): Promise<T> {
  if (!cache.has(k)) cache.set(k, f());
  return cache.get(k)!;
}
const release = (repo: string) =>
  cached(`rel:${repo}`, async () => {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", ...(ghToken ? { Authorization: `Bearer ${ghToken}` } : {}) },
    });
    return r.ok ? r.json() : undefined;
  });
const answers = (url: string) =>
  cached(`url:${url}`, async () => {
    for (const method of ["HEAD", "GET"])
      try {
        const r = await fetch(url, { method, redirect: "follow", signal: AbortSignal.timeout(20000) });
        await r.body?.cancel();
        if (r.ok) return true;
      } catch {}
    return false;
  });
const debPkg = (name: string) =>
  cached(`deb:${name}`, async () => {
    const r = await fetch(`https://sources.debian.org/api/src/${name}/`).catch(() => undefined);
    if (r?.ok) return true;
    // a binary package: packages.debian.org's page for the suite
    const p = await fetch(`https://packages.debian.org/${dist}/${name}`).catch(() => undefined);
    const t = p?.ok ? await p.text() : "";
    return !!t && !/No such package|Package not available/i.test(t);
  });

const subst = (s: string, a: Record<string, string>) => s.replace(/\$(XA|X|A|DISTRO|CODENAME)\b/g, (_, k) => a[k]!);
const literal = (s: string) => !/\$/.test(s);

let bad = 0;
const say = (id: string, why: string) => {
  bad++;
  console.log(`  ✗ ${id}: ${why}`);
};

for (const s of Services) {
  if (!s.native || (want.size && !want.has(s.id))) continue;
  const n = s.native;
  console.log(`${s.id}`);
  // each step parsed by sh
  for (const op of ["install", "update", "remove"] as const) {
    const f = join(tmp, `${s.id}.${op}.sh`);
    writeFileSync(f, script(s, op, op === "remove", where));
    const r = Bun.spawnSync(["sh", "-n", f]);
    if (r.exitCode !== 0) say(s.id, `${op}: sh -n: ${r.stderr.toString().trim()}`);
  }
  const text = `${n.install}\n${n.remove}`;
  if (text.includes("${")) say(s.id, "uses ${...}: write sh variables as $VAR");
  // release assets, for both machines
  for (const m of text.matchAll(/gh_asset\s+([\w.-]+\/[\w.-]+)\s+(?:"([^"]*)"|'([^']*)')/g)) {
    const repo = m[1]!;
    const re = m[2] ?? m[3]!;
    const rel = await release(repo);
    if (!rel) {
      say(s.id, `no latest release on ${repo}`);
      continue;
    }
    const names: string[] = (rel.assets ?? []).map((x: any) => x.name);
    for (const a of arches) {
      const r = subst(re, a);
      if (/\$/.test(r.replace(/\\\$/g, ""))) continue;
      const rx = new RegExp(`^(${r})$`);
      const hit = names.filter((x) => rx.test(x));
      if (!hit.length) say(s.id, `${repo} ${rel.tag_name}: no asset named like ${r} (${a.A})`);
    }
  }
  // apt repositories: the key and the suite's Release file
  for (const m of text.matchAll(/apt_repo\s+\S+\s+"([^"]+)"\s+"deb\s+(?:\[[^\]]*\]\s+)?(\S+)\s+(\S+)/g)) {
    const [key, base, suite] = [subst(m[1]!, arches[0]!), subst(m[2]!, arches[0]!), m[3]!];
    if (literal(key) && !(await answers(key))) say(s.id, `apt key ${key} doesn't answer`);
    const sb = subst(suite, arches[0]!);
    if (literal(base) && literal(sb)) {
      const rel = sb.endsWith("/") ? `${base}/${sb}Release` : `${base}/dists/${sb}/Release`;
      if (!(await answers(rel))) say(s.id, `apt repo ${rel} doesn't answer`);
    }
  }
  // Debian packages, unless a vendor repository of the recipe's own may carry them
  if (!/apt_repo\s/.test(text))
    for (const m of text.matchAll(/apt_get\s+([^\n;&|)]+)/g))
      for (const p of m[1]!.split(/\s+/).filter((x) => x && !x.startsWith("-") && literal(x)))
        if (!(await debPkg(p.replace(/[=:].*$/, "")))) say(s.id, `no Debian ${dist} package ${p}`);
  // literal downloads
  for (const m of text.matchAll(/(?:fetch|unpack|bin_from)\s+"(https:\/\/[^"]+)"/g))
    for (const a of arches) {
      const u = subst(m[1]!, a);
      if (literal(u) && !(await answers(u))) say(s.id, `${u} doesn't answer`);
    }
}
rmSync(tmp, { recursive: true, force: true });
console.log(bad ? `\n${bad} problem${bad === 1 ? "" : "s"}` : "\nall recipes check out");
process.exit(bad ? 1 : 0);
