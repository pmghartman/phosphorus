// whether an app installs, and where: a pure function of the app, the person's
// values, the hosts as their info tells them and what the registries said of
// its images; and the small fetcher that asks the registries first
import { type AppDef, type CheckItem, type CheckResult, fromRepo, type HostFit } from "@phosphorus/wire";
import { type Compose, interpolate, parse, ports } from "./compose.ts";
import { archsOf, type Fetch, type ImageInfo, normArch } from "./registry.ts";

// a place the app might go: the tailnet's os, and what its own info says
export interface HostFacts {
  host: string;
  os?: string;
  platform?: string;
  // docker's name for its cpu: amd64, arm64, arm
  arch?: string;
  // os-release's ID and ID_LIKE
  distro?: string;
  // Docker there as packages/stacks reports it (HostInfo.docker); absent before it does
  docker?: { state?: HostFit["docker"]; arch?: string; version?: string; error?: string } | null;
  listening?: number[];
}

// stand-ins for what phosphorus fills at render, so the file parses as it will
const stand: Record<string, string> = {
  APP_DATA: "/phos/data",
  APP_REPO: "/phos/repo",
  PUID: "1000",
  PGID: "1000",
  TZ: "UTC",
  APP_URL: "https://app.example",
  APP_DOMAIN: "app.example",
};

// the compose file with the person's values, the fields' defaults and the stand-ins put in
export function rendered(def: AppDef, env: Record<string, string>): Compose {
  const values: Record<string, string> = { ...stand };
  for (const f of def.env) {
    if (f.default !== undefined) values[f.name] = f.default;
    if (f.secret) values[f.name] = "secret";
  }
  Object.assign(values, env);
  return parse(interpolate(def.compose, values));
}

// the images the app pulls, those it builds left out
export function imagesOf(c: Compose): string[] {
  const out = new Set<string>();
  for (const s of Object.values(c.services)) if (typeof s.image === "string" && !s.build) out.add(s.image);
  return [...out];
}

const isDebian = (d = "") => /\b(debian|ubuntu)\b/i.test(d);

// a host's docker fit, before the app's own needs: packages/stacks' word when
// it has looked, else the platform's and distro's
function dockerFit(h: HostFacts): Pick<HostFit, "docker" | "why"> {
  const plat = (h.platform || h.os || "").toLowerCase();
  if (plat && plat !== "linux") return { docker: "unsupported", why: "needs Linux + Docker" };
  const st = h.docker?.state;
  if (st === "present" || st === "installable") return { docker: st };
  if (st === "unsupported") return { docker: st, why: h.docker?.error || "Docker can't be installed here" };
  if (isDebian(h.distro)) return { docker: "installable" };
  return { docker: "unsupported", why: "no Docker found, and phosphorus installs it on Debian or Ubuntu only" };
}

export function check(
  def: AppDef,
  env: Record<string, string>,
  hosts: HostFacts[],
  images: Record<string, ImageInfo>,
): CheckResult {
  const items: CheckItem[] = [];
  const block = (text: string) => items.push({ level: "block", text });
  const warn = (text: string) => items.push({ level: "warn", text });
  const ok = (text: string) => items.push({ level: "ok", text });

  let c: Compose | undefined;
  if (!def.compose.trim()) block("no Docker Compose file");
  else
    try {
      c = rendered(def, env);
      ok("compose file parses");
    } catch (e) {
      block(e instanceof Error ? e.message : String(e));
    }

  // the host ports the app publishes
  const published = new Set<number>();
  // the images whose platforms are known, by image
  const known: [string, string[]][] = [];
  if (c) {
    for (const [n, s] of Object.entries(c.services)) {
      if (s.build) {
        if (fromRepo(def)) ok(`builds ${n} from the repo`);
        else block(`${n} builds from source, which only a repo opened from GitHub can`);
      } else if (typeof s.image !== "string" || !s.image) block(`${n} has no image`);
      if (s.privileged) warn(`${n} runs privileged`);
      if (s.network_mode === "host") warn(`${n} uses the host's network`);
      if (Array.isArray(s.devices) && s.devices.length) warn(`${n} uses host devices`);
      if (Array.isArray(s.cap_add) && s.cap_add.length) warn(`${n} adds capabilities: ${s.cap_add.join(", ")}`);
      for (const p of ports(s)) if (p.host) published.add(p.host);
    }
    for (const image of imagesOf(c)) {
      const info = images[image];
      if (!info) warn(`image ${image} not checked`);
      else if ("archs" in info) {
        if (info.archs.length) known.push([image, info.archs]);
        ok(`image ${image}${info.archs.length ? ` for ${info.archs.join(", ")}` : ""}`);
      } else if (info.missing) block(info.error);
      else warn(`image ${image} not checked: ${info.error}`);
    }
  }

  const missing = def.env
    .filter((f) => f.required && !f.secret && f.default === undefined && !env[f.name])
    .map((f) => f.name);
  if (missing.length) warn(`needs ${missing.join(", ")}`);

  const fits: HostFit[] = hosts.map((h) => {
    const arch = normArch(h.arch || h.docker?.arch || "");
    const fit: HostFit = { host: h.host, ok: false, arch, ...dockerFit(h) };
    const why: string[] = fit.why ? [fit.why] : [];
    if (arch) {
      const lacking = known.filter(([, a]) => !a.includes(arch)).map(([i]) => i);
      if (lacking.length) why.push(`no ${arch} image for ${lacking.join(", ")}`);
      else if (!known.length && def.archs.length && !def.archs.map(normArch).includes(arch))
        why.push(`made for ${def.archs.join(", ")}, not ${arch}`);
    }
    fit.ok = !why.length;
    const taken = [...published].filter((p) => h.listening?.includes(p)).sort((a, b) => a - b);
    if (taken.length) {
      const t = `port${taken.length > 1 ? "s" : ""} ${taken.join(", ")} taken on ${h.host}`;
      warn(t);
      why.push(t);
    }
    if (why.length) fit.why = why.join("; ");
    return fit;
  });
  if (hosts.length && !fits.some((f) => f.ok)) block("no host on the mesh can run it");

  const verdict = items.some((i) => i.level === "block") ? "blocked" : missing.length ? "needs-input" : "installable";
  return { verdict, items, missing, hosts: fits };
}

// the registries asked of every image the app pulls, then the check
export async function checkApp(
  def: AppDef,
  env: Record<string, string>,
  hosts: HostFacts[],
  f: Fetch = (url, init) => fetch(url, init),
): Promise<CheckResult> {
  const images: Record<string, ImageInfo> = {};
  try {
    const list = imagesOf(rendered(def, env)).filter((i) => !i.includes("$"));
    await Promise.all(list.map(async (i) => void (images[i] = await archsOf(i, f))));
  } catch {}
  return check(def, env, hosts, images);
}
