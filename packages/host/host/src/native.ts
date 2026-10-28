// the service on this host: the env baked for run, the rebuild that
// (re)starts it, stop and restart, the cli attached, phos ps
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { ours, type P } from "@phosphorus/procs";
import { at, binPath, envPath, eprint, ExitCode, fail, fileExists, home, iniFile, iniGet, inDpkg, isGitHost, isLinux, isModelHost, isWindows, lockEnv, print, println, readTrim, say, setTag, sleep, spawnIO, statOf, version } from "./base.ts";
import { refreshGameKey } from "./game.ts";
import { copyFile, replace } from "./install.ts";
import { os } from "./os.ts";

export const frontendUp = "http://127.0.0.1:8090/";

export const nativeEnvFile = () => at("state", "native.env");

// tool a bundled binary: tailscale, cloudflared, forgejo
export const tool = (name: string) => join(os.libexec(), isWindows ? name + ".exe" : name);

// --- the baked env ------------------------------------------------------------

// bakeEnv every path the roles read, rewritten by every rebuild and read by run
export function bakeEnv(homeDir: string): Record<string, string> {
  const files = at("files");
  const m: Record<string, string> = {
    PHOSPHORUS_HOME: home, PHOSPHORUS_REPO_DIR: home,
    STATE_DIR: at("state"), SERVICES_FILE: at("config", "services.export"),
    PHOSPHORUS_INI_FILE: iniFile(), PHOSPHORUS_CONFIG_DIR: at("config"), PHOSPHORUS_ENV_FILE: envPath(),
    VERSION_FILE: at("VERSION"), REBUILD_CMD: binPath("phosphorus"),
    FILES_ROOT: files, PHOSPHORUS_FILES_DIR: files,
    HOME_FS: homeDir, PHOSPHORUS_HOME_DIR: homeDir,
    MODEL_DIR: at("state", "models"), HOST_SSH_HOST: "127.0.0.1",
  };
  if (isLinux) Object.assign(m, os.gitEnv());
  if (process.env.TS_HOSTNAME) m.TS_HOSTNAME = process.env.TS_HOSTNAME;
  const dirs: string[] = [], perms: string[] = [];
  const ps = splitComma(iniGet("files", "priv"));
  splitComma(iniGet("files", "dir")).forEach((d, i) => {
    d = d.replace(/[/\\]+$/, "");
    if (!d) return;
    const abs = normalize(absTo(home, d));
    if (!fileExists(abs)) {
      eprint(`[files] skipping '${d}'; no such directory on this host\n`);
      return;
    }
    dirs.push(abs);
    perms.push(ps[i] || "rwd");
  });
  if (dirs.length) {
    m.PHOSPHORUS_FILES_DIRS = dirs.join(",");
    m.PHOSPHORUS_FILES_PERMS = perms.join(",");
  }
  return m;
}

export const splitComma = (v: string) => v.split(",").map((x) => x.trim());

export function absTo(base: string, p: string): string {
  p = p.trim().replace(/[/\\]+$/, "");
  return isAbsolute(p) ? p : join(base, p);
}

export function envFileText(m: Record<string, string>): string {
  let b = "# baked by phosphorus rebuild, read by phosphorus run\n";
  for (const k of Object.keys(m).sort()) b += k + "=" + m[k] + "\n";
  return b;
}

function writeEnvFile(file: string, m: Record<string, string>) {
  writeFileSync(file + ".tmp", envFileText(m), { mode: 0o644 });
  replace(file + ".tmp", file);
}

export function readEnvFile(file: string): Record<string, string> {
  const m: Record<string, string> = {};
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  for (let l of text.replaceAll("\r\n", "\n").split("\n")) {
    l = l.trim();
    if (!l || l.startsWith("#")) continue;
    const i = l.indexOf("=");
    if (i >= 0) m[l.slice(0, i)] = l.slice(i + 1);
  }
  return m;
}

// runEnv the baked env and .env over this process's, PATH with the tools
export function runEnv(): Record<string, string> {
  const m = readEnvFile(nativeEnvFile());
  for (const [k, v] of Object.entries(envfile.read(envPath()))) if (v) m[k] = v;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!(k in m) && v !== undefined) out[k] = v;
  Object.assign(out, m);
  return withPath(out);
}

const pathSep = isWindows ? ";" : ":";

