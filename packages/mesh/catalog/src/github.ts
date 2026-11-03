// a public GitHub repo opened by its url: its metadata and licence, README,
// tree, compose file and optional phos.yml, through the unauthenticated API
// (60 calls an hour per address, so kept a while) and raw.githubusercontent.com
import { posix } from "node:path";
import { errText, now } from "@phosphorus/util";
import type { AppDef, EnvField, TreeEntry } from "@phosphorus/wire";
import { finish, slug } from "./adapters/common.ts";
import { type Compose, parse } from "./compose.ts";
import { overlay } from "./manifest.ts";
import type { Fetch } from "./registry.ts";

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Opened {
  def: AppDef;
  readme: string;
  tree: TreeEntry[];
}

const OkMS = 10 * 60 * 1000;
const ErrMS = 60 * 1000;
const MaxTree = 2000;
const cache = new Map<string, { at: number; p: Promise<Opened> }>();

let api = "https://api.github.com";
let raw = "https://raw.githubusercontent.com";
// for tests: other hosts
export function setHosts(a: string, r: string) {
  api = a;
  raw = r;
  cache.clear();
}

// "owner/repo" of a github url, or of owner/repo itself; "owner/repo@branch"
// for a branch named by /tree/<branch> or @branch
export function repoOf(url: string): string | undefined {
  const s = url.trim();
  const m =
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^/?#]+))?(?:\/[^?#]*)?(?:[?#].*)?$/i.exec(
      s,
    ) ?? /^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([^\s]+))?$/.exec(s);
  if (!m) return;
  return `${m[1]}/${m[2]}${m[3] ? "@" + m[3] : ""}`;
}

// the paths a compose file is looked for at, in order
const composeNames = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
export const composePaths = ["", "docker/", "deploy/"].flatMap((d) => composeNames.map((n) => d + n));
const phosPaths = ["phos.yml", "phos.yaml", ".phos.yml"];

async function call(f: Fetch, url: string, accept = "application/vnd.github+json"): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, { headers: { Accept: accept, "User-Agent": "phosphorus" } });
  } catch (e) {
    throw new GitHubError(502, `can't reach GitHub: ${errText(e)}`);
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset")) * 1000;
    const when = reset ? ` until ${new Date(reset).toISOString().slice(11, 16)} UTC` : "";
    throw new GitHubError(429, `GitHub's limit on unauthenticated calls from this host is spent${when}`);
  }
  return res;
}

// a repo's compose file made to run from its clone: build contexts and files
// the repo has under ${APP_REPO}, other relative binds the app's data
export function rebase(c: Compose, dir: string, has: (path: string) => boolean): Compose {
  const rel = (p: string) => /^\.\.?(\/|$)/.test(p);
  const inRepo = (p: string) => posix.normalize(posix.join(dir, p)).replace(/\/$/, "");
  const fix = (p: string) => {
    const r = inRepo(p);
    if (r === "." || has(r)) return r === "." ? "${APP_REPO}" : `\${APP_REPO}/${r}`;
    return `\${APP_DATA}/${r.replace(/^(\.\.\/)+/, "")}`;
  };
  for (const s of Object.values(c.services)) {
    if (typeof s.build === "string") s.build = rel(s.build) || !s.build.includes(":") ? fix(s.build) : s.build;
    else if (s.build && typeof s.build.context === "string" && !s.build.context.includes("://"))
      s.build.context = fix(s.build.context);
    if (Array.isArray(s.volumes))
      s.volumes = s.volumes.map((v: unknown) => {
        if (typeof v === "string") {
          const [src, ...rest] = v.split(":");
          return rel(src!) ? [fix(src!), ...rest].join(":") : v;
        }
        const o = v as Record<string, any>;
        if (o?.type === "bind" && typeof o.source === "string" && rel(o.source)) return { ...o, source: fix(o.source) };
        return v;
      });
    const ef = s.env_file;
    if (ef !== undefined)
      s.env_file = (Array.isArray(ef) ? ef : [ef]).map((e: any) => {
        const p = typeof e === "string" ? e : e?.path;
        if (typeof p !== "string") return e;
        const r = inRepo(p);
        // an env file the repo leaves to the person: not required
        return has(r) ? `\${APP_REPO}/${r}` : { path: `\${APP_REPO}/${r}`, required: false };
      });
  }
  return c;
}

