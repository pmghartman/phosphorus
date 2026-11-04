// icons, wallpapers and the last desktop drawn, kept on the serving host under
// state/cache/hostdesk/<host>/ by what they are and their version

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { CacheDir, writeFileAtomic } from "@phosphorus/util";

const root = () => join(CacheDir, "hostdesk");
const maxFiles = 4000;

const dirOf = (host: string) => join(root(), host.replace(/[^a-z0-9-]/g, "_"));
const name = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 40);

export function cacheGet(host: string, key: string): Uint8Array | undefined {
  try {
    return readFileSync(join(dirOf(host), name(key)));
  } catch {}
}

export function cachePut(host: string, key: string, b: Uint8Array | string) {
  const d = dirOf(host);
  try {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    writeFileAtomic(join(d, name(key)), b);
    trim(d);
  } catch {}
}

let puts = 0;
// the oldest dropped once a host's folder grows past its cap, checked now and then
function trim(d: string) {
  if (++puts % 200) return;
  const fs = readdirSync(d).map((f) => ({ f, t: statSync(join(d, f)).mtimeMs }));
  if (fs.length <= maxFiles) return;
  fs.sort((a, b) => a.t - b.t);
  for (const x of fs.slice(0, fs.length - maxFiles)) unlinkSync(join(d, x.f));
}

export const cacheJSON = <T>(host: string, key: string): T | undefined => {
  const b = cacheGet(host, key);
  if (!b) return;
  try {
    return JSON.parse(Buffer.from(b).toString("utf8")) as T;
  } catch {}
};
