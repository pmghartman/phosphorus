// one home on every host: each host's index of its own, path -> version by the
// store's hybrid clock, content hash and size, or a tombstone. A peer's newer
// entries merged in, the bytes fetched from it or copied from a file here with
// the same hash; two edits neither saw the other of: the newest in place, the
// other kept beside it as "name (conflict <host> <date>).ext"
import { createHash } from "node:crypto";
import type { EventEmitter } from "node:events";
import {
  type Dirent,
  existsSync,
  watch as fsWatch,
  lstatSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
} from "node:fs";
import { open, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { adopt, mkdirAll, ownerAt, Trash, uploadTmp } from "@phosphorus/files";
import { hlc } from "@phosphorus/store";
import { logf, writeFileAtomic } from "@phosphorus/util";

// tombstones kept this long, so a host away for less never brings a file back
export const TombstoneMs = 90 * 24 * 3600 * 1000;
// earlier contents a version remembers, to tell an edit made on top of another from a clash
const ancestry = 8;
const dirC = "dir";
const scanEveryMs = 5 * 60 * 1000;
const watchSettleMs = 300;
const saveSettleMs = 1000;

// one path's version: t, h the clock's; c the content's hash ("dir" a folder, "" gone);
// s its size; a the hashes it replaced, newest first
export type Rec = { t: number; h: string; c: string; s: number; d?: true; gone?: true; a?: string[] };
// as held here: the mtime it was hashed at, a change noticed without rereading it
type Ent = Rec & { m?: number };

// a version's bytes from the host that sent it
export type Source = (
  host: string,
  rel: string,
) => Promise<{ body: ReadableStream<Uint8Array>; size: number } | undefined>;

const relOk = (rel: string) =>
  !!rel &&
  !rel.includes("\\") &&
  !rel.includes("\0") &&
  rel.split("/").every((p) => p !== "" && p !== "." && p !== "..");

// what the home keeps to each host: trash, half-written uploads
export function skipped(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((p) => p.toLowerCase() === Trash)) return true;
  // shim for one release: the store's old folder, dropped on start, never taken back
  if (parts[0] === ".sys" || parts[1] === ".sys") return true;
  return parts[parts.length - 1]!.startsWith(uploadTmp);
}

// a's version past b's: the clock, then the content's hash, alike on every host
const wins = (a: Rec, b: Rec | undefined) => !b || hlc.newer(a, b) || (hlc.sameVer(a, b) && a.c !== b.c && a.c > b.c);

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

// "name (conflict host date).ext", a number added while that's taken
export function conflictName(rel: string, host: string, t: number, taken: (rel: string) => boolean): string {
  const dir = dirname(rel) === "." ? "" : `${dirname(rel)}/`;
  const name = basename(rel);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 1; ; i++) {
    const r = `${dir}${stem} (conflict ${host} ${day(t)}${i > 1 ? ` ${i}` : ""})${ext}`;
    if (!taken(r)) return r;
  }
}

export async function hashFile(abs: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of Bun.file(abs).stream()) h.update(chunk);
  return h.digest("hex").slice(0, 32);
}

function parseRec(v: unknown): Rec | undefined {
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (typeof o.t !== "number" || !Number.isFinite(o.t) || typeof o.h !== "string" || typeof o.c !== "string") return;
  const r: Rec = { t: o.t, h: o.h, c: o.c, s: typeof o.s === "number" && o.s >= 0 ? o.s : 0 };
  if (o.d === true) r.d = true;
  if (o.gone === true) r.gone = true;
  else if (!r.c) return;
  if (Array.isArray(o.a)) r.a = o.a.filter((x): x is string => typeof x === "string").slice(0, ancestry);
  return r;
}

// a version as sent: without what only this host needs
const wire = ({ m: _, ...r }: Ent): Rec => r;

