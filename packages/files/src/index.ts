// each [files] dir a share, every request path held inside its
// share and every write checked against its perms
import { existsSync, lstatSync, mkdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { lstat, open, opendir, readdir, readFile, rename, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { posix } from "node:path";
import { env, localeCompare, RepoDir, StateDir as UtilStateDir, ini } from "@phosphorus/util";
import { adopt, mkdirAll, ownerAt } from "./owner.ts";

export { own } from "./owner.ts";

export const FilesRoot = env("FILES_ROOT", join(RepoDir, "files"));
export const StateDir = UtilStateDir;
export const HomeFS = env("HOME_FS", FilesRoot);
export const Home = "home";
export const HomeRoot = join(HomeFS, Home);

// a text file read or saved whole: source as big as an amalgamation's
export const MaxText = 16 << 20;
export const MaxUpload = 64 * 2 ** 30;
const maxEntries = 5000;
const treeDepthMax = 8;
const uploadTmp = ".phosphorus-upload-";
const fullPerms = "rwd";
export const Desktop = "Desktop";
export const Shared = "shared";
export const Sys = ".sys";
// what a path nobody may see answers, the same as one that is not there
export const Gone = "no such file or folder";

// [status, body]: what every call here answers
export type Res = [number, any];
const errBody = (msg: string) => ({ error: msg });

// one served folder
export type Share = { id: string; label: string; perms: string; root: string; real: string; ok: boolean; home?: boolean };

// a share as the API shows it
export const shareJSON = (s: Share) => ({ id: s.id, label: s.label, perms: s.perms, ...(s.home ? { home: true } : {}) });

const cleanPerms = (spec: string) => ["r", "w", "d"].filter((c) => spec.toLowerCase().includes(c)).join("");
export const splitList = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

// [files] dir as phosphorus.ini says now
export const configuredDirs = () => splitList(ini("files", "dir"));
const mountedDirs = () => splitList(process.env.PHOSPHORUS_FILES_DIRS ?? "");

// a path with forward slashes, trailing ones dropped
const slashed = (src: string) => src.replaceAll("\\", "/").replace(/(.)\/+$/, "$1");
const absRe = /^([A-Za-z]:)?\//;

const realOf = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

function makeShare(id: string, perms: string, root: string): Share {
  let ok = false;
  try {
    ok = statSync(root).isDirectory();
  } catch {}
  return { id, label: root, perms, root, real: realOf(root) ?? root, ok };
}

// the [files] dirs as shares; none configured, only the home
function buildShares(): Share[] {
  const dirs = mountedDirs();
  if (!dirs.length) return [];
  const perms = splitList(process.env.PHOSPHORUS_FILES_PERMS ?? "");
  return dirs.map((d, i) => makeShare(String(i), i < perms.length ? cleanPerms(perms[i]!) : fullPerms, d));
}

let inited = false;
// the home's folders made
export function init() {
  if (inited) return;
  inited = true;
  mkdirSync(join(HomeRoot, Shared, Desktop), { recursive: true });
}

// where the home lives
export const homeDir = () => HomeRoot;

function homeShare(): Share {
  return { ...makeShare("home", fullPerms, HomeRoot), label: HomeRoot, home: true };
}

let homeID: { dev: bigint; ino: bigint } | undefined;
function isHome(p: string): boolean {
  try {
    homeID ??= statSync(HomeRoot, { bigint: true });
  } catch {
    return false;
  }
  try {
    const st = statSync(p, { bigint: true });
    return st.dev === homeID.dev && st.ino === homeID.ino;
  } catch {
    return false;
  }
}

function homeHeld(sh: Share, p: string): boolean {
  if (sh.id === "home") return false;
  for (let at = p; ; at = dirname(at)) {
    if (isHome(at)) return true;
    if (at === sh.real || at === dirname(at)) return false;
  }
}

// every share up now, the home first
export const shares = (): Share[] => [homeShare(), ...buildShares()].filter((s) => s.ok);

// by id, undefined when none
export const shareOf = (id: string) => shares().find((s) => s.id === id);

// a share's perm
export const can = (sh: Share | undefined, perm: string) => !!sh && sh.perms.includes(perm);

// any share up
export const enabled = () => shares().length > 0;

export function inside(sh: Share, p: string): boolean {
  // a drive's or the system's root ends in its separator already: C:\, /
  const root = sh.real.endsWith(sep) ? sh.real.slice(0, -1) : sh.real;
  return p === sh.real || p.startsWith(root + sep);
}

export function toAbs(sh: Share, rel: string): string {
  const clean = rel.replaceAll("\\", "/");
  if (clean.includes("\0")) return "";
  const abs = join(sh.real, "./" + clean.replace(/^\/+/, ""));
  return inside(sh, abs) ? abs : "";
}

// the resolved target held to the share, a new file's parent
export function safePath(sh: Share, rel: string, mustExist: boolean): string {
  const abs = toAbs(sh, rel);
  if (!abs) return "";
  const real = realOf(mustExist ? abs : dirname(abs));
  return real && inside(sh, real) && !homeHeld(sh, real) ? abs : "";
}

// why rel isn't a path safePath gives: outside the share, missing, in the homes,
// or a name not allowed
function badPath(sh: Share, rel: string, mustExist: boolean): Res {
  const abs = toAbs(sh, rel);
  if (!abs) return [400, errBody("outside the share")];
  const real = realOf(mustExist ? abs : dirname(abs));
  if (!real) return [404, errBody(mustExist ? "not found" : "its folder doesn't exist")];
  if (!inside(sh, real)) return [400, errBody("outside the share, through a link")];
  if (homeHeld(sh, real)) return [403, errBody("inside the homes, reached through the home share only")];
  return [400, errBody("a name with characters not allowed")];
}

// an absolute path off the share's root
export function relOf(sh: Share, abs: string): string {
  const r = relative(sh.real, abs);
  return r === "" || r === "." ? "" : r.split(sep).join("/");
}

export type Located = { share: string; path: string };

// an absolute path back to its share, undefined outside them all
export function locate(abs: string): Located | undefined {
  const real = realOf(abs);
  if (!real) return;
  for (const s of shares()) if (s.id !== "home" && inside(s, real) && !homeHeld(s, real)) return { share: s.id, path: relOf(s, real) };
}

// one listed name
export type Entry = { name: string; dir: boolean; empty?: boolean; link: boolean; size: number | null; mtime: number | null; all?: boolean };

async function isEmptyDir(abs: string): Promise<boolean | undefined> {
  try {
    const d = await opendir(abs);
    const first = await d.read();
    await d.close();
    return first === null;
  } catch {
    return undefined;
  }
}

async function entryOf(dir: string, name: string): Promise<Entry | undefined> {
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
async function entriesOf(dir: string, names: string[]): Promise<Entry[]> {
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
  const src = [...g].map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
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
function skipper(skip: string): (name: string) => boolean {
  const res = splitList(skip).map(globRe);
  return (name) => res.some((re) => re.test(name));
}

// Number(v) as JS does it
export const jsNumber = (v: unknown) => (v === undefined ? NaN : Number(v));

// the folders and files under rel, breadth first; skip's folders left out
export async function tree(sh: Share | undefined, rel: string, depth: unknown, match: string, ...skip: string[]): Promise<Res> {
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
      const names = ns.filter((n) => !n.startsWith(uploadTmp) && (sh.id === "home" || !isHome(join(dir, n)))).sort(localeCompare);
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

const searchMax = 200;
const searchScanMax = 50000;
const searchFileMax = 1 << 20;
const searchPerFile = 5;
const searchLineClip = 240;

// names, or with content the text inside, holding query, case-insensitive,
// under rel; glob narrows the names looked at, skip's folders left out
export async function search(sh: Share | undefined, rel: string, query: string, content: boolean, glob: string, ...skip: string[]): Promise<Res> {
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
      ents = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

// a destination's missing folders made, held to the share
export function makeParents(sh: Share, rel: string) {
  const abs = toAbs(sh, rel);
  if (!abs) return;
  let dir = dirname(abs);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const real = realOf(dir);
  if (real && inside(sh, real)) mkdirAll(dirname(abs));
}

export function looksBinary(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8000);
  for (let i = 0; i < n; i++) if (b[i] === 0) return true;
  return false;
}

// a file as text, too big or binary marked
export async function read(sh: Share | undefined, rel: string): Promise<Res> {
  if (!sh || !can(sh, "r")) return [403, errBody("this share is not readable")];
  const abs = safePath(sh, rel, true);
  if (!abs) return safePath(sh, rel, false) ? [404, errBody("no such file")] : badPath(sh, rel, false);
  let st: Stats;
  try {
    st = await stat(abs);
  } catch {
    return [404, errBody("no such file")];
  }
  if (st.isDirectory()) return [400, errBody("that is a directory")];
  const p = relOf(sh, abs);
  if (st.size > MaxText) return [200, { path: p, size: st.size, tooBig: true }];
  let b: Buffer;
  try {
    b = await readFile(abs);
  } catch (e: any) {
    return [500, errBody(e?.message)];
  }
  if (looksBinary(b)) return [200, { path: p, size: st.size, binary: true }];
  return [200, { path: p, size: st.size, text: b.toString("utf8") }];
}

// resolved for streaming, "" when not a readable file
export function downloadPath(sh: Share | undefined, rel: string): string {
  if (!sh || !can(sh, "r")) return "";
  const abs = safePath(sh, rel, true);
  try {
    return abs && statSync(abs).isFile() ? abs : "";
  } catch {
    return "";
  }
}

// an existing path's kind and rel, undefined otherwise
export function statPath(sh: Share | undefined, rel: string): { dir: boolean; rel: string } | undefined {
  if (!sh || !can(sh, "r")) return;
  const abs = safePath(sh, rel, true);
  if (!abs) return;
  try {
    return { dir: statSync(abs).isDirectory(), rel: relOf(sh, abs) };
  } catch {}
}

// a home change told to whoever watches (the mirror)
export let onChange: ((op: string, rel: string, to: string) => void) | undefined;
export const setOnChange = (f: typeof onChange) => void (onChange = f);
const changed = (sh: Share, op: string, rel: string, to = "") => sh.id === "home" && onChange?.(op, rel, to);

const badName = /[/\\]|^\.\.?$|\x00/;
const idRe = /^[a-z0-9]{8,40}$/;
const isInt = (f: number) => Number.isInteger(f);

// an upload chunk's query
export type UploadQ = { id: string; offset: unknown; total: unknown };

async function drain(body: ReadableStream<Uint8Array> | null) {
  if (body) for await (const _ of body as any);
}

// one chunk of an upload appended at its offset, renamed into place once the last lands
export async function write(sh: Share | undefined, rel: string, body: ReadableStream<Uint8Array> | null, q: UploadQ): Promise<Res> {
  if (!sh || !can(sh, "w")) return [403, errBody("this share is read-only")];
  makeParents(sh, rel);
  const abs = safePath(sh, rel, false);
  if (!abs || badName.test(basename(abs))) return badPath(sh, rel, false);
  const total = jsNumber(q.total), offset = jsNumber(q.offset);
  if (!idRe.test(q.id) || !isInt(total) || !isInt(offset) || offset < 0 || offset > total) {
    await drain(body);
    return [400, errBody("bad chunk")];
  }
  if (total > MaxUpload) {
    await drain(body);
    return [413, errBody("file too large")];
  }
  const tmp = join(dirname(abs), uploadTmp + q.id);
  let have = 0;
  try {
    have = (await stat(tmp)).size;
  } catch {}
  if (offset > have) {
    await drain(body);
    return [409, { error: "chunk out of order", have }];
  }
  let n = 0;
  let f;
  try {
    f = await open(tmp, offset === 0 ? "w" : "r+", 0o644);
  } catch (e: any) {
    await drain(body);
    return [500, errBody(e?.message)];
  }
  try {
    if (body) {
      for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
        if (offset + n + chunk.length > total) throw new Error("chunk past the end");
        await f.write(chunk, 0, chunk.length, offset + n);
        n += chunk.length;
      }
    }
    await f.close();
  } catch (e: any) {
    await f.close().catch(() => {});
    await drain(body).catch(() => {});
    if (offset === 0) await unlink(tmp).catch(() => {});
    return [500, errBody(e?.message)];
  }
  if (offset + n < total) return [200, { ok: true, next: offset + n }];
  try {
    await truncate(tmp, total);
    const prev = ownerAt(abs);
    await rename(tmp, abs);
    adopt(abs, prev);
  } catch (e: any) {
    return [500, errBody(e?.message)];
  }
  changed(sh, "write", relOf(sh, abs));
  return [200, { ok: true, path: relOf(sh, abs) }];
}

// a save's body
export type SaveP = { text?: string; old?: string; new?: string };

// a text file whole, or one exact passage in it replaced
export async function save(sh: Share | undefined, rel: string, p: SaveP): Promise<Res> {
  if (!sh || !can(sh, "w")) return [403, errBody("this share is read-only")];
  makeParents(sh, rel);
  const abs = safePath(sh, rel, false);
  if (!abs || badName.test(basename(abs))) return badPath(sh, rel, false);
  let text = p.text;
  if (typeof p.old === "string" && typeof p.new === "string") {
    if (!can(sh, "r")) return [403, errBody("this share is not readable")];
    const [status, cur] = await read(sh, rel);
    if (status !== 200) return [status, cur];
    const t = cur.text;
    if (typeof t !== "string") return [400, errBody("not a text file under 16MB")];
    const at = p.old ? t.indexOf(p.old) : -1;
    if (at < 0) return [409, errBody("old text not found")];
    if (t.slice(at + 1).includes(p.old)) return [409, errBody("old text found more than once, give more of it")];
    text = t.slice(0, at) + p.new + t.slice(at + p.old.length);
  }
  if (typeof text !== "string") return [400, errBody("text, or old and new")];
  const size = Buffer.byteLength(text);
  if (size > MaxText) return [413, errBody("over 16MB")];
  const made = !existsSync(abs);
  const tmp = join(dirname(abs), `${uploadTmp}${process.pid}-${Date.now()}`);
  try {
    await writeFile(tmp, text, { mode: 0o644 });
    const prev = ownerAt(abs);
    await rename(tmp, abs);
    adopt(abs, prev);
  } catch (e: any) {
    await unlink(tmp).catch(() => {});
    return [500, errBody(e?.message)];
  }
  changed(sh, "write", relOf(sh, abs));
  return [200, { ok: true, path: relOf(sh, abs), size, ...(made ? { created: true } : {}) }];
}

// a folder
export function mkdir(sh: Share | undefined, rel: string): Res {
  if (!sh || !can(sh, "w")) return [403, errBody("this share is read-only")];
  const abs = safePath(sh, rel, false);
  if (!abs || badName.test(basename(abs))) return badPath(sh, rel, false);
  if (existsSync(abs)) return [409, errBody("already exists")];
  try {
    mkdirAll(abs);
  } catch (e: any) {
    return [500, errBody(e?.message)];
  }
  return [200, { ok: true, path: relOf(sh, abs) }];
}

// to ending in / moves into that folder under its own name
export async function renamePath(sh: Share | undefined, from: string, to: string): Promise<Res> {
  if (!sh || !can(sh, "w")) return [403, errBody("this share is read-only")];
  const src = safePath(sh, from, true);
  if (src && (to.endsWith("/") || to.endsWith("\\"))) to += basename(src);
  if (src) makeParents(sh, to);
  const dst = safePath(sh, to, false);
  if (!src) return badPath(sh, from, true);
  if (!dst || badName.test(basename(dst))) return badPath(sh, to, false);
  if (src === sh.real) return [400, errBody("can't rename the share itself")];
  try {
    lstatSync(dst);
    return [409, errBody("already exists")];
  } catch {}
  const was = relOf(sh, src);
  try {
    await rename(src, dst);
  } catch (e: any) {
    return [500, errBody(e?.message)];
  }
  changed(sh, "rename", was, relOf(sh, dst));
  return [200, { ok: true, path: relOf(sh, dst) }];
}

// recursively, never the share itself
export async function remove(sh: Share | undefined, rel: string): Promise<Res> {
  if (!sh || !can(sh, "d")) return [403, errBody("deleting is off for this share")];
  const abs = safePath(sh, rel, true);
  if (!abs) return badPath(sh, rel, true);
  if (abs === sh.real) return [400, errBody("can't delete the share itself")];
  try {
    await rm(abs, { recursive: true, force: true });
  } catch (e: any) {
    return [500, errBody(e?.message)];
  }
  changed(sh, "delete", relOf(sh, abs));
  return [200, { ok: true }];
}

// what phosphorus.ini asks for against what is mounted
export function pending(): boolean {
  const home = slashed(RepoDir);
  const norm = (d: string) => {
    const p = slashed(d.trim());
    const abs = absRe.test(p) ? p : posix.join(home, p);
    return posix.normalize(abs).replace(/(.)\/+$/, "$1");
  };
  const joined = (ds: string[]) => ds.filter(Boolean).map(norm).join(",");
  const want = joined(configuredDirs());
  let have = mountedDirs();
  if (!have.length) have = [process.env.PHOSPHORUS_FILES_DIR ?? ""];
  const h = joined(have);
  return !!want && !!h && want !== h;
}

// {user, admin} off the session, undefined without one
export type Who = { user: string; admin: boolean };

function firstSeg(rel: string): string {
  const parts = posix.normalize("/" + rel.replaceAll("\\", "/")).split("/");
  return parts.length < 2 ? "" : parts[1]!.toLowerCase();
}

function ensureHome(user: string) {
  const desk = join(HomeRoot, user, Desktop);
  if (!existsSync(desk)) mkdirSync(desk, { recursive: true });
}

// "" when who may reach rel, else why not
export function homeGate(who: Who | undefined, rel: string, isUser: (u: string) => boolean): string {
  if (!who) return "log in to reach home";
  const seg = firstSeg(rel);
  if (who.user) ensureHome(who.user);
  // the system's folder: admins see it, everyone else gets nothing, as if it were not there
  if (seg === Sys) return who.admin ? "" : Gone;
  if (!seg || seg === who.user || seg === Shared) return "";
  if (isUser(seg)) return "another user's home";
  return who.admin ? "" : "admins only";
}

// the status for a homeGate refusal: a hidden path not found, no login 401, else 403
export const gateCode = (who: Who | undefined, why: string) => (why === Gone ? 404 : !who ? 401 : 403);

// a listing cut to what who may reach
export const homeFilterList = (who: Who | undefined, rel: string, entries: Entry[], isUser: (u: string) => boolean) =>
  entries.filter((e) => homeGate(who, rel ? rel + "/" + e.name : e.name, isUser) === "");

// a tree's paths off the share's root
export const homeFilterTree = (who: Who | undefined, entries: { path: string }[], isUser: (u: string) => boolean) =>
  entries.filter((e) => homeGate(who, e.path, isUser) === "");

// a missing path a 200 flagged missing, for probes of paths a host may lack
export function quiet(q: URLSearchParams, [st, b]: Res): Res {
  if (!q.has("quiet") || st !== 404) return [st, b];
  return [200, { missing: true, error: b?.error }];
}

