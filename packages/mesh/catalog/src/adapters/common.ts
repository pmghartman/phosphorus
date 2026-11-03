// what every adapter shares: the source's terms, a skipped app's reason, the
// last steps from a source's compose file to an AppDef
import type { AppDef, EnvField, PhosManifest, SourceId } from "@phosphorus/wire";
import { type Compose, dump } from "../compose.ts";
import { derive, envFields } from "../manifest.ts";

// an app a source has that phosphorus can't take, and why
export class Skip extends Error {}

export interface Adapter {
  id: Exclude<SourceId, "github">;
  name: string;
  // owner/repo on GitHub, and its licence as an SPDX id
  repo: string;
  licence: string;
  // a tarball path as its app's folder and the path under it; undefined for the rest
  split(path: string): [string, string] | undefined;
  // whether a path under an app's folder is read
  wants(rel: string): boolean;
  // one app's read files, by path under its folder
  adapt(ref: string, files: Record<string, string>): AppDef;
}

// a name as an id: [a-z0-9-], a letter first, at most 40
export function slug(s: string): string {
  let out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z]/.test(out)) out = "app-" + out;
  return out.slice(0, 40).replace(/-+$/, "");
}

// every string in v put through fn, keys left alone
export function mapStrings(v: unknown, fn: (s: string) => string): any {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, fn));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, fn)]));
  return v;
}

// a service's labels without the ones the source's own proxy or manager reads
export function dropLabels(s: Record<string, any>, drop: RegExp) {
  const l = s.labels;
  if (Array.isArray(l)) s.labels = l.filter((x) => !drop.test(String(x).split("=")[0]!));
  else if (l && typeof l === "object") for (const k of Object.keys(l)) if (drop.test(k)) delete l[k];
  if (Array.isArray(s.labels) ? !s.labels.length : s.labels && !Object.keys(s.labels).length) delete s.labels;
}

// named volumes the services use declared at the top, as compose wants
export function declareVolumes(c: Compose) {
  for (const s of Object.values(c.services))
    for (const v of Array.isArray(s.volumes) ? s.volumes : []) {
      const src = typeof v === "string" ? v.split(":")[0]! : v?.type === "volume" ? v.source : "";
      if (!src || /^[./~$]/.test(src)) continue;
      c.volumes ??= {};
      c.volumes[src] ??= {};
    }
}

export interface Parts {
  source: SourceId;
  ref: string;
  id: string;
  name: string;
  tagline?: string;
  description?: string;
  icon?: string;
  category?: string;
  repo?: string;
  licence: string;
  archs?: unknown;
  env?: EnvField[];
  web?: PhosManifest["web"];
}

// the compose as rendered, its env fields and derived manifest
export function finish(c: Compose, p: Parts): AppDef {
  // obsolete, compose warns of it
  delete c.version;
  const compose = dump(c);
  return {
    id: p.id,
    source: p.source,
    ref: p.ref,
    name: p.name,
    tagline: p.tagline ?? "",
    description: p.description ?? "",
    icon: p.icon ?? "",
    category: (p.category ?? "").toLowerCase(),
    repo: p.repo ?? "",
    licence: p.licence,
    archs: Array.isArray(p.archs) ? p.archs.map(String) : [],
    compose,
    env: envFields(compose, p.env ?? []),
    manifest: derive(c, p.web),
  };
}
