// the pretend OS's tree: etc/ and home/ replicated, every host a full copy, each
// file's latest write winning; var/ this host's own

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HomeRoot, Sys } from "@phosphorus/files";
import { FrontendPort, logf, markHot, requestJSON, writeFileAtomic } from "@phosphorus/util";

// in [home] dir's home/, hidden from every user but the admins
export const Root = join(HomeRoot, Sys);

const relRe = /^(etc|home)(\/[a-z0-9][a-z0-9._-]{0,63}){1,5}\.json$/;
// a replicated path
export const validRel = (rel: string) => relRe.test(rel);

// one entry: a stamp and data, or a tombstone
export type File = { at: number; gone?: boolean; data?: unknown };
// a peer's published digest
export type PeerSys = { host: string; digest: string };

const tree = new Map<string, File>();
const oldest = new Set<string>();
const watchers: ((rel: string) => void)[] = [];
let digestMemo = "";
const synced = new Map<string, string>();

// from mesh, set at startup
export let peerIPs: () => Record<string, string> = () => ({});
export let peers: () => PeerSys[] = () => [];
export function setPeerSources(ips: typeof peerIPs, ps: typeof peers) {
  peerIPs = ips;
  peers = ps;
}

// a file's JSON as stored: {at, data} with data present even when null
const encode = (f: File) =>
  f.gone ? `{"at":${f.at},"gone":true}` : `{"at":${f.at},"data":${JSON.stringify(f.data ?? null)}}`;

function parseFile(v: unknown): File | undefined {
  if (!v || typeof v !== "object") return;
  const o = v as Record<string, unknown>;
  if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at > Date.now() + 60000) return;
  if (o.gone === true) return { at: o.at, gone: true };
  if (!("data" in o)) return;
  return { at: o.at, data: o.data };
}

function load(dir: string, rel: string) {
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) {
      if (r !== "var") load(join(dir, e.name), r);
    } else if (relRe.test(r)) {
      try {
        const f = parseFile(JSON.parse(readFileSync(join(dir, e.name), "utf8")));
        if (f) tree.set(r, f);
      } catch {}
    }
  }
}

function put(rel: string, f: File) {
  tree.set(rel, f);
  digestMemo = "";
  for (const w of [...watchers]) {
    try {
      w(rel);
    } catch (e) {
      logf("[sys] watcher on %s: %s", rel, e);
    }
  }
  markHot();
  const abs = join(Root, rel);
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  writeFileAtomic(abs, encode(f));
}

const stampOf = (rel: string) => tree.get(rel)?.at ?? 0;
const nextAt = (rel: string) => Math.max(Date.now(), stampOf(rel) + 1);
const live = (f: File | undefined) => !!f && !f.gone && f.data !== undefined && f.data !== null;

// a live file's data, undefined when absent or gone
export function read<T = any>(rel: string): T | undefined {
  const f = tree.get(rel);
  return live(f) ? (f!.data as T) : undefined;
}

// a file written, the oldest-wins ones never overwritten
export function write(rel: string, data: unknown) {
  if (!relRe.test(rel)) throw new Error("bad sys path " + rel);
  if (oldest.has(rel) && read(rel) !== undefined) return;
  put(rel, { at: nextAt(rel), data: JSON.parse(JSON.stringify(data ?? null)) });
}

// a live file removed, a tombstone left
export function remove(rel: string) {
  if (read(rel) !== undefined) put(rel, { at: nextAt(rel), gone: true });
}

// live files under a dir, rel to it
export function list(dir: string): string[] {
  const pre = dir + "/";
  return [...tree]
    .filter(([r, f]) => r.startsWith(pre) && live(f))
    .map(([r]) => r.slice(pre.length))
    .sort();
}

// a file's stamp, 0 when absent
export const stamp = (rel: string) => stampOf(rel);

// every rel and its stamp
export const stamps = (): Record<string, number> => Object.fromEntries([...tree].map(([r, f]) => [r, f.at]));

// every rel and stamp in one hash
export function digest(): string {
  if (!digestMemo) {
    const h = createHash("sha256");
    for (const r of [...tree.keys()].sort()) h.update(`${r}\t${tree.get(r)!.at}\n`);
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

function wins(rel: string, at: number) {
  if (oldest.has(rel) && read(rel) !== undefined) return at < stampOf(rel);
  return at > stampOf(rel);
}

// a peer's files merged, true when anything changed
export function merge(got: Record<string, unknown>): boolean {
  let changed = false;
  for (const rel of Object.keys(got).sort()) {
    const f = parseFile(got[rel]);
    if (!relRe.test(rel) || !f || !wins(rel, f.at)) continue;
    put(rel, f);
    changed = true;
  }
  return changed;
}

// the newer rels, ahead those stamped past this host's clock
function wanted(st: Record<string, unknown>): [string[], number] {
  const out: string[] = [];
  let ahead = 0;
  for (const [rel, at] of Object.entries(st)) {
    if (!relRe.test(rel) || typeof at !== "number" || !Number.isFinite(at) || !wins(rel, at)) continue;
    if (at > Date.now() + 60000) ahead++;
    else out.push(rel);
  }
  return [out.sort(), ahead];
}

// var/<rel>: this host's own
export function local(rel: string): string {
  const abs = join(Root, "var", rel);
  mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
  return abs;
}

const pullBatch = 40;
let pulling: Promise<void> | undefined;

// every peer whose digest differs, one pull at a time
export function pull(): Promise<void> {
  return (pulling ??= pullOnce().finally(() => (pulling = undefined)));
}

async function pullOnce() {
  const ips = peerIPs();
  await Promise.all(
    peers().map(async (p) => {
      const ip = ips[p.host];
      if (!ip || p.digest === digest() || p.digest === synced.get(p.host)) return;
      try {
        const s = await requestJSON({ host: ip, port: FrontendPort, path: "/api/sys/stamps", timeoutMs: 5000 });
        if (s.status !== 200 || !s.body || typeof s.body !== "object") return;
        const st = s.body as Record<string, unknown>;
        const [want, ahead] = wanted(st);
        for (let i = 0; i < want.length; i += pullBatch) {
          const rels = want.slice(i, i + pullBatch).filter((r) => wins(r, st[r] as number));
          if (!rels.length) continue;
          const r = await requestJSON({
            host: ip,
            port: FrontendPort,
            path: "/api/sys/sync?" + new URLSearchParams({ rels: rels.join(",") }),
            timeoutMs: 5000,
          });
          if (r.status !== 200) return;
          if (r.body && typeof r.body === "object") merge(r.body);
        }
        // a slow clock's skipped files retried, never marked synced
        if (ahead > 0) return aheadLog(p.host, ahead);
        synced.set(p.host, p.digest);
      } catch {}
    }),
  );
}

const aheadAt = new Map<string, number>();
function aheadLog(host: string, n: number) {
  if (Date.now() - (aheadAt.get(host) ?? 0) < 10 * 60 * 1000) return;
  aheadAt.set(host, Date.now());
  logf("[sys] %d files from %s stamped over a minute ahead of this clock, skipped until it's set right", n, host);
}

// a path whose first write stays
export const oldestWins = (rel: string) => void oldest.add(rel);

// every change, local or a peer's
export const watch = (fn: (rel: string) => void) => void watchers.push(fn);

let started = false;
// the tree loaded, pulled every second
export function start() {
  if (started) return;
  started = true;
  load(Root, "");
  setInterval(() => void pull(), 1000);
}

// loaded without the pull loop, for tests and the cli
export const loadTree = () => load(Root, "");
