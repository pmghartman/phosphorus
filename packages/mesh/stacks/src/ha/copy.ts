// a stack's data copied between hosts: the active keeps a consistent snapshot
// beside data/ (only changed files copied, off the event loop into a staging
// folder, then all renamed into place at once, so a reader never sees one
// half-written nor a snapshot half-moved), a manifest naming each file's
// version; a standby rebuilds each file whose version moved from chunks it already
// holds, fetching only those it lacks, then hard-links that tree into its copy once
// a pull lands whole under one token. Promotion moves the copy into data/.

import {
  type BigIntStats,
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type ChunkList, Chunks, cleanRel, type Fetch, rebuild, versionOf } from "@phosphorus/delta";
import { marshal, readJSON, writeFileAtomic } from "@phosphorus/util";

// one entry of a tree: f a file, d a directory, l a link to l; v the file's
// version on the serving side (its snapshot inode), sig its source's on the active
export type Entry = {
  p: string;
  t: "f" | "d" | "l";
  s: number;
  m: number;
  mode: number;
  uid: number;
  gid: number;
  l?: string;
  v?: string;
};

// a snapshot as the active offers it: token new on each change, gen and stamp
// the data's version, app the want gen the active runs
export type Manifest = { token: string; gen: number; stamp: number; app: number; files: Entry[] };

// where one stack's failover state lives, beside its data
export function paths(data: string) {
  const base = dirname(data);
  const ha = join(base, "ha");
  return {
    base,
    data,
    ha,
    snap: join(ha, "snap"),
    snapJSON: join(ha, "snap.json"),
    // each snapshotted file's source version, so a restart or a new term copies only what moved
    sigJSON: join(ha, "sig.json"),
    // the snapshot's and the pull's chunk lists by file version, nothing cut twice
    snapChunks: join(ha, "snap-chunks.json"),
    pullChunks: join(ha, "pull-chunks.json"),
    // the files a snapshot copied, before they're swapped in
    stage: join(ha, "stage"),
    pull: join(ha, "pull"),
    pullJSON: join(ha, "pull.json"),
    copy: join(ha, "copy"),
    copyJSON: join(ha, "copy.json"),
    version: join(ha, "version"),
    // the gen this host last led at, cleared once its data is set aside
    led: join(ha, "led"),
  };
}
export type Paths = ReturnType<typeof paths>;

const rmrf = (p: string) => rmSync(p, { recursive: true, force: true });
const safe = (fn: () => void) => {
  try {
    fn();
  } catch {}
};

// every entry under root, parents first, relative posix paths
export function walk(root: string): Entry[] {
  const out: Entry[] = [];
  const go = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const n of names) {
      const p = rel ? `${rel}/${n}` : n;
      let s: BigIntStats;
      try {
        s = lstatSync(join(root, p), { bigint: true }) as BigIntStats;
      } catch {
        continue;
      }
      const e: Entry = {
        p,
        t: "f",
        s: Number(s.size),
        m: Number(s.mtimeMs),
        mode: Number(s.mode) & 0o7777,
        uid: Number(s.uid),
        gid: Number(s.gid),
        v: `${s.ino}:${s.mtimeNs}:${s.size}`,
      };
      if (s.isDirectory()) {
        e.t = "d";
        e.s = 0;
        out.push(e);
        go(p);
      } else if (s.isSymbolicLink()) {
        e.t = "l";
        e.l = readlinkSync(join(root, p));
        out.push(e);
      } else if (s.isFile()) out.push(e);
    }
  };
  go("");
  return out;
}

// a tree's signature: what changed since, without reading a byte
export const signature = (es: Entry[]) => marshal(es.map((e) => [e.p, e.t, e.v, e.l ?? "", e.mode]));

const own = (file: string, e: Entry) => {
  safe(() => chownSync(file, e.uid, e.gid));
};

// mode and times as e has them, ownership where this process may set it
function stamp(file: string, e: Entry) {
  if (e.t !== "l") {
    safe(() => chmodSync(file, e.mode));
    safe(() => utimesSync(file, e.m / 1000, e.m / 1000));
  }
  own(file, e);
}

