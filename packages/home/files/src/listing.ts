// listing, tree and search
import { type Stats } from "node:fs";
import { lstat, opendir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { localeCompare } from "@phosphorus/util";
import { errBody, maxEntries, type Res, type Share, splitList, treeDepthMax, uploadTmp } from "./index.ts";
import { badPath, type Entry, relOf, safePath } from "./paths.ts";
import { looksBinary } from "./read.ts";
import { can, isHome } from "./shares.ts";

export async function isEmptyDir(abs: string): Promise<boolean | undefined> {
  try {
    const d = await opendir(abs);
    const first = await d.read();
    await d.close();
    return first === null;
  } catch {
    return undefined;
  }
}

export async function entryOf(dir: string, name: string): Promise<Entry | undefined> {
  const abs = join(dir, name);
  let lst: Stats;
  try {
    lst = await lstat(abs);
  } catch {
    return;
  }
  const link = lst.isSymbolicLink();
  let target: Stats | undefined = lst;
  if (link) target = await stat(abs).catch(() => undefined);
  const e: Entry = { name, dir: !!target?.isDirectory(), link, size: null, mtime: null };
  if (e.dir && !link) {
    const empty = await isEmptyDir(abs);
    if (empty !== undefined) e.empty = empty;
  }
  if (target?.isFile()) e.size = target.size;
  if (target) e.mtime = Math.round(target.mtimeMs);
  return e;
}

// each name's entry, a bounded number of stats at once
export async function entriesOf(dir: string, names: string[]): Promise<Entry[]> {
  const out: (Entry | undefined)[] = new Array(names.length);
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const i = next++;
      out[i] = await entryOf(dir, names[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(64, names.length) }, worker));
  return out.filter((e): e is Entry => !!e);
}

// a folder's entries, folders first
export async function list(sh: Share | undefined, rel: string): Promise<Res> {
  if (!sh || !can(sh, "r")) return [403, errBody("this share is not readable")];
  const abs = safePath(sh, rel, true);
  if (!abs) return badPath(sh, rel, true);
  let names: string[];
  try {
    names = await readdir(abs);
  } catch (e: any) {
    if (e?.code === "ENOENT") return [404, errBody("no such directory")];
    if (e?.code === "ENOTDIR") return [400, errBody("not a directory")];
    return [500, errBody(e?.message ?? String(e))];
  }
  const kept = names.filter((n) => !n.startsWith(uploadTmp) && (sh.id === "home" || !isHome(join(abs, n))));
  const entries = await entriesOf(abs, kept.slice(0, maxEntries));
  entries.sort((a, b) => (a.dir === b.dir ? localeCompare(a.name, b.name) : a.dir ? -1 : 1));
  return [200, { path: relOf(sh, abs), truncated: kept.length > maxEntries, entries }];
}

// a glob as a case-insensitive whole-name regexp: * any run, ? one
export function globRe(g: string): RegExp {
  const src = [...g]
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  try {
    return new RegExp(`^${src}$`, "i");
  } catch {
    return /^$/;
  }
}

// a tree's entries at most
export let TreeMax = 2000;
export const setTreeMax = (n: number) => void (TreeMax = n);

// whether a folder's name is one of skip's (names, or globs as *.egg-info):
// neither listed nor gone into, a build's outputs kept out of a big project's tree
export function skipper(skip: string): (name: string) => boolean {
  const res = splitList(skip).map(globRe);
  return (name) => res.some((re) => re.test(name));
}

// Number(v) as JS does it
export const jsNumber = (v: unknown) => (v === undefined ? NaN : Number(v));

