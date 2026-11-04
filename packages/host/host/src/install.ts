// install the release into the home, per-host files kept, then the bring-up
// or, for an update, the rebuild; no keys yet: left for phos or the app
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as envfile from "@phosphorus/envfile";
import {
  at,
  binPath,
  envPath,
  exe,
  fail,
  fileExists,
  home,
  isLinux,
  isWindows,
  keysMissing,
  say,
  version,
} from "./base.ts";
import { desktopLinks } from "./front.ts";
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
    say("no keys yet: run phos (or open the Phosphorus app) to enter them, then it links to the desktop");
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
  } else {
    await start();
    say(`open the desktop for every app: ${(await desktopLinks()).join("  ")}`);
  }
  writeFileSync(at(".phosphorus-installed"), v + "\n", { mode: 0o644 });
}

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

// every release file into dst, what the last one shipped and this one doesn't removed
export function syncPayload(src: string, dst: string) {
  const next = walk(src);
  for (const f of next) {
    const to = join(dst, f);
    if (same(join(src, f), to)) continue;
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
    if (!f || want.has(f)) continue;
    const p = join(dst, f);
    // a running Windows exe kept listed, tried again next time
    try {
      rmSync(p, { force: true });
    } catch {
      want.add(f);
      continue;
    }
    // its folders too, once nothing else is in them
    for (let d = dirname(p); d.length > dst.length; d = dirname(d)) {
      try {
        rmdirSync(d);
      } catch {
        break;
      }
    }
  }
  writeFileSync(manifest, [...want].sort().join("\n") + "\n", { mode: 0o644 });
}

// same bytes already at to: size and mtime alike (copyFile keeps it), else compared
export function same(from: string, to: string): boolean {
  let a: ReturnType<typeof statSync>, b: ReturnType<typeof statSync>;
  try {
    a = statSync(from);
    b = statSync(to);
  } catch {
    return false;
  }
  if (!b.isFile() || a.size !== b.size) return false;
  if (a.mtimeMs === b.mtimeMs) return true;
  const fa = openSync(from, "r"),
    fb = openSync(to, "r");
  try {
    const x = Buffer.alloc(1 << 20),
      y = Buffer.alloc(1 << 20);
    for (;;) {
      const n = readSync(fa, x, 0, x.length, null);
      if (n === 0) return true;
      if (readSync(fb, y, 0, n, null) !== n || !x.subarray(0, n).equals(y.subarray(0, n))) return false;
    }
  } finally {
    closeSync(fa);
    closeSync(fb);
  }
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
  // last update's .old swept, one still running (tray, unrestarted service) a fresh name
  const dir = dirname(to),
    stem = basename(to) + ".old";
  for (const n of readdirSync(dir))
    if (n.startsWith(stem))
      try {
        rmSync(join(dir, n), { force: true });
      } catch {}
  let old = to + ".old";
  for (let i = 1; fileExists(old); i++) old = `${to}.old${i}`;
  renameSync(to, old);
  renameSync(tmp, to);
}

// phos beside it on Windows, a second link elsewhere
export const binNames = () => (isWindows ? ["phosphorus", "phos"] : ["phosphorus"]);

// the .deb's binary, dpkg's to replace: the home links it instead of a second copy
export const packaged = (self: string) => isLinux && self.startsWith("/usr/lib/phosphorus/");

// installSelf this binary into the home's bin/
function installSelf() {
  const self = exe();
  for (const n of binNames()) {
    const to = binPath(n);
    try {
      if (realpathSync(to) === self) continue;
    } catch {}
    if (packaged(self)) {
      mkdirSync(dirname(to), { recursive: true });
      const tmp = to + ".phosphorus-tmp";
      rmSync(tmp, { force: true });
      symlinkSync(self, tmp);
      renameSync(tmp, to);
      continue;
    }
    copyFile(self, to);
    try {
      chmodSync(to, 0o755);
    } catch {}
  }
}
