// this host's copies: <phosphorus>/stacks/<id>/ with compose.yml, .env and data/,
// each brought to what the mesh wants. The active host pulls and runs it, its web
// page published; a standby pulls and stays down; a host in neither role takes its
// copy down. Every install, update or removal a job, its log's tail in this host's info
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as store from "@phosphorus/store";
import {
  env,
  errText,
  ini,
  markHot,
  now,
  obj,
  RepoDir,
  readJSON,
  run,
  SelfHost,
  writeJSONAtomic,
} from "@phosphorus/util";
import type { StackRole, StackStatus, StackWant } from "@phosphorus/wire";
import { detect, docker, dockerBin, dockerInfo, exec, installDocker, logf } from "./docker.ts";
import { idRe } from "./ids.ts";
import type { Runtime } from "./index.ts";
import { type Ctx, envText, render } from "./render.ts";
import { seams } from "./seams.ts";
import { dockerRel, ids, keepDataOf, opened, wantOf } from "./want.ts";

export const root = () => env("STACKS_DIR", join(RepoDir, "stacks"));
export const dirOf = (id: string) => join(root(), id);
const composeFile = (id: string) => join(dirOf(id), "compose.yml");
const appliedFile = (id: string) => join(dirOf(id), ".phos.json");
export const logFile = (id: string) => join(dirOf(id), ".job.log");
const dockerLog = () => join(root(), ".docker.log");

export const logTail = 4 << 10;
// how long each step may run: a first pull of a big image takes a while
const pullMS = 30 * 60000;
const upMS = 10 * 60000;
const downMS = 5 * 60000;
const retryMS = 60000;
const checkMS = 15000;
// a finished job shown this long, then dropped from the info
const jobShownMS = 10 * 60000;

type Op = NonNullable<StackStatus["job"]>["op"];

// what this host last brought its copy to, kept beside it
type Applied = { gen: number; role: StackRole; hash: string; webPort: number; published: number };

type Local = Applied & {
  running: boolean;
  healthy?: boolean;
  checkedAt: number;
  job?: { op: Op; done: boolean; ok?: boolean; at: number };
  error: string;
  errorFor: string;
  errorAt: number;
  // stopped by failover, not brought back up by the loop until up() or a new gen
  held: boolean;
  upAt: number;
};

const locals = new Map<string, Local>();

function local(id: string): Local {
  let l = locals.get(id);
  if (!l) {
    const a = obj(readJSON(appliedFile(id)));
    const role = a?.role === "active" || a?.role === "standby" ? a.role : "none";
    l = {
      gen: typeof a?.gen === "number" ? a.gen : 0,
      role,
      hash: typeof a?.hash === "string" ? a.hash : "",
      webPort: typeof a?.webPort === "number" ? a.webPort : 0,
      published: typeof a?.published === "number" ? a.published : 0,
      running: false,
      checkedAt: 0,
      error: "",
      errorFor: "",
      errorAt: 0,
      held: false,
      upAt: 0,
    };
    locals.set(id, l);
  }
  return l;
}

const saveApplied = (id: string, l: Local) =>
  writeJSONAtomic(appliedFile(id), {
    gen: l.gen,
    role: l.role,
    hash: l.hash,
    webPort: l.webPort,
    published: l.published,
  } satisfies Applied);

export const roleOf = (w: StackWant | undefined, host = SelfHost): StackRole =>
  !w ? "none" : w.active === host ? "active" : w.standbys.includes(host) ? "standby" : "none";

// a file's last n bytes as text, "" when there's none
export function tailOf(p: string, n: number): string {
  let fd: number;
  try {
    fd = openSync(p, "r");
  } catch {
    return "";
  }
  try {
    const size = statSync(p).size;
    const start = size > n ? size - n : 0;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const r = readSync(fd, buf, got, buf.length - got, start + got);
      if (!r) break;
      got += r;
    }
    let t = buf.subarray(0, got).toString("utf8");
    if (start > 0) t = t.slice(t.indexOf("\n") + 1);
    return t;
  } catch {
    return "";
  } finally {
    closeSync(fd);
  }
}

