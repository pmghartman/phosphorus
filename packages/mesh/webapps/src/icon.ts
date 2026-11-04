// an app's icon off its repository's main, kept an hour in state/cache/icons
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CacheDir, env, errText, logf, now } from "@phosphorus/util";

export const iconTTL = 3600000;
export const iconDir = () => env("APPS_ICON_DIR", join(CacheDir, "icons"));
export const iconTypes: Record<string, string> = {
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const iconFetching = new Map<string, Promise<void>>();

// the repository's owner and name, for raw files off GitHub
export function repoOf(s: { repo: string }): { owner: string; name: string } | undefined {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(s.repo);
  return m ? { owner: m[1]!, name: m[2]! } : undefined;
}

// bytes and their type from a url, swapped in tests
export const iconSeams = {
  fetchBytes: async (url: string): Promise<{ data: Uint8Array; type: string } | undefined> => {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) return;
    return { data: new Uint8Array(await r.arrayBuffer()), type: r.headers.get("content-type") ?? "" };
  },
};

// RepoIcon an icon at a path in a repository's main, kept under its id: a web app's
// before any host serves it
export async function RepoIcon(s: {
  id: string;
  name: string;
  repo: string;
  icon: string;
}): Promise<{ data: Uint8Array; type: string } | undefined> {
  const repo = repoOf(s);
  const url = /^https:\/\//.test(s.icon)
    ? s.icon
    : repo
      ? `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/main/${s.icon}`
      : "";
  if (!url) return;
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
        const got = await iconSeams.fetchBytes(url);
        if (!got || !got.data.length) return;
        mkdirSync(iconDir(), { recursive: true });
        writeFileSync(file, got.data);
      })()
        .catch((e) => logf("[apps] %s's icon: %s", s.name, errText(e)))
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
