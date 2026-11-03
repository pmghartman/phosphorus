// the installer's catalogue half of /api/stacks: phosphorus's own apps, apps from
// the catalogues fetched at run time (CasaOS, Runtipi, Cosmos) and from GitHub repos opened by
// url, each normalized to an AppDef (@phosphorus/wire), and the check of whether
// it installs and where. packages/stacks installs what's picked
import { readFileSync } from "node:fs";
import { listening } from "@phosphorus/services";
import { env, errText, logf, now } from "@phosphorus/util";
import type { AppPage, AppSummary, SourceInfo } from "@phosphorus/wire";
import * as catalogs from "./catalogs.ts";
import { checkApp, type HostFacts } from "./check.ts";
import { GitHubError, type Opened, openRepo } from "./github.ts";
import { normArch } from "./registry.ts";

export { adapters, build, setup } from "./catalogs.ts";
export { check, checkApp, type HostFacts, rendered } from "./check.ts";
export { forgejo } from "./featured.ts";
export { GitHubError, openRepo, repoOf, setHosts } from "./github.ts";
export { derive, envFields } from "./manifest.ts";
export { archsOf, type ImageInfo, parseRef } from "./registry.ts";

type Res = [number, any];

export interface Hooks {
  // this host's tailnet address, where its listening ports are looked for
  ip: () => Promise<string>;
  // every phosphorus host as a place to install
  hosts: () => HostFacts[];
  // the ids the mesh has installed (etc/stacks)
  installed?: () => Set<string>;
}

let hooks: Hooks | undefined;
const HourMS = 3600 * 1000;
const PortsMS = 60 * 1000;

// --- this host's facts, for its info ----------------------------------------------

let ports: number[] | undefined;
let portsAt = 0;

async function scanPorts() {
  if (!hooks || now() - portsAt < PortsMS) return;
  portsAt = now();
  try {
    const open = await listening(await hooks.ip());
    if (open) ports = [...open].sort((a, b) => a - b);
  } catch {}
}

function readDistro(): string {
  if (process.platform !== "linux") return "";
  try {
    const t = readFileSync("/etc/os-release", "utf8");
    const get = (k: string) => new RegExp(`^${k}="?([^"\\n]*)"?$`, "m").exec(t)?.[1] ?? "";
    return [get("ID"), get("ID_LIKE")].filter(Boolean).join(" ");
  } catch {
    return "";
  }
}
const distro = readDistro();

// this host's cpu, distro and listening ports, for HostInfo
export function facts(): { arch: string; distro?: string; listening?: number[] } {
  return { arch: normArch(process.arch), distro: distro || undefined, listening: ports };
}

// --- the catalogues, fetched now and then ------------------------------------------

// CATALOG_FETCH=0: the catalogues never fetched (tests), what's cached still read
const fetching = env("CATALOG_FETCH", "1") !== "0";

export function start(h: Hooks) {
  hooks = h;
  const refresh = () => {
    if (fetching) catalogs.refreshAll().catch((e) => logf("[catalog] refresh: %s", errText(e)));
  };
  // after the server's own start, so a first fetch never slows it
  setTimeout(() => {
    refresh();
    void scanPorts();
  }, 5000);
  setInterval(() => void scanPorts(), PortsMS);
  setInterval(refresh, HourMS);
}

const hostsNow = () => hooks?.hosts() ?? [];

// --- the routes ------------------------------------------------------------------

// GET /api/stacks/catalog?q=&source=&category=
export function catalogRoute(q: URLSearchParams): Res {
  const installed = hooks?.installed?.() ?? new Set<string>();
  const apps: AppSummary[] = catalogs
    .search({ q: q.get("q") ?? "", source: q.get("source") ?? "", category: q.get("category") ?? "" })
    .map((d) => (installed.has(d.id) ? { ...catalogs.summary(d), installed: true } : catalogs.summary(d)));
  const sources: SourceInfo[] = catalogs.sources();
  return [200, { sources, apps }];
}

const ghErr = (e: unknown): Res =>
  e instanceof GitHubError ? [e.status, { error: e.message }] : [502, { error: errText(e) }];

async function page(o: Opened | undefined, source: string, ref: string): Promise<Res> {
  if (o) return [200, { ...o, check: await checkApp(o.def, {}, hostsNow()) } satisfies AppPage];
  const def = catalogs.find(source, ref);
  if (!def) return [404, { error: `no app ${ref} in ${source}` }];
  const p: AppPage = {
    def,
    readme: def.description,
    tree: catalogs.tree(source, ref),
    check: await checkApp(def, {}, hostsNow()),
  };
  return [200, p];
}

// GET /api/stacks/app/<source>/<ref>; a github ref is owner/repo
export async function appRoute(source: string, ref: string): Promise<Res> {
  if (source === "github") {
    try {
      return await page(await openRepo(ref), source, ref);
    } catch (e) {
      return ghErr(e);
    }
  }
  if (source !== "phosphorus" && !catalogs.adapters.some((a) => a.id === source))
    return [404, { error: `no source ${source}` }];
  return page(undefined, source, ref);
}

// POST /api/stacks/repo { url }
export async function repoRoute(p: Record<string, any>): Promise<Res> {
  if (typeof p.url !== "string" || !p.url) return [400, { error: "give a GitHub repo url" }];
  try {
    return await page(await openRepo(p.url), "github", "");
  } catch (e) {
    return ghErr(e);
  }
}

// POST /api/stacks/check { source, ref, env }
export async function checkRoute(p: Record<string, any>): Promise<Res> {
  const source = String(p.source ?? "");
  const ref = String(p.ref ?? "");
  const env: Record<string, string> = {};
  if (p.env && typeof p.env === "object" && !Array.isArray(p.env))
    for (const [k, v] of Object.entries(p.env)) if (typeof v === "string") env[k] = v;
  let def = catalogs.find(source, ref);
  if (source === "github") {
    try {
      def = (await openRepo(ref)).def;
    } catch (e) {
      return ghErr(e);
    }
  }
  if (!def) return [404, { error: `no app ${ref} in ${source}` }];
  return [200, await checkApp(def, env, hostsNow())];
}

// the app a source and ref name, for packages/stacks' install and update
export async function defOf(source: string, ref: string) {
  if (source === "github") return (await openRepo(ref)).def;
  return catalogs.find(source, ref);
}