// --- docker compose ---------------------------------------------------------------

const project = (id: string) => `phos-${id}`;

// docker compose on the project, its output into the job's log
async function compose(id: string, args: string[], timeoutMs: number): Promise<void> {
  const bin = dockerBin();
  if (!bin) throw new Error("docker isn't installed");
  const argv = [bin, "compose", "-p", project(id), "--project-directory", dirOf(id), "-f", composeFile(id), ...args];
  note(id, `$ docker compose ${args.join(" ")}`);
  const code = await exec(argv, logFile(id), timeoutMs, dirOf(id));
  if (code !== 0) throw new Error(`docker compose ${args[0]} ${code < 0 ? "didn't finish" : `exited ${code}`}`);
}

const note = (id: string, line: string) => {
  try {
    writeFileSync(logFile(id), line + "\n", { flag: "a" });
  } catch {}
};

type PsRow = { Service?: string; State?: string; Health?: string };

// the project's containers as docker has them, by its label alone
async function ps(id: string): Promise<PsRow[] | undefined> {
  const bin = dockerBin();
  if (!bin) return;
  const r = await run([bin, "compose", "-p", project(id), "ps", "-a", "--format", "json"], { timeoutMs: 15000 });
  if (!r.ok) return;
  const t = r.stdout.trim();
  if (!t) return [];
  try {
    if (t.startsWith("[")) return JSON.parse(t) as PsRow[];
    return t.split("\n").map((l) => JSON.parse(l) as PsRow);
  } catch {
    return;
  }
}

// up when the web service runs, or any one when it has none
async function isRunning(id: string, web = wantOf(id)?.def.manifest.web): Promise<boolean> {
  const rows = (await ps(id)) ?? [];
  return rows.some((r) => r.State === "running" && (!web || r.Service === web.service));
}

