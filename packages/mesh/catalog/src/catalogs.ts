// the catalogues: each one tarball off GitHub's codeload, read as it streams in, only
// its index kept under state/catalogs/<source>/; asked again at most daily with its
// ETag; a failed fetch keeps the last good index
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { errText, logf, now, readJSON, StateDir, writeJSONAtomic } from "@phosphorus/util";
import type { AppDef, AppSummary, SourceInfo, TreeEntry } from "@phosphorus/wire";
import { casaos } from "./adapters/casaos.ts";
import { type Adapter, Skip } from "./adapters/common.ts";
import { cosmos } from "./adapters/cosmos.ts";
import { runtipi } from "./adapters/runtipi.ts";
import * as featured from "./featured.ts";
import type { Fetch } from "./registry.ts";
import { entries } from "./tar.ts";

export const adapters: Adapter[] = [casaos, runtipi, cosmos];

const DayMS = 24 * 3600 * 1000;
// bumped when the adapters change what they make of a tarball
const IndexV = 1;

export interface Index {
  v: number;
  etag: string;
  apps: AppDef[];
  // apps left out, and why
  skipped: { ref: string; why: string }[];
  // each app's folder as the page lists it
  trees: Record<string, TreeEntry[]>;
}

interface Meta {
  etag?: string;
  lastModified?: string;
  // the last good fetch, and the last time asked
  fetchedAt: number;
  checkedAt: number;
  error?: string;
}

let root = join(StateDir, "catalogs");
let fetcher: Fetch = (url, init) => fetch(url, init);
// where each catalogue's tarball comes from, codeload unless a test says
let urlOf = (a: Adapter) => `https://codeload.github.com/${a.repo}/tar.gz/HEAD`;

// for tests: another folder, fetch and url
export function setup(o: { root?: string; fetch?: Fetch; url?: (a: Adapter) => string }) {
  if (o.root) root = o.root;
  if (o.fetch) fetcher = o.fetch;
  if (o.url) urlOf = o.url;
  indexes.clear();
  metas.clear();
  merged = undefined;
}

const dirOf = (a: Adapter) => join(root, a.id);
const indexes = new Map<string, Index>();
const metas = new Map<string, Meta>();
const busy = new Map<string, Promise<void>>();

function meta(a: Adapter): Meta {
  let m = metas.get(a.id);
  if (!m) {
    m = readJSON<Meta>(join(dirOf(a), "meta.json")) ?? { fetchedAt: 0, checkedAt: 0 };
    metas.set(a.id, m);
  }
  return m;
}

function saveMeta(a: Adapter, m: Meta) {
  metas.set(a.id, m);
  mkdirSync(dirOf(a), { recursive: true });
  writeJSONAtomic(join(dirOf(a), "meta.json"), m);
}

// a tarball's apps, as its adapter makes them
export async function build(a: Adapter, gz: ReadableStream<Uint8Array>, etag = ""): Promise<Index> {
  const files = new Map<string, Record<string, string>>();
  const trees: Record<string, TreeEntry[]> = {};
  for await (const e of entries(gz, (p) => {
    const at = a.split(p);
    return !!at && a.wants(at[1]);
  })) {
    const at = a.split(e.path);
    if (!at) continue;
    const [ref, rel] = at;
    (trees[ref] ??= []).push(e.dir ? { path: rel, type: "dir" } : { path: rel, type: "file", size: e.size });
    if (e.data) (files.get(ref) ?? files.set(ref, {}).get(ref)!)[rel] = Buffer.from(e.data).toString("utf8");
  }
  const apps: AppDef[] = [];
  const skipped: Index["skipped"] = [];
  for (const ref of Object.keys(trees).sort()) {
    try {
      apps.push(a.adapt(ref, files.get(ref) ?? {}));
    } catch (e) {
      skipped.push({ ref, why: e instanceof Skip ? e.message : `can't read it: ${errText(e)}` });
    }
  }
  return { v: IndexV, etag, apps, skipped, trees };
}

function load(a: Adapter): Index | undefined {
  let ix = indexes.get(a.id);
  if (!ix) {
    ix = readJSON<Index>(join(dirOf(a), "index.json"));
    if (ix && ix.v === IndexV) indexes.set(a.id, ix);
    else ix = undefined;
  }
  return ix;
}

