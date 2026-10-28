// the home's gate: whose folders a caller may see
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { posix } from "node:path";
import { RepoDir } from "@phosphorus/util";
import { Desktop, Gone, HomeRoot, Shared, Sys, absRe, configuredDirs, mountedDirs, slashed, type Res } from "./index.ts";
import { type Entry } from "./paths.ts";

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

export function firstSeg(rel: string): string {
  const parts = posix.normalize("/" + rel.replaceAll("\\", "/")).split("/");
  return parts.length < 2 ? "" : parts[1]!.toLowerCase();
}

export function ensureHome(user: string) {
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
