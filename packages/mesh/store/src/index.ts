// the pretend OS's tree: etc/ and home/ replicated, every host a full copy, each
// file at its newest version by the hybrid clock (hlc.ts); var/ this host's own.
// Peers get every change as it happens over their links, and a full exchange of
// versions when their digests differ (the link lives in peers)

import { createHash } from "node:crypto";
import { type Dirent, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { HomeRoot, Sys } from "@phosphorus/files";
import { logf, markHot, SelfHost, writeFileAtomic } from "@phosphorus/util";
import { ahead as aheadOf, contentHash, newer, sameVer, seen, tick, type Ver, wall } from "./hlc.ts";

export { AheadMs, setClockSkew, type Ver } from "./hlc.ts";
// a stamp too far past this clock to take
export const ahead = (t: unknown) => typeof t === "number" && aheadOf(t);

// in [home] dir's home/, hidden from every user but the admins
export const Root = join(HomeRoot, Sys);

const relRe = /^(etc|home)(\/[a-z0-9][a-z0-9._-]{0,63}){1,5}\.json$/;
// a replicated path
export const validRel = (rel: string) => relRe.test(rel);

// one entry: its version, the content's hash, and data or a tombstone
export type File = Ver & { c: string; gone?: boolean; data?: unknown };
// a version as the stamps map lists it: [t, h, c]
export type Stamp = [number, string, string];

// tombstones kept this long, so a host away for less never brings a file back
export const TombstoneMs = 90 * 24 * 3600 * 1000;
const pruneEveryMs = 24 * 3600 * 1000;

const tree = new Map<string, File>();
const oldest = new Set<string>();
const watchers: ((rel: string) => void)[] = [];
let digestMemo = "";

// --- the log: every change in order, a cursor per peer ---------------------------
// seq runs from 1 per process; a peer with a cursor this log no longer holds gets
// a full exchange instead
const logMax = 10_000;
const log: { seq: number; rel: string }[] = [];
let head = 0;
const deltaFns: ((seq: number) => void)[] = [];
let deltaQueued = false;

// the log's head
export const seq = () => head;

// the files changed after a cursor, as {seq, files}; undefined when the cursor
// fell off the log (or runs ahead of it, another process's)
export function since(cursor: number): { seq: number; files: Record<string, unknown> } | undefined {
  if (cursor > head) return;
  if (cursor < (log[0]?.seq ?? 1) - 1 && cursor < head) return;
  const rels = new Set<string>();
  for (const e of log) if (e.seq > cursor) rels.add(e.rel);
  return { seq: head, files: dump([...rels]) };
}

// every change, batched to one call a macrotask
export const onDelta = (fn: (seq: number) => void) => void deltaFns.push(fn);

function noteChange(rel: string) {
  head++;
  log.push({ seq: head, rel });
  if (log.length > logMax) log.splice(0, log.length - logMax);
  if (deltaQueued) return;
  deltaQueued = true;
  setTimeout(() => {
    deltaQueued = false;
    for (const fn of [...deltaFns]) {
      try {
        fn(head);
      } catch (e) {
        logf("[sys] delta listener: %s", e);
      }
    }
  }, 0);
}

// --- the tree on disk ---------------------------------------------------------------

// a file's JSON as stored: {t, h, c, data} with data present even when null, or a tombstone
const encode = (f: File) =>
  f.gone
    ? `{"t":${f.t},"h":${JSON.stringify(f.h)},"gone":true}`
    : `{"t":${f.t},"h":${JSON.stringify(f.h)},"c":${JSON.stringify(f.c)},"data":${JSON.stringify(f.data ?? null)}}`;

// a stored or received entry; the shape before versions ({at, data}) read as
// stamped by nobody, rewritten on its next write
function parseFile(v: unknown): File | undefined {
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  const t = typeof o.t === "number" ? o.t : typeof o.at === "number" ? o.at : NaN;
  if (!Number.isFinite(t) || aheadOf(t)) return;
  const h = typeof o.h === "string" ? o.h : "";
  // a tombstone past its keep is never taken back, from a peer or the disk
  if (o.gone === true) return wall() - t >= TombstoneMs ? undefined : { t, h, c: "", gone: true };
  if (!("data" in o)) return;
  const c = typeof o.c === "string" && o.c ? o.c : contentHash(o.data);
  return { t, h, c, data: o.data };
}

function load(dir: string, rel: string) {
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (r !== "var") load(join(dir, e.name), r);
    } else if (relRe.test(r)) {
      try {
        const f = parseFile(JSON.parse(readFileSync(join(dir, e.name), "utf8")));
        if (f) {
          tree.set(r, f);
          seen(f.t);
        }
      } catch {}
    }
  }
}

function put(rel: string, f: File) {
  tree.set(rel, f);
  digestMemo = "";
  seen(f.t);
  for (const w of [...watchers]) {
    try {
      w(rel);
    } catch (e) {
      logf("[sys] watcher on %s: %s", rel, e);
    }
  }
  noteChange(rel);
  markHot();
  const abs = join(Root, rel);
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  writeFileAtomic(abs, encode(f));
}

const live = (f: File | undefined) => !!f && !f.gone && f.data !== undefined && f.data !== null;

// a live file's data, undefined when absent or gone
export function read<T = any>(rel: string): T | undefined {
  const f = tree.get(rel);
  return live(f) ? (f!.data as T) : undefined;
}