// entries under dst not in want, deepest first
function prune(dst: string, have: Map<string, Entry>, want: Set<string>) {
  for (const p of [...have.keys()].sort().reverse()) if (!want.has(p)) safe(() => rmrf(join(dst, p)));
}

// a link or directory brought to e's shape at file
function place(file: string, e: Entry, had?: Entry) {
  if (e.t === "d") {
    if (had && had.t !== "d") rmrf(file);
    mkdirSync(file, { recursive: true });
    stamp(file, e);
  } else if (e.t === "l") {
    if (had?.t === "l" && had.l === e.l) return;
    if (had) rmrf(file);
    symlinkSync(e.l!, file);
    own(file, e);
  }
}

// data/ mirrored into the snapshot in two steps: the changed files copied into
// stage off the event loop, however long that takes, then commit swapping them
// in with no await between, its caller offering the snapshot in the same turn;
// commit true when anything moved
export async function mirror(
  src: string,
  dst: string,
  stage: string,
  sigs: Record<string, string>,
): Promise<() => boolean> {
  mkdirSync(dst, { recursive: true });
  rmrf(stage);
  mkdirSync(stage, { recursive: true });
  const from = walk(src);
  const have = new Map(walk(dst).map((e) => [e.p, e]));
  const staged = new Map<string, string>();
  for (const e of from) {
    if (e.t !== "f") continue;
    const had = have.get(e.p);
    if (had?.t === "f" && sigs[e.p] === e.v) continue;
    const tmp = join(stage, String(staged.size));
    try {
      await copyFile(join(src, e.p), tmp);
      stamp(tmp, e);
      staged.set(e.p, tmp);
    } catch {
      safe(() => rmSync(tmp, { force: true }));
    }
  }
  return () => {
    let moved = false;
    const keep = new Set<string>();
    for (const e of from) {
      keep.add(e.p);
      const file = join(dst, e.p);
      const had = have.get(e.p);
      if (e.t !== "f") {
        if (!had || had.t !== e.t || had.l !== e.l) moved = true;
        place(file, e, had);
        continue;
      }
      const tmp = staged.get(e.p);
      if (!tmp) continue;
      try {
        if (had && had.t !== "f") rmrf(file);
        renameSync(tmp, file);
        sigs[e.p] = e.v!;
        moved = true;
      } catch {}
    }
    for (const p of Object.keys(sigs)) if (!keep.has(p)) delete sigs[p];
    if ([...have.keys()].some((p) => !keep.has(p))) moved = true;
    prune(dst, have, keep);
    rmrf(stage);
    return moved;
  };
}

// what a standby asks of the active: chunk lists for the files that moved, chunks by name
export type Remote = {
  lists(paths: string[]): Promise<Record<string, ChunkList> | undefined>;
  blocks: Fetch;
};

// another folder whose chunks are taken rather than fetched (this host's own last snapshot),
// the bytes of the files rebuilt so far, and the bytes fetched
export type PullOpts = {
  seed?: Chunks;
  progress?: (done: number, total: number) => void;
  fetched?: (bytes: number) => void;
};

// lists asked this many files at a time
const listBatch = 64;