// the folders and files under rel, breadth first; skip's folders left out
export async function tree(
  sh: Share | undefined,
  rel: string,
  depth: unknown,
  match: string,
  ...skip: string[]
): Promise<Res> {
  if (!sh || !can(sh, "r")) return [403, errBody("this share is not readable")];
  const root = safePath(sh, rel, true);
  if (!root) return badPath(sh, rel, true);
  try {
    if (!(await stat(root)).isDirectory()) return [400, errBody("not a directory")];
  } catch {
    return [404, errBody("no such directory")];
  }
  const want = match ? globRe(match) : undefined;
  const d = Math.trunc(jsNumber(depth)) || 0;
  const maxDepth = Math.min(Math.max(d, 1), treeDepthMax);
  const skipped = skipper(skip.join(","));
  const out: Record<string, unknown>[] = [];
  let truncated = false;
  let level = [root];
  for (let lv = 1; lv <= maxDepth && level.length && !truncated; lv++) {
    const next: string[] = [];
    for (const dir of level) {
      let ns: string[];
      try {
        ns = await readdir(dir);
      } catch {
        continue;
      }
      const names = ns
        .filter((n) => !n.startsWith(uploadTmp) && (sh.id === "home" || !isHome(join(dir, n))))
        .sort(localeCompare);
      for (const e of await entriesOf(dir, names)) {
        if (e.dir && skipped(e.name)) continue;
        const rp = relOf(sh, join(dir, e.name));
        if (e.dir && !e.link) next.push(join(dir, e.name));
        if (want && !want.test(e.name)) continue;
        if (out.length >= TreeMax) {
          truncated = true;
          break;
        }
        out.push(e.dir ? { path: rp + "/", mtime: e.mtime } : { path: rp, size: e.size ?? undefined, mtime: e.mtime });
      }
      if (truncated) break;
    }
    level = next;
  }
  return [200, { path: relOf(sh, root), depth: maxDepth, entries: out, ...(truncated ? { truncated: true } : {}) }];
}

export const searchMax = 200;
export const searchScanMax = 50000;
export const searchFileMax = 1 << 20;
export const searchPerFile = 5;
export const searchLineClip = 240;

// names, or with content the text inside, holding query, case-insensitive,
// under rel; glob narrows the names looked at, skip's folders left out
export async function search(
  sh: Share | undefined,
  rel: string,
  query: string,
  content: boolean,
  glob: string,
  ...skip: string[]
): Promise<Res> {
  if (!sh || !can(sh, "r")) return [403, errBody("this share is not readable")];
  const root = safePath(sh, rel, true);
  if (!root) return badPath(sh, rel, true);
  const q = query.trim().toLowerCase();
  if (!q && !glob) return [400, errBody("a query or a glob")];
  const want = glob ? globRe(glob) : undefined;
  const skipped = skipper(skip.join(","));
  const out: Record<string, unknown>[] = [];
  let scanned = 0;
  let truncated = false;
  // depth first in name order, as filepath.WalkDir
  const walk = async (dir: string): Promise<boolean> => {
    let ents;
    try {
      ents = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );
    } catch {
      return true;
    }
    for (const d of ents) {
      const p = join(dir, d.name);
      const isDir = d.isDirectory();
      if (d.name.startsWith(uploadTmp) || (sh.id !== "home" && isHome(p)) || (isDir && skipped(d.name))) continue;
      if (++scanned > searchScanMax || out.length >= searchMax) {
        truncated = true;
        return false;
      }
      const matches = !want || want.test(d.name);
      let rp = relOf(sh, p);
      if (matches && (!content || isDir)) {
        if (!content && (!q || d.name.toLowerCase().includes(q))) out.push({ path: isDir ? rp + "/" : rp });
      } else if (matches && d.isFile()) {
        try {
          const st = await stat(p);
          if (st.size <= searchFileMax) {
            const b = await readFile(p);
            if (!looksBinary(b)) {
              const hits: { line: number; text: string }[] = [];
              const lines = b.toString("utf8").split("\n");
              for (let i = 0; i < lines.length && hits.length < searchPerFile; i++) {
                let line = lines[i]!;
                if (!line.toLowerCase().includes(q)) continue;
                const r = [...line.trim()];
                line = r.length > searchLineClip ? r.slice(0, searchLineClip).join("") + "…" : line;
                hits.push({ line: i + 1, text: line.trim() });
              }
              if (hits.length) out.push({ path: rp, matches: hits });
            }
          }
        } catch {}
      }
      if (isDir && !(await walk(p))) return false;
    }
    return true;
  };
  await walk(root);
  return [200, { path: relOf(sh, root), results: out, ...(truncated ? { truncated: true } : {}) }];
}
