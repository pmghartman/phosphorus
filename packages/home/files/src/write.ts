// writes: upload, save, mkdir, rename, delete
import { existsSync, lstatSync } from "node:fs";
import { open, rename, rm, stat, truncate, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errBody, MaxText, MaxUpload, type Res, type Share, uploadTmp } from "./index.ts";
import { jsNumber } from "./listing.ts";
import { adopt, mkdirAll, ownerAt } from "./owner.ts";
import { badPath, relOf, safePath } from "./paths.ts";
import { makeParents, read } from "./read.ts";
import { can } from "./shares.ts";

// a home change told to whoever watches (the mirror)
export let onChange: ((op: string, rel: string, to: string) => void) | undefined;

export const setOnChange = (f: typeof onChange) => void (onChange = f);
export const changed = (sh: Share, op: string, rel: string, to = "") => sh.id === "home" && onChange?.(op, rel, to);

export const badName = /[/\\]|^\.\.?$|\x00/;
export const idRe = /^[a-z0-9]{8,40}$/;
export const isInt = (f: number) => Number.isInteger(f);

// an upload chunk's query
export type UploadQ = { id: string; offset: unknown; total: unknown };

export async function drain(body: ReadableStream<Uint8Array> | null) {
  if (body) for await (const _ of body as any);
}

// one chunk of an upload appended at its offset, renamed into place once the last lands
export async function write(
  sh: Share | undefined,
  rel: string,
  body: ReadableStream<Uint8Array> | null,
  q: UploadQ,
): Promise<Res> {
  if (!sh || !can(sh, "w")) return [403, errBody("this share is read-only")];
  makeParents(sh, rel);
  const abs = safePath(sh, rel, false);
  if (!abs || badName.test(basename(abs))) return badPath(sh, rel, false);
  const total = jsNumber(q.total),
    offset = jsNumber(q.offset);
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