async function open(spec: string, f: Fetch): Promise<Opened> {
  const [full, at] = spec.split("@") as [string, string | undefined];
  const res = await call(f, `${api}/repos/${full}`);
  if (res.status === 404) throw new GitHubError(404, `no public repo ${full} on GitHub`);
  if (!res.ok) throw new GitHubError(502, `GitHub: HTTP ${res.status} for ${full}`);
  const meta = (await res.json()) as Record<string, any>;
  const branch = at || String(meta.default_branch || "HEAD");
  const name = String(meta.full_name || full);

  const tr = await call(f, `${api}/repos/${name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const all: TreeEntry[] = [];
  if (tr.ok) {
    const j = (await tr.json()) as Record<string, any>;
    for (const e of Array.isArray(j.tree) ? j.tree : [])
      if (typeof e?.path === "string")
        all.push(e.type === "tree" ? { path: e.path, type: "dir" } : { path: e.path, type: "file", size: e.size });
  }
  const paths = new Set(all.map((e) => e.path));
  // the shallowest entries when there are too many, outside dependency folders
  const tree = all
    .filter((e) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(e.path))
    .sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))
    .slice(0, MaxTree)
    .sort((a, b) => a.path.localeCompare(b.path));

  const rd = await call(f, `${api}/repos/${name}/readme`, "application/vnd.github.raw");
  const readme = rd.ok ? await rd.text() : "";

  const rawText = async (path: string) => {
    const r = await call(f, `${raw}/${name}/${encodeURIComponent(branch)}/${path}`, "text/plain");
    return r.ok ? r.text() : undefined;
  };
  // the tree when GitHub sent it, else each path asked for
  const exists = (p: string) => (all.length ? paths.has(p) : true);

  let phos: Record<string, any> | undefined;
  for (const p of phosPaths) {
    if (!exists(p)) continue;
    const t = await rawText(p);
    if (t === undefined) continue;
    try {
      const v = Bun.YAML.parse(t);
      if (v && typeof v === "object" && !Array.isArray(v)) phos = v as Record<string, any>;
    } catch {}
    break;
  }

  let composePath = "";
  let text = "";
  const wanted =
    typeof phos?.compose === "string" ? [phos.compose.replace(/^\.\//, ""), ...composePaths] : composePaths;
  for (const p of wanted) {
    if (!exists(p)) continue;
    const t = await rawText(p);
    if (t === undefined) continue;
    composePath = p;
    text = t;
    break;
  }

  const repo = String(meta.html_url || `https://github.com/${name}`);
  const parts = {
    source: "github" as const,
    ref: at ? `${name}@${at}` : name,
    id: slug(String(meta.name || name.split("/")[1])),
    name: String(phos?.name || meta.name || name),
    tagline: String(phos?.tagline || meta.description || ""),
    icon: String(phos?.icon || meta.owner?.avatar_url || ""),
    category: String(phos?.category || (Array.isArray(meta.topics) ? (meta.topics[0] ?? "") : "")),
    repo,
    licence: String(meta.license?.spdx_id || "NOASSERTION"),
    archs: phos?.archs,
    env: Array.isArray(phos?.env)
      ? (phos.env as any[])
          .filter((e) => typeof e?.name === "string")
          .map((e): EnvField => ({ ...e, label: String(e.label ?? e.name) }))
      : [],
  };
  let def: AppDef;
  let c: Compose | undefined;
  try {
    if (text) c = parse(text);
  } catch {}
  if (c) {
    const dir = posix.dirname(composePath);
    def = finish(
      rebase(c, dir === "." ? "" : dir, (p) => paths.has(p)),
      parts,
    );
  }
  // no compose file, or one that doesn't parse: kept as it is for the check to say so
  else
    def = { ...finish({ services: {} } as Compose, parts), compose: text, env: parts.env, manifest: { volumes: [] } };
  def.manifest = overlay(def.manifest, phos);
  return { def, readme, tree };
}

// a repo opened, kept a while; errors kept a minute
export function openRepo(url: string, f: Fetch = (u, i) => fetch(u, i)): Promise<Opened> {
  const full = repoOf(url);
  if (!full) return Promise.reject(new GitHubError(400, "not a GitHub repo url"));
  const key = full.toLowerCase();
  const hit = cache.get(key);
  if (hit && now() - hit.at < OkMS) return hit.p;
  const p = open(full, f);
  cache.set(key, { at: now(), p });
  p.catch(() => {
    const cur = cache.get(key);
    if (cur?.p === p) cur.at = now() - OkMS + ErrMS;
  });
  return p;
}
