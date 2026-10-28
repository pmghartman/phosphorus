// shares: the [files] dirs and the home
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Desktop, HomeRoot, Shared, cleanPerms, fullPerms, mountedDirs, realOf, splitList, type Share } from "./index.ts";

export function makeShare(id: string, perms: string, root: string): Share {
  let ok = false;
  try {
    ok = statSync(root).isDirectory();
  } catch {}
  return { id, label: root, perms, root, real: realOf(root) ?? root, ok };
}

// the [files] dirs as shares; none configured, only the home
export function buildShares(): Share[] {
  const dirs = mountedDirs();
  if (!dirs.length) return [];
  const perms = splitList(process.env.PHOSPHORUS_FILES_PERMS ?? "");
  return dirs.map((d, i) => makeShare(String(i), i < perms.length ? cleanPerms(perms[i]!) : fullPerms, d));
}

export let inited = false;
// the home's folders made
export function init() {
  if (inited) return;
  inited = true;
  mkdirSync(join(HomeRoot, Shared, Desktop), { recursive: true });
}

// where the home lives
export const homeDir = () => HomeRoot;

export function homeShare(): Share {
  return { ...makeShare("home", fullPerms, HomeRoot), label: HomeRoot, home: true };
}

export let homeID: { dev: bigint; ino: bigint } | undefined;
export function isHome(p: string): boolean {
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

export function homeHeld(sh: Share, p: string): boolean {
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
