// install the release into the home, per-host files kept, then the bring-up
// or, for an update, the rebuild; no keys yet: left for the key form
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { at, binPath, envPath, exe, fail, fileExists, home, isWindows, keysMissing, say, version } from "./base.ts";
import { rebuild } from "./native.ts";
import { start } from "./start.ts";

export async function install(payload: string, update: boolean) {
  // the package's bin/phosphorus, beside the release it came with
  if (!payload) payload = dirname(dirname(exe()));
  payload = resolve(payload);
  const h = resolve(home);
  if (fileExists(join(payload, ".git")))
    throw fail(`${payload} is a git clone, not a release: install from the latest release`);
  if (!fileExists(join(payload, "VERSION"))) throw fail(`${payload} holds no release`);
  if (payload.toLowerCase() === h.toLowerCase()) throw fail(`run the package's copy, not ${home}'s`);
  try {
    mkdirSync(home, { recursive: true });
  } catch {
    throw fail(`can't create ${home}`);
  }
  try {
    syncPayload(payload, home);
  } catch (e) {
    throw fail(`couldn't copy the release into ${home}: ${e instanceof Error ? e.message : e}`);
  }
  try {
    installSelf();
  } catch (e) {
    throw fail(`couldn't put phosphorus in ${at("bin")}: ${e instanceof Error ? e.message : e}`);
  }
  const v = version();
  say(`phosphorus ${v} in ${home}`);
  try {
    envfile.ensure(envPath());
  } catch (e) {
    throw fail(`can't lock ${envPath()}: ${e instanceof Error ? e.message : e}`);
  }
  if (keysMissing()) {
    say("no keys yet: run phosphorus (or open the Phosphorus app) to enter them");
    writeFileSync(at(".phosphorus-installed"), v + "\n", { mode: 0o644 });
    return;
  }
  if (update) {
    try {
      await rebuild();
    } catch (e) {
      throw fail(
        `rebuild failed, the service may still run the previous binary: ${e instanceof Error ? e.message : e}`,
      );
    }
  } else await start();
  writeFileSync(at(".phosphorus-installed"), v + "\n", { mode: 0o644 });
}

// per host, never overwritten once there
export const kept = (f: string) =>
  f === "config/services.export" || f === "config/phosphorus.ini" || f.startsWith("files/");

// every file under dir, slash-separated and relative, .phosphorus-* ones skipped
function walk(dir: string): string[] {
  const out: string[] = [];
  const visit = (p: string) => {
    for (const e of readdirSync(p, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(p, e.name);
      if (e.isDirectory()) visit(full);
      else if (!e.name.startsWith(".phosphorus-")) out.push(relative(dir, full).replaceAll("\\", "/"));
    }
  };
  visit(dir);
  return out;
}

// every release file into dst, what the last one shipped and this one doesn't
// removed, this host's config and share left alone
export function syncPayload(src: string, dst: string) {
  const next = walk(src);
  for (const f of next) {
    const to = join(dst, f);
    if (kept(f) && fileExists(to)) continue;
    copyFile(join(src, f), to);
  }
  // the binary, copied in by installSelf
  for (const n of binNames()) next.push("bin/" + basename(binPath(n)));
  next.sort();
  const manifest = join(dst, ".phosphorus-manifest");
  const want = new Set(next);
  let old = "";
  try {
    old = readFileSync(manifest, "utf8");
  } catch {}
  for (const f of old.replaceAll("\r\n", "\n").split("\n")) {
    if (!f || want.has(f) || f.startsWith("config/") || f.startsWith("files/")) continue;
    const p = join(dst, f);
    rmSync(p, { force: true });
    // its folders too, once nothing else is in them
    for (let d = dirname(p); d.length > dst.length; d = dirname(d)) {
      try {
        rmdirSync(d);
      } catch {
        break;
      }
    }
  }
  writeFileSync(manifest, next.join("\n") + "\n", { mode: 0o644 });
}

export function copyFile(from: string, to: string) {
  const st = statSync(from);
  mkdirSync(dirname(to), { recursive: true });
  const tmp = to + ".phosphorus-tmp";
  try {
    copyFileSync(from, tmp);
    if (!isWindows) chmodSync(tmp, (st.mode & 0o777) | 0o644);
    utimesSync(tmp, st.mtime, st.mtime);
    replace(tmp, to);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// replace to with tmp, a running Windows exe moved aside first
export function replace(tmp: string, to: string) {
  try {
    renameSync(tmp, to);
    return;
  } catch (e) {
    if (!isWindows) throw e;
  }
  const old = to + ".old";
  rmSync(old, { force: true });
  renameSync(to, old);
  renameSync(tmp, to);
}

// phos beside it on Windows, a second link elsewhere
export const binNames = () => (isWindows ? ["phosphorus", "phos"] : ["phosphorus"]);

// installSelf this binary into the home's bin/
function installSelf() {
  const self = exe();
  for (const n of binNames()) {
    const to = binPath(n);
    try {
      if (realpathSync(to) === self) continue;
    } catch {}
    copyFile(self, to);
    try {
      chmodSync(to, 0o755);
    } catch {}
  }
}
