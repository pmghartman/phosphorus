// a folder's chunk lists, each kept with the version of the file it was cut from (on disk too, a
// restart cutting nothing again), and where in the folder each chunk lies to be read back

import { type BigIntStats, closeSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { marshal, readJSON, writeFileAtomic } from "@phosphorus/util";
import { type Chunk, chunkFile, chunkName } from "./chunk.ts";

// a file's chunks as a host sends them: the version they were cut from, in order
export type ChunkList = { v: string; c: Chunk[] };

// a file's version: inode, mtime and size, none unless it is a file
export function versionOf(file: string): string | undefined {
  try {
    const st = lstatSync(file, { bigint: true }) as BigIntStats;
    return st.isFile() ? `${st.ino}:${st.mtimeNs}:${st.size}` : undefined;
  } catch {
    return;
  }
}

// a relative path that stays under its root
export function cleanRel(p: string): string | undefined {
  if (typeof p !== "string" || !p || p.includes("\0") || p.includes("\\")) return;
  const n = posix.normalize(p);
  if (n !== p || n.startsWith("/") || n === ".." || n.startsWith("../")) return;
  return n;
}

export class Chunks {
  private lists: Record<string, ChunkList>;
  // a chunk's name to its file, offset, length and that file's version then
  private where?: Map<string, [string, number, number, string]>;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    public root: string,
    private file: string,
  ) {
    const v = readJSON(file);
    this.lists = v && typeof v === "object" && !Array.isArray(v) ? v : {};
  }

  // p's chunks as the file is now, cut again only once its version moved
  async list(p: string): Promise<ChunkList | undefined> {
    const rel = cleanRel(p);
    if (!rel) return;
    const abs = join(this.root, rel);
    const v = versionOf(abs);
    if (!v) return;
    const had = this.lists[rel];
    if (had?.v === v) return had;
    const c = await chunkFile(abs);
    // written over while it was cut: left for the next ask
    if (versionOf(abs) !== v) return;
    this.set(rel, v, c);
    return this.lists[rel];
  }

  // p's chunks known without reading it: the file just written from them
  set(p: string, v: string, c: Chunk[]) {
    this.lists[p] = { v, c };
    if (this.where) {
      let off = 0;
      for (const [h, n] of c) {
        this.where.set(h, [p, off, n, v]);
        off += n;
      }
    }
    this.saveSoon();
  }

  // every list but keep's dropped
  forget(keep: Set<string>) {
    let any = false;
    for (const p of Object.keys(this.lists))
      if (!keep.has(p)) {
        delete this.lists[p];
        any = true;
      }
    if (!any) return;
    this.where = undefined;
    this.saveSoon();
  }

  // each named chunk the folder still holds, a file opened once for all of its, checked by name;
  // a file moved since it was cut has its list dropped, the rest looked for again elsewhere
  async read(names: Iterable<string>): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    let left = [...new Set(names)];
    for (let pass = 0; pass < 2 && left.length; pass++) {
      const where = this.index();
      const byFile = new Map<string, [string, number, number][]>();
      for (const h of left) {
        const at = where.get(h);
        if (!at) continue;
        const key = `${at[0]}\n${at[3]}`;
        let l = byFile.get(key);
        if (!l) byFile.set(key, (l = []));
        l.push([h, at[1], at[2]]);
      }
      let stale = false;
      for (const [key, want] of byFile) {
        const [p, v] = key.split("\n") as [string, string];
        const abs = join(this.root, p);
        if (versionOf(abs) !== v) {
          if (this.lists[p]?.v === v) delete this.lists[p];
          stale = true;
          continue;
        }
        // read through in one go, never left open across an await: Windows refuses to swap a
        // new version over a file someone holds open
        let fd: number | undefined;
        try {
          fd = openSync(abs, "r");
          for (const [h, off, n] of want) {
            const b = new Uint8Array(n);
            if (readSync(fd, b, 0, n, off) === n && chunkName(b) === h) out.set(h, b);
          }
        } catch {
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
        await new Promise<void>((r) => setImmediate(r));
      }
      if (!stale) break;
      this.where = undefined;
      left = left.filter((h) => !out.has(h));
    }
    return out;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = undefined;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(this.file, marshal(this.lists));
  }

  private index(): Map<string, [string, number, number, string]> {
    if (this.where) return this.where;
    const m = new Map<string, [string, number, number, string]>();
    for (const [p, l] of Object.entries(this.lists)) {
      let off = 0;
      for (const [h, n] of l.c) {
        if (!m.has(h)) m.set(h, [p, off, n, l.v]);
        off += n;
      }
    }
    this.where = m;
    return m;
  }

  private saveSoon() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), 2000);
    this.timer.unref?.();
  }
}
