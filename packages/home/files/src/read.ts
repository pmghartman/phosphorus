// reads
import { existsSync, type Stats, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { errBody, MaxText, type Res, realOf, type Share } from "./index.ts";
import { mkdirAll } from "./owner.ts";
import { badPath, inside, relOf, safePath, toAbs } from "./paths.ts";
import { can } from "./shares.ts";

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