export function withPath(env: Record<string, string>): Record<string, string> {
  const extra = [os.libexec(), ...os.tailscaleDirs()].join(pathSep);
  for (const k of Object.keys(env)) {
    if (k.toLowerCase() === "path") {
      env[k] = extra + pathSep + env[k];
      return env;
    }
  }
  env.PATH = extra + pathSep + "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  return env;
}

// --- rebuild --------------------------------------------------------------------------

// signature what the running service was started on, an unchanged one no restart
export function signature(env: Record<string, string>): string {
  const h = createHash("sha256");
  h.update(`${version()} ${isGitHost()} ${isModelHost()}\n`);
  const st = statOf(binPath("phosphorus"));
  if (st) h.update(`${st.size} ${st.mtimeNs}\n`);
  h.update(JSON.stringify(Object.fromEntries(Object.keys(env).sort().map((k) => [k, env[k]]))));
  return h.digest("hex");
}

export async function waitFrontend(ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) {
    try {
      await fetch(frontendUp, { signal: AbortSignal.timeout(2000) });
      return true;
    } catch {}
  }
  return false;
}

// notifyUpdating the elector told before the frontend goes, best effort
async function notifyUpdating() {
  try {
    await fetch("http://127.0.0.1:8090/internal/status/updating", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000) });
  } catch {}
}

// inService a child of the running service, whose restart would kill it first
const inService = () => !!process.env.PHOSPHORUS_ROLE;

// rebuild the release's config baked and the service (re)started on it
export async function rebuild() {
  setTag("rebuild");
  process.chdir(home);
  mkdirSync(at("state"), { recursive: true });
  // one rebuild at a time: the update's deferred one and a phos start never interleave
  const unlock = await os.lockRebuild();
  try {
    lockEnv();
    if (!isLinux && iniGet("git", "host") === "true") say("[git] host = true ignored: git hosts run on Linux alone");
    const missing = await os.missingDeps();
    if (missing.length) {
      if (inDpkg()) return os.deferRebuild();
      await os.aptInstall(missing);
    }
    if (isGitHost()) await os.ensureGitUser();
    else {
      removeOne(at("git", "data"));
      removeOne(at("git"));
    }
    mkdirSync(at("files"), { recursive: true });
    mkdirSync(at("state"), { recursive: true });

    let homeTo = at("files");
    const d = iniGet("home", "dir");
    if (d) {
      homeTo = normalize(absTo(home, d));
      mkdirSync(homeTo, { recursive: true });
    }
    let homeFrom = readTrim(at("state", "native-home"));
    if (homeFrom === homeTo) homeFrom = "";
    if (homeFrom && (homeTo + sep).startsWith(join(homeFrom, "home") + sep)) throw fail("[home] dir can't be inside the folders it moves");
    await refreshGameKey();
    let env = bakeEnv(homeTo);
    let sig = signature(env);
    await os.svcInstall();
    let up = await os.svcActive();
    if (up && !homeFrom && readTrim(at("state", "native-sig")) === sig) {
      say("already up to date, nothing to restart");
      return;
    }
    await os.tailscaleReady();

    if (up && homeFrom) {
      await notifyUpdating();
      await os.svcStop();
      up = false;
    }
    if (homeFrom) {
      say(`moving home/ from ${homeFrom} to ${homeTo}`);
      try {
        moveHome(homeFrom, homeTo);
      } catch (e) {
        say(`couldn't move the homes (${e instanceof Error ? e.message : e}), keeping them in ${homeFrom}`);
        homeTo = homeFrom;
        env = bakeEnv(homeTo);
        sig = signature(env);
      }
    }
    writeEnvFile(nativeEnvFile(), env);
    writeFileSync(at("state", "native-home"), homeTo + "\n", { mode: 0o644 });
    await os.tailscaleStart();
    if (up && inService()) {
      await notifyUpdating();
      writeFileSync(at("state", "native-sig"), sig + "\n", { mode: 0o644 });
      say("restarting phosphorus");
      return os.svcRestart(true);
    }
    if (up) {
      await notifyUpdating();
      say("restarting phosphorus");
      try {
        await os.svcRestart(false);
      } catch (e) {
        throw fail(`couldn't restart phosphorus: ${e instanceof Error ? e.message : e}`);
      }
    } else {
      say("starting phosphorus");
      try {
        await os.svcStart();
      } catch (e) {
        throw fail(`couldn't start phosphorus: ${e instanceof Error ? e.message : e}`);
      }
    }
    if (!(await waitFrontend(3 * 60_000))) throw fail(`the frontend never came up, see ${os.logHint()}`);
    writeFileSync(at("state", "native-sig"), sig + "\n", { mode: 0o644 });
  } finally {
    unlock();
  }
}