export class HomeSync {
  readonly root: string;
  readonly self: string;
  readonly file: string;
  // a filesystem that folds case: Windows, macOS
  readonly caseless: boolean;
  private idx = new Map<string, Ent>();
  // no index on disk yet: the home as it stands stamped by its own times, the first sync merging by them
  private fresh = true;
  private memo = "";
  private queue: Promise<unknown> = Promise.resolve();
  private changeFns: ((rels: string[]) => void)[] = [];
  private saveTimer?: ReturnType<typeof setTimeout>;
  private stopFns: (() => void)[] = [];

  constructor(o: { root: string; self: string; file: string; caseless?: boolean }) {
    this.root = o.root;
    this.self = o.self;
    this.file = o.file;
    this.caseless = o.caseless ?? (process.platform === "win32" || process.platform === "darwin");
  }

  // the index as last saved
  load() {
    let o: any;
    try {
      o = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      return;
    }
    this.fresh = false;
    for (const [rel, v] of Object.entries(o?.idx ?? {})) {
      const r = parseRec(v) as Ent | undefined;
      if (!r || !relOk(rel)) continue;
      const m = (v as any).m;
      if (typeof m === "number") r.m = m;
      this.idx.set(rel, r);
      hlc.seen(r.t);
    }
  }

  private save(now = false) {
    clearTimeout(this.saveTimer);
    const write = () => {
      try {
        writeFileAtomic(this.file, JSON.stringify({ idx: Object.fromEntries(this.idx) }));
      } catch (e) {
        logf("[home] index not saved: %s", e);
      }
    };
    if (now) write();
    else this.saveTimer = setTimeout(write, saveSettleMs);
  }

  private set(rel: string, e: Ent) {
    this.idx.set(rel, e);
    this.memo = "";
    this.save();
  }

  // one at a time: scans and merges never interleave
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  // told the paths a scan found changed, for the peers
  onChange(fn: (rels: string[]) => void) {
    this.changeFns.push(fn);
  }

  get(rel: string): Rec | undefined {
    const e = this.idx.get(rel);
    return e && wire(e);
  }

  // every path's version, as a peer asks for it
  stamps(rels?: string[]): Record<string, Rec> {
    const out: Record<string, Rec> = {};
    for (const r of rels ?? this.idx.keys()) {
      const e = this.idx.get(r);
      if (e) out[r] = wire(e);
    }
    return out;
  }

  // every path, version and hash in one: two hosts in step hash the same
  digest(): string {
    if (!this.memo) {
      const h = createHash("sha256");
      for (const r of [...this.idx.keys()].sort()) {
        const e = this.idx.get(r)!;
        h.update(`${r}\t${e.t}\t${e.h}\t${e.c}\n`);
      }
      this.memo = h.digest("hex").slice(0, 32);
    }
    return this.memo;
  }

  private abs = (rel: string) => join(this.root, ...rel.split("/"));

  // --- what's on disk ------------------------------------------------------------

  // rel and everything under it ("" the whole home) checked against the index
  scan(rel = ""): Promise<string[]> {
    return this.serial(async () => {
      const out: string[] = [];
      await this.scanIn(rel, out);
      this.fresh = false;
      this.save();
      if (out.length) for (const fn of this.changeFns) fn(out);
      return out;
    });
  }

  private async scanIn(rel: string, out: string[]) {
    if (rel && (!relOk(rel) || skipped(rel))) return;
    const here = new Set<string>();
    // folders that couldn't be read: what's under them unknown, never taken as gone
    const blind = new Set<string>();
    let st: Stats | undefined;
    try {
      st = rel ? lstatSync(this.abs(rel)) : undefined;
    } catch {}
    if (!rel || st?.isDirectory()) {
      if (rel) {
        here.add(rel);
        this.noteDir(rel, out);
      }
      await this.walk(rel, here, blind, out);
    } else if (st?.isFile() && (await this.exact(rel))) {
      here.add(rel);
      await this.noteFile(rel, st, out);
    }
    // what the index holds there and the disk no longer does: gone
    const unseen = (r: string) => [...blind].some((b) => !b || r.startsWith(`${b}/`));
    for (const [r, e] of [...this.idx]) {
      if (e.gone || here.has(r) || (rel && r !== rel && !r.startsWith(`${rel}/`)) || unseen(r)) continue;
      this.tombstone(r, e, out);
    }
  }

