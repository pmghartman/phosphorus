// which platforms an image is built for: its registry's manifest list, asked
// anonymously (Docker Hub, ghcr.io, lscr.io, quay.io, any registry's bearer
// challenge), kept a while
import { errText, now } from "@phosphorus/util";

// fetch, or a test's stand-in
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export type ImageInfo = { archs: string[] } | { error: string; missing?: boolean };

const OkMS = 6 * 3600 * 1000;
const ErrMS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; info: ImageInfo }>();

// an image's registry host, repository and tag or digest
export function parseRef(image: string): { host: string; repo: string; ref: string } {
  let rest = image;
  let ref = "latest";
  const at = rest.indexOf("@");
  if (at >= 0) {
    ref = rest.slice(at + 1);
    rest = rest.slice(0, at);
  } else {
    const colon = rest.lastIndexOf(":");
    if (colon > rest.lastIndexOf("/")) {
      ref = rest.slice(colon + 1);
      rest = rest.slice(0, colon);
    }
  }
  const parts = rest.split("/");
  let host = "registry-1.docker.io";
  if (parts.length > 1 && /[.:]|^localhost$/.test(parts[0]!)) host = parts.shift()!;
  if (host === "docker.io" || host === "index.docker.io") host = "registry-1.docker.io";
  // lscr.io is linuxserver's name for their ghcr.io images
  if (host === "lscr.io") host = "ghcr.io";
  if (host === "registry-1.docker.io" && parts.length === 1) parts.unshift("library");
  return { host, repo: parts.join("/"), ref };
}

// "arm" with its variant dropped, as hosts report themselves
export const normArch = (a: string) =>
  ({ x86_64: "amd64", aarch64: "arm64", armv7l: "arm", armhf: "arm", x64: "amd64" })[a] ?? a;

const accept = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// a GET, answering the registry's bearer challenge with an anonymous token
async function get(f: Fetch, url: string, h: Record<string, string>, token: { v?: string }): Promise<Response> {
  const go = () => f(url, { headers: token.v ? { ...h, Authorization: `Bearer ${token.v}` } : h });
  let res = await go();
  if (res.status !== 401 || token.v) return res;
  const ch = res.headers.get("www-authenticate") ?? "";
  if (!/^bearer /i.test(ch)) return res;
  const p = Object.fromEntries([...ch.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!.toLowerCase(), m[2]!]));
  if (!p.realm) return res;
  const q = new URLSearchParams();
  if (p.service) q.set("service", p.service);
  if (p.scope) q.set("scope", p.scope);
  const t = await f(`${p.realm}?${q}`);
  if (!t.ok) return res;
  const j = (await t.json()) as Record<string, any>;
  token.v = j.token ?? j.access_token;
  if (!token.v) return res;
  res = await go();
  return res;
}

async function lookup(image: string, f: Fetch): Promise<ImageInfo> {
  const { host, repo, ref } = parseRef(image);
  const base = `https://${host}/v2/${repo}`;
  const token: { v?: string } = {};
  const res = await get(f, `${base}/manifests/${ref}`, { Accept: accept }, token);
  if (res.status === 404 || res.status === 401 || res.status === 403)
    return { error: `${image} not found (or private)`, missing: true };
  if (res.status === 429) return { error: `${host} is limiting requests` };
  if (!res.ok) return { error: `${host}: HTTP ${res.status}` };
  const m = (await res.json()) as Record<string, any>;
  if (Array.isArray(m.manifests)) {
    const archs = new Set<string>();
    for (const x of m.manifests) {
      const p = x?.platform;
      if (p && p.os === "linux" && p.architecture && p.architecture !== "unknown") archs.add(normArch(p.architecture));
    }
    return { archs: [...archs].sort() };
  }
  // one image: its config says its platform
  const digest = m.config?.digest;
  if (!digest) return { error: `${image}: a manifest without a config` };
  const c = await get(f, `${base}/blobs/${digest}`, {}, token);
  if (!c.ok) return { error: `${host}: HTTP ${c.status} for ${image}'s config` };
  const cfg = (await c.json()) as Record<string, any>;
  return { archs: cfg.architecture ? [normArch(cfg.architecture)] : [] };
}

export async function archsOf(image: string, f: Fetch = (url, init) => fetch(url, init)): Promise<ImageInfo> {
  const hit = cache.get(image);
  if (hit && now() - hit.at < ("archs" in hit.info ? OkMS : ErrMS)) return hit.info;
  let info: ImageInfo;
  try {
    info = await lookup(image, f);
  } catch (e) {
    info = { error: `couldn't ask the registry for ${image}: ${errText(e)}` };
  }
  cache.set(image, { at: now(), info });
  return info;
}

export const clearCache = () => cache.clear();