// removeOne a file, link or empty folder, as os.Remove did; anything else left
function removeOne(p: string) {
  try {
    rmdirSync(p);
  } catch {
    try {
      rmSync(p);
    } catch {}
  }
}

// moveHome home/ copied whole, only then the old one deleted
function moveHome(from: string, to: string) {
  const src = join(from, "home");
  if (!fileExists(src)) return;
  copyTree(src, join(to, "home"));
  rmSync(src, { recursive: true, force: true });
}

export function copyTree(src: string, dst: string) {
  const walk = (p: string) => {
    const to = join(dst, relative(src, p));
    const st = lstatSync(p);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      for (const n of readdirSync(p)) walk(join(p, n));
    } else if (st.isSymbolicLink()) symlinkSync(readlinkSync(p), to);
    else copyFile(p, to);
  };
  walk(src);
}

// --- start, stop, the cli ------------------------------------------------------------

export async function nativeStop() {
  if (!(await os.svcActive())) {
    println("phosphorus isn't running");
    return;
  }
  println("stopping phosphorus (git hands off first)...");
  try {
    await os.svcStop();
  } catch (e) {
    throw fail(`couldn't stop phosphorus: ${e instanceof Error ? e.message : e}`);
  }
  println("phosphorus stopped, phos start to resume");
}

export async function nativeRestart() {
  println("restarting phosphorus...");
  try {
    await os.svcRestart(false);
  } catch (e) {
    throw fail(`couldn't restart phosphorus: ${e instanceof Error ? e.message : e}`);
  }
  println("phosphorus restarted");
}

// attach the cli on the running service's env, reattached across a restart
export async function attach(args: string[]) {
  for (;;) {
    const before = await os.svcSince();
    if (!(await os.svcActive())) throw fail("phosphorus isn't running, run: phos start");
    const code = await spawnIO([binPath("phosphorus"), "cli", ...args], { env: runEnv(), stdin: "inherit" });
    if ((await os.svcSince()) === before) {
      if (code < 0) throw fail(`couldn't run ${binPath("phosphorus")}`);
      if (code !== 0) throw new ExitCode(code);
      return;
    }
    println("phosphorus is restarting, reattaching (ctrl-c to quit)...");
    while (!(await os.svcActive())) await sleep(1000);
    if (args[0] === "update-all") args = ["--tab", "update"];
  }
}

// --- phos ps ------------------------------------------------------------------------

// psText phosphorus's own processes as a tree, by role
export function psText(ps: P[]): string {
  if (ps.length === 0) return "no phosphorus processes running\n";
  const by = new Map<number, P>(ps.map((p) => [p.pid, p]));
  const kids = new Map<number, number[]>();
  const roots: number[] = [];
  for (const p of ps) {
    if (by.has(p.ppid)) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
    else roots.push(p.pid);
  }
  const asc = (a: number[]) => a.sort((x, y) => x - y);
  let w = `${"ROLE".padEnd(16)} ${"PID".padStart(7)} ${"RSS".padStart(8)}  COMMAND\n`;
  const walk = (pid: number, depth: number) => {
    const p = by.get(pid)!;
    let cmd = p.cmd || p.name;
    if (cmd.length > 90) cmd = cmd.slice(0, 90) + "…";
    w += `${p.role.padEnd(16)} ${String(p.pid).padStart(7)} ${String(Math.floor(p.rss / (1 << 20))).padStart(7)}M  ${"  ".repeat(depth)}${cmd}\n`;
    for (const k of asc(kids.get(pid) ?? [])) walk(k, depth + 1);
  };
  for (const r of asc(roots)) walk(r, 0);
  // totals, the model's own runtimes apart: their weights and caches dwarf the rest
  let all = 0, model = 0;
  for (const p of ps) {
    all += p.rss;
    if (p.role === "llama-server") model += p.rss;
  }
  const mb = (n: number) => String(Math.floor(n / (1 << 20))).padStart(7) + "M";
  w += `\n${"phosphorus".padEnd(16)} ${"".padStart(7)} ${mb(all - model)}\n`;
  if (model > 0) {
    w += `${"llama-server".padEnd(16)} ${"".padStart(7)} ${mb(model)}\n`;
    w += `${"total".padEnd(16)} ${"".padStart(7)} ${mb(all)}\n`;
  }
  return w;
}

export const psHost = () => print(psText(ours()));
