// home files kept on every host, one sys entry per file (etc/mirror/<id>),
// every other host pulling the latest copy
import { createHash } from "node:crypto";
import { renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { downloadPath, makeParents, safePath, type Share, shareOf } from "@phosphorus/files";
import * as sysfs from "@phosphorus/sysfs";
import { obj, readJSONMap, SelfHost, writeJSONAtomic } from "@phosphorus/util";

// small files only
export const Max = 32 * 1024 * 1024;
const tickMS = 3000;
const dir = "etc/mirror";

export type Entry = { path: string; size: number; from: string };
type AppliedRec = { at: number; path: string };

let appliedFile = "";
let applied: Record<string, AppliedRec> = {};
let busy = false;
const idRe = /^[0-9a-f]{24}$/;

export const idOf = (rel: string) => createHash("sha256").update(rel).digest("hex").slice(0, 24);

export const entryRel = (id: string) => dir + "/" + id + ".json";

const share = () => shareOf("home");

const saveApplied = () => void (appliedFile && writeJSONAtomic(appliedFile, applied));

function read(rel: string): Entry | undefined {
  const o = obj(sysfs.read(rel));
  if (!o) return;
  const { path = "", size = 0, from = "" } = o;
  if (typeof path !== "string" || typeof size !== "number" || typeof from !== "string") return;
  return { path, size, from };
}

// a home path kept on every host
export const IsMirrored = (rel: string) => read(entryRel(idOf(rel))) !== undefined;

function sizeOf(rel: string): number {
  const abs = downloadPath(share(), rel);
  if (!abs) return -1;
  try {
    return statSync(abs).size;
  } catch {
    return -1;
  }
}

// this host's copy the one every other takes
export function Mark(rel: string): [number, any] {
  const size = sizeOf(rel);
  if (size < 0) return [404, { error: "no such file" }];
  if (size > Max) return [413, { error: "over 32MB, kept on one host" }];
  const id = idOf(rel);
  sysfs.write(entryRel(id), { path: rel, size, from: SelfHost } satisfies Entry);
  applied[id] = { at: sysfs.stamp(entryRel(id)), path: rel };
  saveApplied();
  return [200, { ok: true, all: true }];
}

// no longer on every host
export function Unmark(rel: string): [number, any] {
  sysfs.remove(entryRel(idOf(rel)));
  return [200, { ok: true, all: false }];
}

// a write, rename or delete in the home, a mirrored entry following
export function Touched(op: string, rel: string, to: string) {
  switch (op) {
    case "delete":
      for (const f of sysfs.list(dir)) {
        const id = f.replace(/\.json$/, "");
        const e = read(entryRel(id));
        if (e && (e.path === rel || e.path.startsWith(rel + "/"))) sysfs.remove(entryRel(id));
      }
      break;
    case "rename":
      if (IsMirrored(rel)) {
        Unmark(rel);
        Mark(to);
      }
      break;
    default:
      if (IsMirrored(rel) && Mark(rel)[0] !== 200) Unmark(rel);
  }
}

// a peer's GET /internal/mirror/<id>: this host's copy when it's the latest
export function Serve(id: string): Response {
  let abs = "";
  if (idRe.test(id)) {
    const e = read(entryRel(id));
    if (e && e.from === SelfHost) abs = downloadPath(share(), e.path);
  }
  let size: number;
  try {
    if (!abs) throw 0;
    size = statSync(abs).size;
  } catch {
    return new Response(null, { status: 404 });
  }
  return new Response(Bun.file(abs), { status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) } });
}

const rm = (p: string) => {
  try {
    rmSync(p);
  } catch {}
};

async function fetchTo(ip: string, port: number, id: string, tmp: string): Promise<boolean> {
  let res: Response;
  try {
    res = await fetch(`http://${ip}:${port}/internal/mirror/${id}`, { signal: AbortSignal.timeout(60000) });
  } catch {
    return false;
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    return false;
  }
  try {
    await Bun.write(tmp, res);
    return true;
  } catch {
    return false;
  }
}

export type IPOf = (host: string) => string | Promise<string>;

// one pull round: every entry newer than what's applied fetched from its host,
// an entry gone taking its file with it
export async function tick(ipOf: IPOf, port: number) {
  const sh = share();
  if (busy || !sh) return;
  busy = true;
  try {
    await pull(sh, ipOf, port);
  } finally {
    saveApplied();
    busy = false;
  }
}

async function pull(sh: Share, ipOf: IPOf, port: number) {
  const live = new Set<string>();
  for (const f of sysfs.list(dir)) {
    const id = f.replace(/\.json$/, "");
    live.add(id);
    const e = read(entryRel(id));
    const at = sysfs.stamp(entryRel(id));
    const a = applied[id];
    if (!e || (a && a.at >= at)) continue;
    if (e.from === SelfHost) {
      applied[id] = { at, path: e.path };
      continue;
    }
    const ip = await ipOf(e.from);
    makeParents(sh, e.path);
    if (!ip) continue;
    const abs = safePath(sh, e.path, false);
    if (!abs) continue;
    const tmp = join(dirname(abs), ".phosphorus-upload-mirror-" + id);
    if (!(await fetchTo(ip, port, id, tmp))) {
      rm(tmp);
      continue;
    }
    try {
      renameSync(tmp, abs);
    } catch {
      rm(tmp);
      continue;
    }
    applied[id] = { at, path: e.path };
    if (a && a.path !== e.path) {
      const old = safePath(sh, a.path, true);
      if (old) rm(old);
    }
  }
  for (const [id, a] of Object.entries(applied)) {
    if (live.has(id) || sysfs.stamp(entryRel(id)) <= a.at) continue;
    const abs = safePath(sh, a.path, true);
    if (abs) rm(abs);
    delete applied[id];
  }
}

function parseApplied(m: Record<string, any> | undefined): Record<string, AppliedRec> {
  const out: Record<string, AppliedRec> = {};
  for (const [id, v] of Object.entries(m ?? {})) {
    const r = obj(v);
    if (r) out[id] = { at: typeof r.at === "number" ? r.at : 0, path: typeof r.path === "string" ? r.path : "" };
  }
  return out;
}

// what's applied loaded, for tests and Start
export function load() {
  appliedFile = sysfs.local("mirror-applied.json");
  applied = parseApplied(readJSONMap(appliedFile));
}

// the pull loop
export function Start(ipOf: IPOf, port: number) {
  load();
  setInterval(() => void tick(ipOf, port), tickMS);
}
