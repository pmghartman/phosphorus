// versions: each published copy asked, cached a minute
import { errText, now, obj } from "@phosphorus/util";
import { type Route, seams } from "./mesh.ts";
import { logf, repoOf, type Service } from "./scripts.ts";

export const versionTTL = 60000;
export const versions = new Map<string, { at: number; v: string }>();

export async function versionOf(s: Service, r: Route): Promise<string> {
  const host = String(r.host ?? "");
  const key = s.id + "/" + host;
  const cur = versions.get(key);
  if (cur && now() - cur.at < versionTTL) return cur.v;
  let v = "";
  try {
    const ip = (await seams.ipOf(host)) || host;
    const scheme = r.scheme === "https" ? "https" : "http";
    const bp = String(r.base_path ?? "").replace(/^\/+|\/+$/g, "");
    const res = await fetch(`${scheme}://${ip}:${r.port}${bp ? "/" + bp : ""}/${s.versionPath}`, {
      signal: AbortSignal.timeout(3000),
    });
    const o = obj(await res.json());
    if (typeof o?.version === "string") v = o.version;
  } catch {}
  versions.set(key, { at: now(), v });
  return v;
}

// GitHub's compare, an hour at a time ---------------------------------------------

export const behindTTL = 3600000;
export const behindRetry = 600000;
export const behind = new Map<string, { at: number; n: number | null }>();
export const fetchingBehind = new Map<string, Promise<number | null>>();

// commits on main past commit, null when GitHub can't say
export function behindMain(s: Service, commit: string): Promise<number | null> {
  const repo = repoOf(s);
  if (!repo || !/^[0-9a-f]{7,40}$/.test(commit)) return Promise.resolve(null);
  const key = s.id + "/" + commit;
  const cur = behind.get(key);
  if (cur && now() - cur.at < (cur.n === null ? behindRetry : behindTTL)) return Promise.resolve(cur.n);
  let p = fetchingBehind.get(key);
  if (!p) {
    p = (async () => {
      let n: number | null = null;
      try {
        const o = obj(
          await seams.fetchJSON(`https://api.github.com/repos/${repo.owner}/${repo.name}/compare/${commit}...main`),
        );
        if (typeof o?.ahead_by === "number") n = o.ahead_by;
      } catch (e) {
        logf("%s's main: %s", s.name, errText(e));
      }
      behind.set(key, { at: now(), n });
      return n;
    })().finally(() => fetchingBehind.delete(key));
    fetchingBehind.set(key, p);
  }
  return p;
}
