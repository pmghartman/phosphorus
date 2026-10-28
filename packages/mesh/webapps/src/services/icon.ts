// the icon off the repository's main, kept a day in state/apps/icons
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env, errText, now, StateDir } from "@phosphorus/util";
import { seams } from "./mesh.ts";
import { logf, repoOf, serviceOf } from "./scripts.ts";

export const iconTTL = 86400000;
export const iconDir = () => env("APPS_ICON_DIR", join(StateDir, "apps", "icons"));
export const iconTypes: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
export const iconFetching = new Map<string, Promise<void>>();

export const iconPath = (id: string) => `/api/apps/services/${id}/icon`;

// Icon the service's icon as bytes and type, from the repository on first ask and
// once a day after, the kept copy meanwhile; undefined with none to give
export async function Icon(id: string): Promise<{ data: Uint8Array; type: string } | undefined> {
  const s = serviceOf(id);
  return s ? RepoIcon(s) : undefined;
}

// RepoIcon an icon at a path in a repository's main, kept under its id: a service's, or a web
// app's before any host serves it
export async function RepoIcon(s: {
  id: string;
  name: string;
  repo: string;
  icon: string;
}): Promise<{ data: Uint8Array; type: string } | undefined> {
  const repo = repoOf(s);
  if (!repo || !s.icon) return;
  const ext = (/\.[a-z0-9]+$/i.exec(s.icon)?.[0] ?? ".png").toLowerCase();
  const type = iconTypes[ext] ?? "application/octet-stream";
  const file = join(iconDir(), s.id + ext);
  let fresh = false;
  try {
    fresh = now() - statSync(file).mtimeMs < iconTTL;
  } catch {}
  if (!fresh) {
    let p = iconFetching.get(s.id);
    if (!p) {
      p = (async () => {
        const got = await seams.fetchBytes(
          `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/main/${s.icon}`,
        );
        if (!got || !got.data.length) return;
        mkdirSync(iconDir(), { recursive: true });
        writeFileSync(file, got.data);
      })()
        .catch((e) => logf("%s's icon: %s", s.name, errText(e)))
        .finally(() => iconFetching.delete(s.id));
      iconFetching.set(s.id, p);
    }
    // a kept copy answers at once while a fresher one is fetched
    if (!existsSync(file)) await p;
  }
  try {
    return { data: new Uint8Array(readFileSync(file)), type };
  } catch {
    return;
  }
}