// a file written, the oldest-wins ones never overwritten
export function write(rel: string, data: unknown) {
  if (!relRe.test(rel)) throw new Error(`bad sys path ${rel}`);
  if (oldest.has(rel) && read(rel) !== undefined) return;
  const copy = JSON.parse(JSON.stringify(data ?? null));
  put(rel, { t: tick(tree.get(rel)?.t), h: SelfHost, c: contentHash(copy), data: copy });
}

// a live file removed, a tombstone left
export function remove(rel: string) {
  if (read(rel) !== undefined) put(rel, { t: tick(tree.get(rel)?.t), h: SelfHost, c: "", gone: true });
}

// live files under a dir, rel to it
export function list(dir: string): string[] {
  const pre = `${dir}/`;
  return [...tree]
    .filter(([r, f]) => r.startsWith(pre) && live(f))
    .map(([r]) => r.slice(pre.length))
    .sort();
}

// a file's stamp, 0 when absent
export const stamp = (rel: string) => tree.get(rel)?.t ?? 0;

// every rel and its version
export const stamps = (): Record<string, Stamp> => Object.fromEntries([...tree].map(([r, f]) => [r, [f.t, f.h, f.c]]));

// every rel, version and content hash in one hash: two trees alike in every byte
// that matters hash the same
export function digest(): string {
  if (!digestMemo) {
    const h = createHash("sha256");
    for (const r of [...tree.keys()].sort()) {
      const f = tree.get(r)!;
      h.update(`${r}\t${f.t}\t${f.h}\t${f.c}\n`);
    }
    digestMemo = h.digest("hex").slice(0, 32);
  }
  return digestMemo;
}

// the whole tree, or only the files asked for, each as stored
export function dump(rels?: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of rels ?? tree.keys()) {
    const f = tree.get(r);
    if (f) out[r] = JSON.parse(encode(f));
  }
  return out;
}

// --- merging ----------------------------------------------------------------------

// a version from elsewhere that should replace what's here
function wins(rel: string, v: Ver, c: string): boolean {
  const cur = tree.get(rel);
  if (!cur) return true;
  if (oldest.has(rel) && live(cur)) return newer(cur, v);
  if (newer(v, cur)) return true;
  // the same version with different content: the higher hash, everywhere alike
  return sameVer(v, cur) && c !== cur.c && c > cur.c;
}

// a peer's files merged, true when anything changed
export function merge(got: Record<string, unknown>): boolean {
  let changed = false;
  for (const rel of Object.keys(got).sort()) {
    const f = parseFile(got[rel]);
    if (!relRe.test(rel) || !f || !wins(rel, f, f.c)) continue;
    put(rel, f);
    changed = true;
  }
  return changed;
}

// of a peer's versions, the rels worth fetching, and how many were stamped too
// far ahead of this clock to take
export function wanted(st: Record<string, unknown>): { rels: string[]; ahead: number } {
  const rels: string[] = [];
  let far = 0;
  for (const [rel, v] of Object.entries(st)) {
    if (!relRe.test(rel) || !Array.isArray(v) || typeof v[0] !== "number" || !Number.isFinite(v[0])) continue;
    const ver: Ver = { t: v[0], h: typeof v[1] === "string" ? v[1] : "" };
    const c = typeof v[2] === "string" ? v[2] : "";
    if (c === "" && wall() - ver.t >= TombstoneMs) continue;
    if (!wins(rel, ver, c)) continue;
    if (aheadOf(ver.t)) far++;
    else rels.push(rel);
  }
  return { rels: rels.sort(), ahead: far };
}

const aheadAt = new Map<string, number>();
// a slow clock's skipped files noted, once in ten minutes per host
export function aheadLog(host: string, n: number) {
  if (wall() - (aheadAt.get(host) ?? 0) < 10 * 60 * 1000) return;
  aheadAt.set(host, wall());
  logf("[sys] %d files from %s stamped over a minute ahead of this clock, skipped until it's set right", n, host);
}

// --- tombstones ---------------------------------------------------------------------

// tombstones past their keep dropped, from the tree and the disk
export function prune(now = wall()) {
  for (const [rel, f] of [...tree]) {
    if (!f.gone || now - f.t < TombstoneMs) continue;
    tree.delete(rel);
    digestMemo = "";
    rmSync(join(Root, rel), { force: true });
  }
}

// --- the host's own, and the sync's seams -------------------------------------------

// var/<rel>: this host's own
export function local(rel: string): string {
  const abs = join(Root, "var", rel);
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  return abs;
}

let syncer: () => Promise<void> = async () => {};
// peers' full exchange with every linked host, run by pull()
export const setSyncer = (fn: () => Promise<void>) => void (syncer = fn);

let pulling: Promise<void> | undefined;
// every peer brought level, one pull at a time
export function pull(): Promise<void> {
  return (pulling ??= syncer().finally(() => (pulling = undefined)));
}

// a path whose first write stays
export const oldestWins = (rel: string) => void oldest.add(rel);

// every change, local or a peer's
export const watch = (fn: (rel: string) => void) => void watchers.push(fn);

let started = false;
// the tree loaded and pruned, pruned again daily
export function start() {
  if (started) return;
  started = true;
  load(Root, "");
  prune();
  setInterval(prune, pruneEveryMs);
}

// loaded without the loops, for tests and the cli
export const loadTree = () => load(Root, "");

// tests: the tree emptied
export function reset() {
  tree.clear();
  oldest.clear();
  log.length = 0;
  head = 0;
  digestMemo = "";
}