// the catalogue fetched again when a day old (or force), its index rebuilt when
// the tarball changed or the adapters did
export function refresh(a: Adapter, force = false): Promise<void> {
  const cur = busy.get(a.id);
  if (cur) return cur;
  const p = (async () => {
    const m = meta(a);
    // an older release's kept tarball, never read again
    rmSync(join(dirOf(a), "catalog.tar.gz"), { force: true });
    const ix = load(a);
    if (!force && ix && now() - m.checkedAt < DayMS) return;
    const next: Meta = { ...m, checkedAt: now() };
    try {
      const h: Record<string, string> = {};
      if (ix && m.etag) h["If-None-Match"] = m.etag;
      if (ix && m.lastModified) h["If-Modified-Since"] = m.lastModified;
      const res = await fetcher(urlOf(a), { headers: h });
      if (res.status === 304) delete next.error;
      else if (res.ok && res.body) {
        const etag = res.headers.get("etag") ?? undefined;
        const built = await build(a, res.body, etag ?? "");
        mkdirSync(dirOf(a), { recursive: true });
        writeJSONAtomic(join(dirOf(a), "index.json"), built);
        indexes.set(a.id, built);
        merged = undefined;
        next.etag = etag;
        next.lastModified = res.headers.get("last-modified") ?? undefined;
        next.fetchedAt = now();
        delete next.error;
        logf("[catalog] %s: %d apps, %d skipped", a.id, built.apps.length, built.skipped.length);
      } else throw new Error(`${urlOf(a)}: HTTP ${res.status}`);
    } catch (e) {
      next.error = `couldn't fetch: ${errText(e)}`;
      logf("[catalog] %s: %s", a.id, next.error);
    }
    saveMeta(a, next);
  })().finally(() => busy.delete(a.id));
  busy.set(a.id, p);
  return p;
}

export const refreshAll = (force = false) => Promise.all(adapters.map((a) => refresh(a, force)));

export function sources(): SourceInfo[] {
  return [
    featured.source,
    ...adapters.map((a) => {
      const m = meta(a);
      const s: SourceInfo = {
        id: a.id,
        name: a.name,
        repo: `https://github.com/${a.repo}`,
        licence: a.licence,
        apps: load(a)?.apps.length ?? 0,
        fetchedAt: m.fetchedAt,
      };
      if (m.error) s.error = m.error;
      return s;
    }),
  ];
}

// every source's apps, phosphorus's own first, an id taken by an earlier source
// prefixed with the later's
let merged: AppDef[] | undefined;
export function all(): AppDef[] {
  if (merged) return merged;
  const out: AppDef[] = [...featured.apps];
  const taken = new Set(out.map((d) => d.id));
  for (const a of adapters)
    for (const d of load(a)?.apps ?? []) {
      let id = d.id;
      if (taken.has(id)) id = `${a.id}-${id}`.slice(0, 40).replace(/-+$/, "");
      if (taken.has(id)) continue;
      taken.add(id);
      out.push(id === d.id ? d : { ...d, id });
    }
  merged = out;
  return out;
}

export const find = (source: string, ref: string) => all().find((d) => d.source === source && d.ref === ref);

export function tree(source: string, ref: string): TreeEntry[] {
  if (source === "phosphorus") return featured.tree(ref);
  const a = adapters.find((a) => a.id === source);
  return (a && load(a)?.trees[ref]) || [];
}

export const summary = (d: AppDef): AppSummary => ({
  id: d.id,
  source: d.source,
  ref: d.ref,
  name: d.name,
  tagline: d.tagline,
  icon: d.icon,
  category: d.category,
  licence: d.licence,
});

// apps matching every word of q over name, tagline and category
export function search(o: { q?: string; source?: string; category?: string }): AppDef[] {
  const words = (o.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const cat = (o.category ?? "").toLowerCase();
  return all()
    .filter((d) => !o.source || d.source === o.source)
    .filter((d) => !cat || d.category === cat)
    .filter((d) => {
      const hay = `${d.name} ${d.tagline} ${d.category} ${d.id}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