  private async walk(rel: string, here: Set<string>, blind: Set<string>, out: string[]) {
    let ents: Dirent[];
    try {
      ents = await readdir(rel ? this.abs(rel) : this.root, { withFileTypes: true });
    } catch (e) {
      blind.add(rel);
      if (!rel) logf("[home] can't read %s: %s", this.root, e);
      return;
    }
    for (const d of ents) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (!relOk(r) || skipped(r) || d.isSymbolicLink()) continue;
      if (d.isDirectory()) {
        here.add(r);
        this.noteDir(r, out);
        await this.walk(r, here, blind, out);
      } else if (d.isFile()) {
        let st: Stats;
        try {
          st = lstatSync(this.abs(r));
        } catch {
          continue;
        }
        here.add(r);
        await this.noteFile(r, st, out);
      }
    }
  }

  private noteDir(rel: string, out: string[]) {
    const cur = this.idx.get(rel);
    if (cur && cur.d && !cur.gone) return;
    this.set(rel, { t: this.stamp(cur), h: this.self, c: dirC, s: 0, d: true });
    out.push(rel);
  }

  private async noteFile(rel: string, st: Stats, out: string[]) {
    const cur = this.idx.get(rel);
    const live = cur && !cur.gone && !cur.d;
    if (live && cur.s === st.size && cur.m === st.mtimeMs) return;
    let c: string;
    try {
      c = await hashFile(this.abs(rel));
    } catch {
      return;
    }
    if (live && cur.c === c) {
      this.set(rel, { ...cur, s: st.size, m: st.mtimeMs });
      return;
    }
    const t = this.fresh && !cur ? Math.min(Math.floor(st.mtimeMs), hlc.wall()) : this.stamp(cur);
    hlc.seen(t);
    const a = live ? [cur.c, ...(cur.a ?? [])].slice(0, ancestry) : cur?.a;
    this.set(rel, { t, h: this.self, c, s: st.size, m: st.mtimeMs, ...(a?.length ? { a } : {}) });
    out.push(rel);
  }

  private tombstone(rel: string, cur: Ent, out: string[]) {
    const a = cur.d ? undefined : [cur.c, ...(cur.a ?? [])].slice(0, ancestry);
    this.set(rel, {
      t: this.stamp(cur),
      h: this.self,
      c: "",
      s: 0,
      gone: true,
      ...(cur.d ? { d: true } : {}),
      ...(a ? { a } : {}),
    });
    out.push(rel);
  }

  private stamp = (cur?: Rec) => hlc.tick(cur?.t);

  // the name on disk spelled as rel spells it, where the filesystem folds case
  private async exact(rel: string): Promise<boolean> {
    if (!this.caseless) return existsSync(this.abs(rel));
    try {
      return (await readdir(dirname(this.abs(rel)))).includes(basename(rel));
    } catch {
      return false;
    }
  }

  // --- a peer's ----------------------------------------------------------------------

  // a peer's versions merged: the newer ones applied, their bytes from it; far
  // the ones stamped too far ahead of this clock, left the ones still to come
  merge(host: string, got: Record<string, unknown>, from: Source): Promise<{ far: number; left: number }> {
    return this.serial(async () => {
      const dirs: [string, Rec][] = [],
        files: [string, Rec][] = [],
        gone: [string, Rec][] = [];
      let far = 0,
        left = 0;
      for (const rel of Object.keys(got)) {
        const r = parseRec(got[rel]);
        if (!r || !relOk(rel) || skipped(rel)) continue;
        if (r.gone && hlc.wall() - r.t >= TombstoneMs) continue;
        if (!wins(r, this.idx.get(rel))) continue;
        if (hlc.ahead(r.t)) {
          far++;
          continue;
        }
        (r.gone ? gone : r.d ? dirs : files).push([rel, r]);
      }
      const out: string[] = [];
      dirs.sort(([a], [b]) => (a < b ? -1 : 1));
      gone.sort(([a], [b]) => (a < b ? 1 : -1));
      // what's here by its hash, a rename's or a copy's bytes never fetched
      const byHash = new Map<string, string>();
      for (const [p, e] of this.idx) if (!e.gone && !e.d) byHash.set(e.c, p);
      for (const [rel, r] of [...dirs, ...files, ...gone]) {
        // the disk first: an edit here the watcher hasn't told yet counts
        await this.checkOne(rel, out);
        if (!wins(r, this.idx.get(rel))) continue;
        hlc.seen(r.t);
        try {
          if (!(await this.apply(host, rel, r, from, out, byHash))) left++;
        } catch (e) {
          logf("[home] %s from %s: %s", rel, host, e);
          left++;
        }
      }
      this.save();
      if (out.length) for (const fn of this.changeFns) fn(out);
      return { far, left };
    });
  }

  // one path against the disk, nothing under it
  private async checkOne(rel: string, out: string[]) {
    let st: Stats | undefined;
    try {
      st = lstatSync(this.abs(rel));
    } catch {}
    const cur = this.idx.get(rel);
    if (st?.isDirectory()) this.noteDir(rel, out);
    else if (st?.isFile() && (await this.exact(rel))) await this.noteFile(rel, st, out);
    else if (cur && !cur.gone) this.tombstone(rel, cur, out);
  }

  private async apply(
    host: string,
    rel: string,
    r: Rec,
    from: Source,
    out: string[],
    byHash: Map<string, string>,
  ): Promise<boolean> {
    const cur = this.idx.get(rel);
    const abs = this.abs(rel);
    const live = cur && !cur.gone;
    if (this.caseless && !live) {
      const twin = this.twin(rel);
      if (twin) {
        logf("[home] %s from %s waits: %s is here, the same name but for case", rel, host, twin);
        return false;
      }
    }
    if (r.d) {
      if (live && !cur.d) this.setAside(rel, cur, out);
      mkdirAll(abs);
      this.set(rel, r);
      return true;
    }
    if (r.gone) {
      if (live && cur.d) {
        try {
          rmdirSync(abs);
        } catch {}
      } else if (live && (await this.exact(rel))) {
        // deleted after seeing what's here: into the trash, or just gone when its bytes
        // live on under another name (a rename); deleted alongside an edit: the edit kept
        const moved = byHash.get(cur.c);
        if (!r.a?.includes(cur.c)) this.setAside(rel, cur, out);
        else if (moved && moved !== rel) rmSync(abs, { force: true });
        else this.toTrash(rel);
      }
      this.set(rel, r);
      return true;
    }
    if (live && cur.d) {
      logf("[home] %s from %s waits: a folder here has that name", rel, host);
      return false;
    }
    if (live && cur.c === r.c) {
      this.set(rel, { ...r, m: cur.m });
      return true;
    }
    const tmp = join(dirname(abs), `${uploadTmp}sync-${crypto.randomUUID().slice(0, 8)}`);
    mkdirAll(dirname(abs));
    if (!(await this.fill(host, rel, r, tmp, from, byHash.get(r.c)))) {
      rmSync(tmp, { force: true });
      return false;
    }
    // an edit here the newer one never saw: kept beside it
    if (live && !r.a?.includes(cur.c)) this.setAside(rel, cur, out);
    const prev = ownerAt(abs);
    renameSync(tmp, abs);
    adopt(abs, prev);
    const st = lstatSync(abs);
    this.set(rel, { ...r, s: st.size, m: st.mtimeMs });
    byHash.set(r.c, rel);
    return true;
  }

  // the bytes for r into tmp: a file here with its hash copied, else the peer's streamed;
  // false unless they hash as r says
  private async fill(
    host: string,
    rel: string,
    r: Rec,
    tmp: string,
    from: Source,
    same: string | undefined,
  ): Promise<boolean> {
    if (same && same !== rel) {
      try {
        await Bun.write(tmp, Bun.file(this.abs(same)));
        if ((await hashFile(tmp)) === r.c) return true;
      } catch {}
    }
    const src = await from(host, rel).catch(() => undefined);
    if (!src) return false;
    const h = createHash("sha256");
    const f = await open(tmp, "w", 0o644);
    try {
      for await (const chunk of src.body as any as AsyncIterable<Uint8Array>) {
        h.update(chunk);
        await f.write(chunk);
      }
    } finally {
      await f.close();
    }
    return h.digest("hex").slice(0, 32) === r.c;
  }

  // the version here renamed out of the way as a conflict copy, noted as a file of its own
  private setAside(rel: string, cur: Ent, out: string[]) {
    let kept = false;
    const to = conflictName(rel, cur.h, cur.t, (x) => {
      const e = this.idx.get(x);
      // another host's copy of this same clash already here: stop looking
      if (e && !e.gone && e.c === cur.c) {
        kept = true;
        return false;
      }
      return !!e || existsSync(this.abs(x));
    });
    if (kept) return rmSync(this.abs(rel), { force: true });
    renameSync(this.abs(rel), this.abs(to));
    const st = lstatSync(this.abs(to));
    this.set(to, { t: hlc.tick(), h: this.self, c: cur.c, s: st.size, m: st.mtimeMs });
    out.push(to);
  }

  // a file deleted on another host: into this one's trash, its home's own
  private toTrash(rel: string) {
    const parts = rel.split("/");
    const bin = parts.length > 1 ? `${parts[0]}/${Trash}` : Trash;
    const name = parts[parts.length - 1]!;
    const dot = name.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
    let to = `${bin}/${name}`;
    for (let i = 2; existsSync(this.abs(to)); i++) to = `${bin}/${stem} ${i}${ext}`;
    mkdirAll(this.abs(bin));
    renameSync(this.abs(rel), this.abs(to));
  }

  // a live path here the same as rel but for case
  private twin(rel: string): string | undefined {
    const low = rel.toLowerCase();
    for (const [p, e] of this.idx) if (!e.gone && p !== rel && p.toLowerCase() === low) return p;
  }

  // --- upkeep --------------------------------------------------------------------------

  // tombstones past their keep dropped
  prune(now = hlc.wall()) {
    for (const [r, e] of [...this.idx]) if (e.gone && now - e.t >= TombstoneMs) this.idx.delete(r);
    this.memo = "";
    this.save();
  }

  // changes noticed as they're made, and a whole scan now and then for what a watch misses
  watch() {
    let due = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const rels = [...due];
      due = new Set();
      // a folder and what's in it: the folder's scan covers both
      const top = rels.filter((r) => !rels.some((o) => o !== r && r.startsWith(`${o}/`)));
      for (const r of top) void this.scan(r);
    };
    const touched = (rel: string) => {
      if (!rel || skipped(rel)) return;
      due.add(rel);
      timer ??= setTimeout(flush, watchSettleMs);
    };
    try {
      const w = fsWatch(this.root, { recursive: true }, (_ev, name) => {
        if (name) touched(String(name).replaceAll("\\", "/"));
      });
      (w as unknown as EventEmitter).on("error", (e: unknown) => logf("[home] watching %s stopped: %s", this.root, e));
      this.stopFns.push(() => w.close());
    } catch (e) {
      logf("[home] can't watch %s, scanning every few minutes: %s", this.root, e);
    }
    const iv = setInterval(() => {
      this.prune();
      void this.scan();
    }, scanEveryMs);
    this.stopFns.push(() => clearInterval(iv));
    return touched;
  }

  stop() {
    for (const f of this.stopFns.splice(0)) f();
    this.save(true);
  }
}