// the manifest's health: the web page answering below 500, or docker's own health
// of the service named, or just running
async function healthOf(id: string, w: StackWant, l: Local): Promise<boolean | undefined> {
  const { health: h, web } = w.def.manifest;
  if (web && l.webPort && (!h || h.service === web.service)) {
    const ip = await seams.ipOf(SelfHost);
    if (!ip) return;
    try {
      const r = await fetch(`http://${ip}:${l.webPort}${h?.path ?? "/"}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      await r.body?.cancel().catch(() => {});
      return r.status < 500;
    } catch {
      return false;
    }
  }
  if (!h) return;
  const row = ((await ps(id)) ?? []).find((r) => r.Service === h.service);
  if (!row) return false;
  return row.Health ? row.Health === "healthy" : row.State === "running";
}

// --- publishing: [<id>] port = in this host's services.export --------------------

async function publish(id: string, l: Local, port: number) {
  if (l.published === port) return;
  const [st, b] = await seams.publish(id, { port: String(port) });
  if (st !== 200) throw new Error(`publishing: ${b?.error ?? `status ${st}`}`);
  l.published = port;
  saveApplied(id, l);
}

async function unpublish(id: string, l: Local) {
  if (!l.published) return;
  const [st, b] = await seams.publish(id, null);
  // nothing declared is as good as dropped
  if (st !== 200 && st !== 404 && !/no service/i.test(String(b?.error ?? "")))
    throw new Error(`unpublishing: ${b?.error ?? `status ${st}`}`);
  l.published = 0;
  saveApplied(id, l);
}

// --- the project's files -------------------------------------------------------

function ctxOf(id: string, ip: string): Ctx {
  let tz = ini("stacks", "tz") || "";
  if (!tz)
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      tz = "UTC";
    }
  return {
    dir: dirOf(id).replaceAll("\\", "/"),
    ip,
    puid: ini("stacks", "puid") || "1000",
    pgid: ini("stacks", "pgid") || "1000",
    tz,
    domain: env("BASE_DOMAIN"),
  };
}

type Plan = {
  compose: string;
  env: string;
  hash: string;
  webPort: number;
  dirs: string[];
  build: boolean;
  clone: boolean;
};

// the project as the want and this host make it; its hash says when it changed
async function plan(w: StackWant, role: StackRole): Promise<Plan> {
  const ip = await seams.ipOf(SelfHost);
  if (!ip) throw new Error("no tailnet address here yet");
  const [values, bad] = opened(w);
  if (bad.length) throw new Error(`${bad.join(", ")} won't open: sealed by another mesh`);
  const ctx = ctxOf(w.def.id, ip);
  const r = render(w.def, values, ctx);
  const envT = envText(w.def, values, ctx, r.webPort);
  const hash = createHash("sha256").update(`${role}\0${r.compose}\0${envT}`).digest("hex").slice(0, 32);
  return { ...r, env: envT, hash };
}

function writeProject(id: string, p: Plan) {
  mkdirSync(dirOf(id), { recursive: true, mode: 0o750 });
  mkdirSync(join(dirOf(id), "data"), { recursive: true });
  for (const d of p.dirs) mkdirSync(d, { recursive: true });
  writeFileSync(composeFile(id), p.compose, { mode: 0o600 });
  const envF = join(dirOf(id), ".env");
  writeFileSync(envF, p.env, { mode: 0o600 });
  try {
    chmodSync(envF, 0o600);
  } catch {}
}

// a repo-opened app's checkout in src/: cloned at its ref, or brought to it
async function checkout(id: string, w: StackWant) {
  const [repo, branch] = w.def.ref.split("@", 2) as [string, string | undefined];
  const url = /^https:\/\/github\.com\//.test(w.def.repo) ? w.def.repo : `https://github.com/${repo}`;
  const src = join(dirOf(id), "src");
  const git = Bun.which("git");
  if (!git) throw new Error("git isn't installed, and the app is built from its repo");
  const step = async (argv: string[]) => {
    note(id, `$ ${argv.join(" ")}`);
    const code = await exec([git, ...argv], logFile(id), upMS);
    if (code !== 0) throw new Error(`git ${argv[0] === "-C" ? argv[2] : argv[0]} exited ${code}`);
  };
  if (!existsSync(join(src, ".git"))) {
    rmSync(src, { recursive: true, force: true });
    await step(["clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), url, src]);
  } else {
    await step(["-C", src, "fetch", "--depth", "1", "origin", branch ?? "HEAD"]);
    await step(["-C", src, "reset", "--hard", "FETCH_HEAD"]);
  }
}

// --- jobs ------------------------------------------------------------------------

function begin(id: string, l: Local, op: Op) {
  mkdirSync(dirOf(id), { recursive: true });
  writeFileSync(logFile(id), "");
  l.job = { op, done: false, at: now() };
  markHot();
}

function end(id: string, l: Local, key: string, e?: unknown) {
  if (!l.job) return;
  l.job.done = true;
  l.job.ok = e === undefined;
  if (e === undefined) Object.assign(l, { error: "", errorFor: "" });
  else {
    Object.assign(l, { error: errText(e), errorFor: key, errorAt: now() });
    note(id, l.error);
  }
  logf("%s %s here: %s", l.job.op, id, e === undefined ? "done" : l.error);
  markHot();
}

// the copy brought to the want in its role: written, pulled, and run or held down
async function apply(id: string, w: StackWant, role: StackRole, p: Plan, op: Op) {
  const l = local(id);
  const key = `${w.gen}/${role}/${p.hash}`;
  begin(id, l, op);
  try {
    writeProject(id, p);
    if (p.clone) await checkout(id, w);
    await compose(id, ["pull", ...(p.build ? ["--ignore-buildable"] : [])], pullMS);
    if (role === "active") {
      if (p.build) await compose(id, ["build", "--pull"], pullMS);
      await compose(id, ["up", "-d", "--remove-orphans"], upMS);
      l.held = false;
      l.upAt = now();
      l.webPort = p.webPort;
      if (w.def.manifest.web) await publish(id, l, p.webPort);
      else await unpublish(id, l);
    } else {
      await unpublish(id, l);
      if (l.role === "active" || (await isRunning(id, w.def.manifest.web))) await compose(id, ["down"], downMS);
      l.webPort = p.webPort;
    }
    Object.assign(l, { gen: w.gen, role, hash: p.hash });
    saveApplied(id, l);
    l.running = role === "active" && (await isRunning(id, w.def.manifest.web));
    l.checkedAt = 0;
    end(id, l, key);
  } catch (e) {
    end(id, l, key, e);
  }
}

// the copy taken down and its files gone; data/ kept unless keepData is false
async function teardown(id: string, keepData: boolean) {
  const l = local(id);
  const key = `remove/${keepData}`;
  if (l.error && l.errorFor === key && now() - l.errorAt < retryMS) return;
  begin(id, l, "remove");
  try {
    if (existsSync(composeFile(id)))
      await compose(id, ["down", "--remove-orphans", ...(keepData ? [] : ["--volumes"])], downMS);
    await unpublish(id, l);
    if (keepData) {
      for (const f of ["compose.yml", ".env", ".phos.json", "src", "cache"])
        rmSync(join(dirOf(id), f), { recursive: true, force: true });
    } else rmSync(dirOf(id), { recursive: true, force: true });
    Object.assign(l, { gen: 0, role: "none", hash: "", webPort: 0, published: 0, running: false, healthy: undefined });
    end(id, l, key);
  } catch (e) {
    end(id, l, key, e);
  }
}

// --- the loop ----------------------------------------------------------------------

// a copy here with something to take down
const hasCopy = (id: string, l: Local) => l.gen > 0 || l.published > 0 || existsSync(composeFile(id));

async function settle(id: string) {
  const w = wantOf(id);
  const role = roleOf(w);
  const l = local(id);
  if (!w || role === "none") {
    if (hasCopy(id, l)) await teardown(id, w ? true : keepDataOf(id));
    else if (!w && !keepDataOf(id) && existsSync(dirOf(id))) rmSync(dirOf(id), { recursive: true, force: true });
    return;
  }
  const d = await docker();
  if (d.state !== "present") {
    if (d.state === "installable" && !d.installing) void installDocker(dockerLog()).catch(() => {});
    l.error = `waiting for docker: ${d.error ?? d.state}`;
    return;
  }
  let p: Plan;
  try {
    p = await plan(w, role);
  } catch (e) {
    if (l.error !== errText(e)) markHot();
    l.error = errText(e);
    return;
  }
  if (l.gen !== w.gen || l.role !== role || l.hash !== p.hash) {
    const key = `${w.gen}/${role}/${p.hash}`;
    if (l.error && l.errorFor === key && now() - l.errorAt < retryMS) return;
    const op: Op = !l.gen ? "install" : l.role === "standby" && role === "active" ? "promote" : "update";
    if (l.gen !== w.gen || l.role !== role) l.held = false;
    await apply(id, w, role, p, op);
    return;
  }
  if (l.error && !l.errorFor) l.error = "";
  if (role !== "active" || now() - l.checkedAt < checkMS) return;
  l.checkedAt = now();
  const was = [l.running, l.healthy];
  l.running = await isRunning(id, w.def.manifest.web);
  // down on its own: brought back, unless failover holds it down
  if (!l.running && !l.held && now() - l.upAt > retryMS) {
    l.upAt = now();
    try {
      await compose(id, ["up", "-d"], upMS);
      l.running = await isRunning(id, w.def.manifest.web);
    } catch (e) {
      l.error = errText(e);
    }
  }
  l.healthy = l.running ? await healthOf(id, w, l) : false;
  if (was[0] !== l.running || was[1] !== l.healthy) markHot();
}

// every id with a want, a copy here or a job to show
function every(): string[] {
  const out = new Set([...ids(), ...locals.keys()]);
  try {
    for (const n of readdirSync(root())) if (idRe.test(n) && existsSync(appliedFile(n))) out.add(n);
  } catch {}
  return [...out].sort();
}

// Docker asked of this host: installed once per ask
let askedAt = 0;
function dockerAsked() {
  const at = obj(store.read(dockerRel(SelfHost)))?.at;
  if (typeof at !== "number" || at === askedAt) return;
  askedAt = at;
  const d = dockerInfo();
  if (d.state === "present" || d.installing) return;
  void installDocker(dockerLog())
    .catch(() => {})
    .finally(() => store.remove(dockerRel(SelfHost)));
}

const busy = new Map<string, Promise<void>>();

// one round: every stack's settle started unless one is under way; resolves once
// those started are done
export function tick(): Promise<void> {
  if (!SelfHost) return Promise.resolve();
  // docker looked at again once a minute, for this host's info
  void docker();
  dockerAsked();
  return Promise.all(
    every().map((id) => {
      let p = busy.get(id);
      if (!p) {
        p = settle(id)
          .catch((e) => logf("%s: %s", id, errText(e)))
          .finally(() => busy.delete(id));
        busy.set(id, p);
      }
      return p;
    }),
  ).then(() => {});
}

// HostInfo.stacks: this host's copy of each stack it has a part in
export function statuses(): Record<string, StackStatus> {
  const out: Record<string, StackStatus> = {};
  for (const [id, l] of locals) {
    const role = roleOf(wantOf(id));
    const shown = l.job && (!l.job.done || now() - l.job.at < jobShownMS);
    if (role === "none" && !shown && !l.gen && !l.error) continue;
    const s: StackStatus = { role, gen: l.gen, running: l.running };
    if (l.healthy !== undefined) s.healthy = l.healthy;
    if (l.error) s.error = l.error;
    if (shown && l.job) {
      s.job = { op: l.job.op, log: tailOf(logFile(id), logTail), done: l.job.done };
      if (l.job.ok !== undefined) s.job.ok = l.job.ok;
    }
    out[id] = s;
  }
  return out;
}

// --- failover's seam --------------------------------------------------------------

export const runtime: Runtime = {
  dataDir: (id) => join(dirOf(id), "data"),
  async up(id) {
    const l = local(id);
    if (!existsSync(composeFile(id))) throw new Error(`no copy of ${id} here`);
    l.held = false;
    l.upAt = now();
    await compose(id, ["up", "-d", "--remove-orphans"], upMS);
    const w = wantOf(id);
    if (w?.def.manifest.web && l.webPort) await publish(id, l, l.webPort);
    l.running = await isRunning(id, w?.def.manifest.web);
    markHot();
  },
  async down(id) {
    const l = local(id);
    l.held = true;
    if (existsSync(composeFile(id))) await compose(id, ["stop"], downMS);
    await unpublish(id, l);
    l.running = false;
    markHot();
  },
  running: (id) => isRunning(id),
  async hook(id, phase) {
    const w = wantOf(id);
    if (!w) throw new Error(`no stack called ${id}`);
    for (const h of w.def.manifest.backup?.[phase] ?? []) await compose(id, ["exec", "-T", h.service, ...h.run], upMS);
  },
};

// the follow loop: every few seconds and on any change to etc/stacks
let ticker: ReturnType<typeof setInterval> | undefined;
export function Start(s: Partial<typeof seams>, tickMS = 3000) {
  Object.assign(seams, s);
  seams.kick = () => void tick();
  store.watch((rel) => {
    if (rel.startsWith("etc/stacks/")) void tick();
  });
  if (ticker) clearInterval(ticker);
  ticker = setInterval(() => void tick(), tickMS);
  void detect().then(() => tick());
}

// for tests: what this host remembers forgotten
export function reset() {
  locals.clear();
  askedAt = 0;
  if (ticker) clearInterval(ticker);
  ticker = undefined;
}
