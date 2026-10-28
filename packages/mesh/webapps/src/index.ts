// optional apps for the mesh: web builds from a catalogue, the one an admin
// picks installed onto every host from its signed feed, each host serving
// its own copy under the app's path, beside the desktop
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, posix } from "node:path";
import { newer } from "@phosphorus/appfeed";
import { markHot } from "@phosphorus/util";
import { parsePublicKey } from "@phosphorus/minisign";
import * as store from "@phosphorus/store";
import { untar } from "@phosphorus/tools";
import { env, errText, FrontendPort, ini, logf as log, now, obj, readJSON, SelfHost, StateDir, writeJSONAtomic } from "@phosphorus/util";
import { RepoIcon, summary as svcSummaryFn } from "./services.ts";

const logf = (f: string, ...a: unknown[]) => log("[apps] " + f, ...a);

// one app the mesh can take: its feed's entry names the page's tarball; mount
// is where every host serves it, the same folder inside the tarball; the rest
// is what the apps page shows of it
export type App = {
  id: string; name: string; tagline: string; about: string; features: string[]; category: string; by: string;
  repo: string; feed: string; mount: string; icon: string;
  // the icon's path in the repository, shown before any host serves the app
  repoIcon: string;
  // the agents it asks the mesh's models as, listed in the agents app while installed
  agents?: string[];
};

export const Catalog: App[] = [
  {
    id: "sulfur",
    name: "Sulfur",
    tagline: "a code editor for distributed systems",
    about: "Feels like VS Code: palette, completion, extensions from Open VSX, themes. Every host's files and the merged home, live collaboration on every file, terminals, builds, git and SQLite on any machine, and language servers for ten languages, run on the host that has the toolchain.",
    features: ["live collaboration on every file", "terminals, builds and git on any host", "language servers native for ten languages", "extensions from Open VSX", "a chat and inline completions on the mesh's models"],
    category: "developer tools",
    by: "rpmull",
    repo: "https://github.com/rpmull/sulfur",
    feed: env("SULFUR_FEED_URL", "https://github.com/rpmull/sulfur/releases/download/update/sulfur-web.json"),
    mount: "/sulfur/",
    icon: "/sulfur/icon.svg",
    repoIcon: "web/static/sulfur/icon.svg",
    agents: ["agent-sulfur", "agent-sulfur-fast"],
  },
];

export const appOf = (id: string) => Catalog.find((a) => a.id === id);

// one feed entry: the newest page, its tarball, hash and minisign signature
export type Release = { version: string; url: string; sha256: string; signature: string };
// what the mesh runs: the release an admin picked, from the host that picked it
export type Want = Release & { from: string; at: number };
// this host's copy, as its info.json tells the mesh
export type Status = { version: string; busy?: boolean; error?: string };

const versionRe = /^\d+(\.\d+){0,3}$/;
const shaRe = /^[0-9a-f]{64}$/;

// the app's minisign key, when the admin set one: [apps] <id>_key in phosphorus.ini
export const keyOf = (id: string) => ini("apps", id + "_key").trim();

function release(v: unknown): Release | undefined {
  const o = obj(v);
  if (!o) return;
  const { version, url, sha256, signature } = o;
  if (typeof version !== "string" || !versionRe.test(version)) return;
  // over tls, or this machine's own server for a feed made here
  if (typeof url !== "string" || !/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\/)/.test(url)) return;
  if (typeof sha256 !== "string" || !shaRe.test(sha256)) return;
  return { version, url, sha256, signature: typeof signature === "string" ? signature : "" };
}

// --- the feed: the newest release per app, cached ----------------------------

const feedTTLMS = 600000;
const feedRetryMS = 30000;
type Feed = { at: number; latest?: Release; error: string };
const feeds = new Map<string, Feed>();
const fetching = new Map<string, Promise<Feed>>();

