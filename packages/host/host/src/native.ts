// the service on this host: the env baked for run, the rebuild that
// (re)starts it, stop and restart
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import * as envfile from "@phosphorus/envfile";
import {
  at,
  binPath,
  envPath,
  eprint,
  fail,
  fileExists,
  home,
  inDpkg,
  iniFile,
  iniGet,
  isLinux,
  isModelHost,
  isWindows,
  lockEnv,
  println,
  readTrim,
  say,
  setTag,
  sleep,
  statOf,
  version,
} from "./base.ts";
import { copyFile, replace } from "./install.ts";
import { os } from "./os.ts";

export const frontendUp = "http://127.0.0.1:8090/";

export const nativeEnvFile = () => at("state", "native.env");

// tool a bundled binary: tailscale, cloudflared
export const tool = (name: string) => join(os.libexec(), isWindows ? name + ".exe" : name);

// --- the baked env ------------------------------------------------------------

// bakeEnv every path the roles read, rewritten by every rebuild and read by run
export function bakeEnv(): Record<string, string> {
  const m: Record<string, string> = {
    PHOSPHORUS_HOME: home,
    PHOSPHORUS_REPO_DIR: home,
    STATE_DIR: at("state"),
    PHOSPHORUS_INI_FILE: iniFile(),
    PHOSPHORUS_CONFIG_DIR: at("config"),
    PHOSPHORUS_ENV_FILE: envPath(),
    VERSION_FILE: at("VERSION"),
    REBUILD_CMD: binPath("phosphorus"),
    MODEL_DIR: at("state", "models"),
    HOST_SSH_HOST: "127.0.0.1",
  };
  if (process.env.TS_HOSTNAME) m.TS_HOSTNAME = process.env.TS_HOSTNAME;
  const dirs: string[] = [],
    perms: string[] = [];
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
  h.update(`${version()} ${isModelHost()}\n`);
  const st = statOf(binPath("phosphorus"));
  if (st) h.update(`${st.size} ${st.mtimeNs}\n`);
  h.update(
    JSON.stringify(
      Object.fromEntries(
        Object.keys(env)
          .sort()
          .map((k) => [k, env[k]]),
      ),
    ),
  );
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
    await fetch("http://127.0.0.1:8090/internal/status/updating", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
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
    const missing = await os.missingDeps();
    if (missing.length) {
      if (inDpkg()) return os.deferRebuild();
      await os.aptInstall(missing);
    }
    mkdirSync(at("state"), { recursive: true });
    const old = oldHomes();
    const env = bakeEnv();
    const sig = signature(env);
    await os.svcInstall();
    let up = await os.svcActive();
    if (up && !old.length && readTrim(at("state", "native-sig")) === sig) {
      say("already up to date, nothing to restart");
      return;
    }
    await os.tailscaleReady();

    if (up && old.length) {
      await notifyUpdating();
      await os.svcStop();
      up = false;
    }
    if (old.length) migrateHome(old);
    writeEnvFile(nativeEnvFile(), env);
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

// --- the home's one move ---------------------------------------------------------------

// oldHomes where earlier releases kept home/: files/home, or under an old [home] dir
export function oldHomes(): string[] {
  const dirs = [readTrim(at("state", "native-home")), iniGet("home", "dir"), at("files")];
  const out: string[] = [];
  for (const d of dirs) {
    if (!d) continue;
    const src = join(normalize(absTo(home, d)), "home");
    if (src !== at("home") && fileExists(src) && !out.includes(src)) out.push(src);
  }
  return out;
}

// migrateHome every old home/ moved into <phosphorus>/home, what's there already kept,
// a clash left where it was; files/ and the old [home] dir's record gone after
export function migrateHome(srcs: string[]) {
  const to = at("home");
  for (const src of srcs) {
    say(`moving home/ from ${src} to ${to}`);
    try {
      mergeMove(src, to);
    } catch (e) {
      say(`couldn't move all of ${src} (${e instanceof Error ? e.message : e}), what's left stays there`);
    }
  }
  rmSync(at("state", "native-home"), { force: true });
  try {
    rmdirSync(at("files"));
  } catch {}
}

// mergeMove src's entries into dst one by one, renamed or else copied, folders merged
function mergeMove(src: string, dst: string) {
  if (!fileExists(dst)) {
    try {
      renameSync(src, dst);
      return;
    } catch {}
  }
  mkdirSync(dst, { recursive: true });
  for (const n of readdirSync(src)) {
    const from = join(src, n),
      to = join(dst, n);
    if (!fileExists(to)) {
      try {
        renameSync(from, to);
      } catch {
        copyTree(from, to);
        rmSync(from, { recursive: true, force: true });
      }
    } else if (lstatSync(from).isDirectory() && lstatSync(to).isDirectory()) mergeMove(from, to);
    else say(`kept ${to}, ${from} left where it was`);
  }
  try {
    rmdirSync(src);
  } catch {}
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

// --- start, stop ------------------------------------------------------------------

export async function nativeStop() {
  if (!(await os.svcActive())) {
    println("phosphorus isn't running");
    return;
  }
  println("stopping phosphorus (its services hand off first)...");
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