// the manifest's files brought into dst, each one whose version moved rebuilt from chunks
// already here, only the missing ones fetched; versions held in index; false when any failed
export async function pullInto(
  dst: Chunks,
  man: Manifest,
  index: Record<string, string>,
  remote: Remote,
  o: PullOpts = {},
): Promise<boolean> {
  const root = dst.root;
  mkdirSync(root, { recursive: true });
  const have = new Map(walk(root).map((e) => [e.p, e]));
  const keep = new Set<string>();
  const todo: Entry[] = [];
  for (const e of man.files) {
    const p = cleanRel(e.p);
    if (!p) return false;
    keep.add(p);
    const had = have.get(p);
    if (e.t !== "f") {
      place(join(root, p), e, had);
      continue;
    }
    if (had?.t === "f" && index[p] === e.v) continue;
    todo.push(e);
  }
  let ok = true;
  const total = todo.reduce((n, e) => n + e.s, 0);
  let done = 0;
  o.progress?.(0, total);

  const one = async (e: Entry, l: ChunkList): Promise<boolean> => {
    const file = join(root, e.p);
    // the file's own last version cut here when it never was: where its chunks most likely are
    if (have.get(e.p)?.t === "f") await dst.list(e.p);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = join(dirname(file), `.phos-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
    try {
      if (!(await rebuild(tmp, l.c, o.seed ? [dst, o.seed] : [dst], remote.blocks, o.fetched))) return false;
      stamp(tmp, e);
      const had = have.get(e.p);
      if (had && had.t !== "f") rmrf(file);
      renameSync(tmp, file);
      index[e.p] = e.v ?? "";
      const v = versionOf(file);
      if (v) dst.set(e.p, v, l.c);
      return true;
    } catch {
      return false;
    } finally {
      safe(() => rmSync(tmp, { force: true }));
    }
  };

  for (let i = 0; i < todo.length && ok; i += listBatch) {
    const batch = todo.slice(i, i + listBatch);
    const lists = await remote.lists(batch.map((e) => e.p));
    if (!lists) ok = false;
    for (const e of lists ? batch : []) {
      const l = lists![e.p];
      // the active's file moved past the manifest: the next pull takes it
      if (!l || l.v !== e.v || !(await one(e, l))) ok = false;
      done += e.s;
      o.progress?.(done, total);
    }
  }
  for (const p of Object.keys(index)) if (!keep.has(p)) delete index[p];
  dst.forget(keep);
  prune(root, have, keep);
  return ok;
}

// src's tree as hard links at dst, swapped in whole: files in a pull are only
// ever replaced, never written in place, so the links stay what they were
export function linkTree(src: string, dst: string) {
  const next = `${dst}.next`;
  rmrf(next);
  mkdirSync(next, { recursive: true });
  for (const e of walk(src)) {
    const file = join(next, e.p);
    if (e.t === "f") linkSync(join(src, e.p), file);
    else place(file, e);
  }
  const old = `${dst}.old`;
  rmrf(old);
  if (existsSync(dst)) renameSync(dst, old);
  renameSync(next, dst);
  rmrf(old);
}

// the copy made the live data: the old data set aside as orphan, or dropped
export function install(p: Paths, orphan?: string) {
  if (!existsSync(p.copy)) return false;
  if (existsSync(p.data)) {
    if (orphan) renameSync(p.data, orphan);
    else {
      rmrf(`${p.data}.old`);
      renameSync(p.data, `${p.data}.old`);
    }
  }
  renameSync(p.copy, p.data);
  rmrf(`${p.data}.old`);
  rmrf(p.pull);
  for (const f of [p.pullJSON, p.pullChunks, p.copyJSON]) safe(() => rmSync(f, { force: true }));
  return true;
}

// data.orphan-<gen>, newest kept: older ones pruned past keep
export function orphan(p: Paths, gen: number, keep = 3): string {
  let name = `${p.data}.orphan-${gen}`;
  for (let i = 2; existsSync(name); i++) name = `${p.data}.orphan-${gen}.${i}`;
  if (existsSync(p.data)) renameSync(p.data, name);
  mkdirSync(p.data, { recursive: true });
  const re = /^data\.orphan-(\d+)(?:\.(\d+))?$/;
  const all = readdirSync(p.base)
    .map((n) => [n, re.exec(n)] as const)
    .filter((x) => x[1])
    .sort((a, b) => Number(b[1]![1]) - Number(a[1]![1]) || Number(b[1]![2] ?? 1) - Number(a[1]![2] ?? 1));
  for (const [n] of all.slice(keep)) safe(() => rmrf(join(p.base, n)));
  return name;
}

// "<gen> <stamp>", the data's version
export function readVersion(file: string): { gen: number; stamp: number } | undefined {
  try {
    const m = /^(\d+) (\d+)/.exec(readFileSync(file, "utf8"));
    if (m) return { gen: Number(m[1]), stamp: Number(m[2]) };
  } catch {}
  return;
}

export function writeVersion(file: string, gen: number, stamp: number) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${gen} ${stamp}\n`);
}

export const readMap = (file: string): Record<string, string> => {
  const v = readJSON(file);
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
};

export const writeJSON = (file: string, v: unknown) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, marshal(v));
};
