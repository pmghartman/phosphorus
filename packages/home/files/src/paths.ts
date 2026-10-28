// paths: held inside their share
import { dirname, join, relative, sep } from "node:path";
import { errBody, realOf, type Res, type Share } from "./index.ts";
import { homeHeld, shares } from "./shares.ts";

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
export function badPath(sh: Share, rel: string, mustExist: boolean): Res {
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