async function fetchFeed(app: App): Promise<Feed> {
  const f: Feed = { at: now(), error: "" };
  try {
    const r = await fetch(app.feed, { signal: AbortSignal.timeout(10000) });
    if (r.status < 200 || r.status >= 300) throw new Error(`feed answered ${r.status}`);
    const rel = release(await r.json());
    if (!rel) throw new Error("feed isn't a release: version, url, sha256");
    f.latest = rel;
  } catch (e) {
    // retried soon, not held for the whole ttl
    f.at = now() - feedTTLMS + feedRetryMS;
    f.error = errText(e);
  }
  feeds.set(app.id, f);
  return f;
}

// the app's newest release, from the feed when the cache has aged or force
export async function latest(app: App, force = false): Promise<Feed> {
  const cur = feeds.get(app.id);
  if (!force && cur && now() - cur.at <= feedTTLMS) return cur;
  let p = fetching.get(app.id);
  if (!p) {
    p = fetchFeed(app).finally(() => fetching.delete(app.id));
    fetching.set(app.id, p);
  }
  return p;
}

// --- what the mesh wants: etc/apps/<id>.json, the latest write winning -------

const wantRel = (id: string) => "etc/apps/" + id + ".json";

export function wantOf(id: string): Want | undefined {
  const o = obj(store.read(wantRel(id)));
  const rel = release(o);
  if (!rel || !o) return;
  return { ...rel, from: typeof o.from === "string" ? o.from : "", at: typeof o.at === "number" ? o.at : 0 };
}

export function wants(): Record<string, Want> {
  const out: Record<string, Want> = {};
  for (const a of Catalog) {
    const w = wantOf(a.id);
    if (w) out[a.id] = w;
  }
  return out;
}

// an admin's pick: the feed's newest release, every host following; [status, body]
export async function Install(id: string): Promise<[number, any]> {
  const app = appOf(id);
  if (!app) return [404, { error: `no app called ${id}` }];
  const f = await latest(app, true);
  if (!f.latest) return [502, { error: `${app.name}'s feed: ${f.error || "no release"}` }];
  const have = wantOf(id);
  if (have && have.version === f.latest.version && have.sha256 === f.latest.sha256) return [200, { ok: true, want: have, current: true }];
  const want: Want = { ...f.latest, from: SelfHost, at: now() };
  store.write(wantRel(id), want);
  logf("%s v%s picked for the mesh", app.name, want.version);
  markHot();
  void tick();
  return [200, { ok: true, want }];
}

// the app dropped from every host
export function Remove(id: string): [number, any] {
  const app = appOf(id);
  if (!app) return [404, { error: `no app called ${id}` }];
  store.remove(wantRel(id));
  logf("%s removed from the mesh", app.name);
  markHot();
  void tick();
  return [200, { ok: true }];
}

// --- this host's copies: state/apps/<id>/<version>/, the tarball beside it -----

const root = () => env("APPS_DIR", join(StateDir, "apps"));
const appDir = (id: string) => join(root(), id);
const versionDir = (id: string, v: string) => join(appDir(id), v);
const tarball = (id: string, v: string) => join(appDir(id), v + ".tar.gz");
const currentFile = (id: string) => join(appDir(id), "current.json");
// a copy fully unpacked, beside its folder so nothing of it is served
const okStamp = (id: string, v: string) => join(appDir(id), v + ".ok");

type Local = { version: string; sha256: string; busy: boolean; error: string; errorFor: string; at: number };
const locals = new Map<string, Local>();
const retryMS = 60000;

function local(id: string): Local {
  let l = locals.get(id);
  if (!l) {
    const cur = obj(readJSON(currentFile(id)));
    const version = typeof cur?.version === "string" && versionRe.test(cur.version) && existsSync(okStamp(id, cur.version)) ? cur.version : "";
    l = { version, sha256: version && typeof cur?.sha256 === "string" ? cur.sha256 : "", busy: false, error: "", errorFor: "", at: 0 };
    locals.set(id, l);
  }
  return l;
}

// each app's copy here, for info.json
export function installed(): Record<string, Status> {
  const out: Record<string, Status> = {};
  for (const a of Catalog) {
    const l = local(a.id);
    if (!l.version && !l.busy && !l.error) continue;
    const s: Status = { version: l.version };
    if (l.busy) s.busy = true;
    if (l.error) s.error = l.error;
    out[a.id] = s;
  }
  return out;
}

// the folder served for an installed app, "" with none
export const dirOf = (id: string) => {
  const l = local(id);
  return l.version ? versionDir(id, l.version) : "";
};

// the tarball of this host's copy, for a peer's GET /internal/apps/<id>/<version>
export function Serve(id: string, version: string): Response {
  const l = appOf(id) && versionRe.test(version) ? local(id) : undefined;
  const file = l && l.version === version ? tarball(id, version) : "";
  let size: number;
  try {
    if (!file) throw 0;
    size = statSync(file).size;
  } catch {
    return new Response(null, { status: 404 });
  }
  return new Response(Bun.file(file), { status: 200, headers: { "Content-Type": "application/gzip", "Content-Length": String(size) } });
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// the tarball against the release: its hash always, its signature when the
// admin gave the app's key
export function verify(app: App, r: Release, data: Uint8Array) {
  if (sha256(data) !== r.sha256) throw new Error("the download's hash doesn't match the release");
  const key = keyOf(app.id);
  if (!key) return;
  if (!r.signature) throw new Error("the release is unsigned, and [apps] " + app.id + "_key is set");
  try {
    parsePublicKey(key).verify(data, r.signature);
  } catch (e) {
    throw new Error("the download's signature doesn't match [apps] " + app.id + "_key: " + errText(e));
  }
}

export type IPOf = (host: string) => string | Promise<string>;

// what a peer already fetched and checked, over the tailnet; undefined to go to the feed
async function fromPeer(app: App, w: Want, ipOf: IPOf, port: number): Promise<Uint8Array | undefined> {
  if (!w.from || w.from === SelfHost) return;
  const ip = await ipOf(w.from);
  if (!ip) return;
  try {
    const res = await fetch(`http://${ip}:${port}/internal/apps/${app.id}/${w.version}`, { signal: AbortSignal.timeout(120000) });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      return;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    verify(app, w, data);
    return data;
  } catch (e) {
    logf("%s v%s from %s: %s; the feed instead", app.name, w.version, w.from, errText(e));
  }
}

async function fromFeed(app: App, w: Want): Promise<Uint8Array> {
  const res = await fetch(w.url, { signal: AbortSignal.timeout(15 * 60000) });
  if (res.status !== 200) throw new Error(`download answered ${res.status}`);
  const data = new Uint8Array(await res.arrayBuffer());
  verify(app, w, data);
  return data;
}

// the tarball unpacked into <version>.part, the mount's index.html checked,
// then swapped in; every other version gone
export function unpack(app: App, w: Want, data: Uint8Array) {
  const dir = versionDir(app.id, w.version);
  const part = dir + ".part";
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  try {
    untar(data, part, 0);
    const index = join(part, mountDir(app), "index.html");
    if (!existsSync(index)) throw new Error(`no ${mountDir(app)}/index.html in the tarball`);
  } catch (e) {
    rmSync(part, { recursive: true, force: true });
    throw e;
  }
  writeFileSync(tarball(app.id, w.version), data);
  rmSync(dir, { recursive: true, force: true });
  rmSync(okStamp(app.id, w.version), { force: true });
  renameSync(part, dir);
  writeFileSync(okStamp(app.id, w.version), w.sha256 + "\n");
  writeJSONAtomic(currentFile(app.id), { version: w.version, sha256: w.sha256 });
  for (const n of readdirSync(appDir(app.id))) {
    if (n === w.version || n === w.version + ".tar.gz" || n === w.version + ".ok" || n === "current.json") continue;
    rmSync(join(appDir(app.id), n), { recursive: true, force: true });
  }
}

async function settle(app: App, ipOf: IPOf, port: number) {
  const w = wantOf(app.id);
  const l = local(app.id);
  if (!w) {
    if (!l.version && !existsSync(appDir(app.id))) return;
    rmSync(appDir(app.id), { recursive: true, force: true });
    if (l.version) logf("%s v%s removed here", app.name, l.version);
    Object.assign(l, { version: "", sha256: "", error: "", errorFor: "" });
    markHot();
    return;
  }
  if (w.version === l.version && w.sha256 === l.sha256) return;
  const key = w.version + " " + w.sha256;
  if (l.error && l.errorFor === key && now() - l.at < retryMS) return;
  l.busy = true;
  markHot();
  try {
    const data = (await fromPeer(app, w, ipOf, port)) ?? (await fromFeed(app, w));
    unpack(app, w, data);
    Object.assign(l, { version: w.version, sha256: w.sha256, error: "", errorFor: "" });
    logf("%s v%s installed here, served at %s", app.name, w.version, app.mount);
  } catch (e) {
    Object.assign(l, { error: errText(e), errorFor: key, at: now() });
    logf("%s v%s: %s", app.name, w.version, l.error);
  } finally {
    l.busy = false;
    markHot();
  }
}

// a peer's frontend: its tailnet ip, and the port, from Start
let ipOfHost: IPOf = () => "";
let peerPort = FrontendPort;
let ticking: Promise<void> | undefined;

// one round: every app brought to what the mesh wants
export function tick(ipOf: IPOf = ipOfHost, port = peerPort): Promise<void> {
  return (ticking ??= (async () => {
    for (const a of Catalog) await settle(a, ipOf, port);
  })().finally(() => (ticking = undefined)));
}

// the follow loop
export function Start(ipOf: IPOf, port = FrontendPort, tickMS = 3000) {
  ipOfHost = ipOf;
  peerPort = port;
  for (const a of Catalog) local(a.id);
  setInterval(() => void tick(), tickMS);
  void tick();
}

// for tests: the caches and copies forgotten
export function reset() {
  locals.clear();
  feeds.clear();
}

// --- the page served: the app's folder under its mount, its root files beside the desktop's ---

const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".gif": "image/gif",
  ".wasm": "application/wasm", ".map": "application/json", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
};
// a content-hashed name, kept for good
const hashedRe = /[-.][A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/;

// the mount's folder in the tarball: /sulfur/ is sulfur/
const mountDir = (app: App) => app.mount.replace(/^\/+|\/+$/g, "");

// a request path as a clean relative path, undefined when it escapes
function cleanPath(pathname: string): string | undefined {
  let p: string;
  try {
    p = decodeURIComponent(pathname);
  } catch {
    return;
  }
  if (p.includes("\0")) return;
  const rel = posix.normalize("/" + p.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (rel.split("/").includes("..")) return;
  return rel;
}

function fileAt(abs: string): number {
  try {
    const st = statSync(abs);
    return st.isFile() ? st.size : -1;
  } catch {
    return -1;
  }
}

function sendFile(req: Request, abs: string, size: number): Response {
  const ext = extname(abs).toLowerCase();
  const h = new Headers({
    "Content-Type": types[ext] ?? "application/octet-stream",
    "Content-Length": String(size),
    "Cache-Control": hashedRe.test(abs) ? "public, max-age=31536000, immutable" : "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(req.method === "HEAD" ? null : Bun.file(abs), { status: 200, headers: h });
}

// the installed app whose mount the path is under, and the file asked
export function mounted(pathname: string): { app: App; rel: string } | undefined {
  for (const app of Catalog) {
    if (!dirOf(app.id)) continue;
    const m = app.mount.replace(/\/$/, "");
    if (pathname === m || pathname.startsWith(app.mount)) return { app, rel: pathname === m ? "" : pathname.slice(app.mount.length) };
  }
}

// an installed app's file for a request: under its mount, its folder, a missing
// page there the app's own index.html; elsewhere, a root file beside the
// desktop's own; undefined when no app answers
export function serve(req: Request): Response | undefined {
  const url = new URL(req.url);
  if (req.method !== "GET" && req.method !== "HEAD") return;
  const m = mounted(url.pathname);
  if (m) {
    // the bare mount sent to its folder, so its relative files resolve
    if (url.pathname === m.app.mount.replace(/\/$/, "")) return Response.redirect(m.app.mount + url.search, 308);
    const root = dirOf(m.app.id);
    const rel = cleanPath(m.rel);
    if (rel === undefined) return new Response("not found", { status: 404 });
    const base = join(root, mountDir(m.app));
    const want = rel === "" || rel.endsWith("/") ? join(base, rel, "index.html") : join(base, rel);
    let size = fileAt(want);
    if (size >= 0) return sendFile(req, want, size);
    // a route of the page's own, when a page is what's asked
    if (!extname(rel) || (req.headers.get("accept") ?? "").includes("text/html")) {
      const index = join(base, "index.html");
      size = fileAt(index);
      if (size >= 0) return sendFile(req, index, size);
    }
    return new Response("not found", { status: 404 });
  }
  const rel = cleanPath(url.pathname);
  if (!rel || rel.endsWith("/")) return;
  for (const app of Catalog) {
    const root = dirOf(app.id);
    if (!root) continue;
    const abs = join(root, rel);
    const size = fileAt(abs);
    if (size >= 0) return sendFile(req, abs, size);
  }
}

// --- the page's read: the catalogue with what the mesh wants and the feed says ---

export async function summary(fresh: boolean): Promise<Record<string, any>> {
  const services = svcSummaryFn();
  const apps = await Promise.all(Catalog.map(async (a) => {
    const f = await latest(a, fresh);
    const l = local(a.id);
    return {
      id: a.id, name: a.name, tagline: a.tagline, about: a.about, features: a.features, category: a.category, by: a.by,
      repo: a.repo, mount: a.mount, icon: a.icon, repoIcon: appIconPath(a.id), agents: a.agents ?? [],
      want: wantOf(a.id) ?? null,
      latest: f.latest ? f.latest.version : "", feedError: f.error, checkedAt: f.at,
      local: { version: l.version, busy: l.busy, error: l.error },
      signed: !!keyOf(a.id),
    };
  }));
  return { apps, services: await services };
}

export { newer };

export const appIconPath = (id: string) => `/api/apps/${id}/icon`;

// an app's icon off its repository, for the page before any host serves the app
export async function AppIcon(id: string): Promise<{ data: Uint8Array; type: string } | undefined> {
  const a = appOf(id);
  return a ? RepoIcon({ id: a.id, name: a.name, repo: a.repo, icon: a.repoIcon }) : undefined;
}

// the services beside the apps: a checkout per host, run as a person's own login
export {
  behindMain as svcBehindMain, type Device as SvcDevice, type HostView as SvcHostView, Icon as svcIcon, iconPath as svcIconPath, type Job as SvcJob, jobOf as svcJobOf,
  jobs as svcJobs, type JobView as SvcJobView, launch as svcLaunch, type Login as SvcLogin, type Op as SvcOp, Ops as SvcOps, opTimeoutMS as svcTimeoutMS, progress as svcProgress,
  type Progress as SvcProgress, type PublishLocal as SvcPublishLocal, type Record_ as SvcRecord, recordOf as svcRecordOf, records as svcRecords, repoOf as svcRepoOf,
  reset as svcReset, type Route as SvcRoute, type Runner as SvcRunner, script as svcScript, seams as svcSeams, type Service, serviceOf, ServiceOp, Services,
  Start as StartServices, summary as svcSummary, tick as svcTick, unitOf as svcUnitOf,
} from "./services.ts";
