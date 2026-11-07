// phosphorus daemon, the app's one admin step on macOS and safe to rerun: the user
// agent gone, its home moved to root's, the release and setup, the daemon up

import {
  chmodSync,
  cpSync,
  existsSync,
  lchownSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { at, envPath, errText, fail, home, isMac, keysMissing, quiet, readTrim, say, settings } from "../base.ts";
import { label, ownerFile } from "../darwin.ts";
import type { Flags } from "../index.ts";
import { install } from "../install.ts";
import { absTo, rebuild } from "../native.ts";
import { os } from "../os.ts";

export type Step =
  | { do: "bootout"; target: string }
  | { do: "remove"; path: string }
  | { do: "move"; from: string; to: string }
  | { do: "merge"; from: string; to: string }
  | { do: "aside"; from: string; to: string };

// a home already in use: keys or an install there
const holds = (h: string) => existsSync(join(h, ".env")) || existsSync(join(h, ".phosphorus-installed"));

const empty = (d: string) => {
  try {
    return readdirSync(d).length === 0;
  } catch {
    return false;
  }
};

// migrationPlan what moves for uid's account: its agent gone, its home moved in
// (or merged into a bare one), never over a home in use, which keeps the old one aside
export function migrationPlan(uid: number, userHome: string, to: string, now = Date.now()): Step[] {
  const steps: Step[] = [];
  const agent = join(userHome, "Library", "LaunchAgents", label + ".plist");
  if (existsSync(agent)) steps.push({ do: "bootout", target: `gui/${uid}/${label}` }, { do: "remove", path: agent });
  const from = join(userHome, "Library", "Phosphorus");
  if (!existsSync(from) || normalize(from) === normalize(to)) return steps;
  if (!existsSync(to) || empty(to)) steps.push({ do: "move", from, to });
  else if (!holds(to)) steps.push({ do: "merge", from, to });
  else steps.push({ do: "aside", from, to: `${from}.old-${new Date(now).toISOString().slice(0, 10)}-${now % 100000}` });
  return steps;
}

// move a dir by rename, by copy across volumes
function move(from: string, to: string) {
  try {
    renameSync(from, to);
    return;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
  }
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  rmSync(from, { recursive: true, force: true });
}

// applyStep one step; bootout through launchctl, injectable for tests
export async function applyStep(s: Step, launchctl = (...a: string[]) => quiet("launchctl", ...a)) {
  switch (s.do) {
    case "bootout":
      await launchctl("bootout", s.target);
      return;
    case "remove":
      rmSync(s.path, { force: true });
      return;
    case "move":
      mkdirSync(dirname(s.to), { recursive: true });
      if (existsSync(s.to)) rmdirSync(s.to);
      move(s.from, s.to);
      return;
    case "merge": {
      // what the bare home lacks moved in, nothing overwritten, the rest kept aside
      for (const n of readdirSync(s.from)) if (!existsSync(join(s.to, n))) move(join(s.from, n), join(s.to, n));
      if (empty(s.from)) rmdirSync(s.from);
      else move(s.from, `${s.from}.old-${Date.now()}`);
      return;
    }
    case "aside":
      move(s.from, s.to);
      return;
  }
}

export const stepText = (s: Step) =>
  s.do === "bootout"
    ? `stopping the user agent ${s.target}`
    : s.do === "remove"
      ? `removing ${s.path}`
      : s.do === "aside"
        ? `keeping ${s.from} aside as ${s.to}, ${home} already in use`
        : `${s.do === "move" ? "moving" : "merging"} ${s.from} into ${s.to}`;

// ownHome root's, as Linux's: no login able to swap the binary or native.env
// under the daemon; shares left their users', symlinks not followed
export function ownHome(dir: string, keep: string[], chown = lchownSync) {
  const skip = new Set(keep.map((k) => normalize(k)));
  const visit = (p: string) => {
    if (skip.has(normalize(p))) return;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.uid !== 0 || st.gid !== 0) chown(p, 0, 0);
    if (st.isSymbolicLink()) return;
    if (st.mode & 0o022) chmodSync(p, st.mode & 0o7755);
    if (st.isDirectory()) for (const n of readdirSync(p)) visit(join(p, n));
  };
  visit(dir);
}

// flag value of --name in rest
const flag = (rest: string[], name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? (rest[i + 1] ?? "") : "";
};

// daemonSetup phosphorus daemon --uid N --user-home DIR [--payload RELEASE], as root
export async function daemonSetup(f: Flags) {
  if (!isMac) throw fail("daemon is macOS's: the root daemon and its tray");
  if (process.geteuid?.() !== 0) throw fail("daemon needs root: the Phosphorus app asks for it");
  const uid = Number(flag(f.rest, "--uid"));
  const userHome = flag(f.rest, "--user-home");
  if (!Number.isInteger(uid) || uid <= 0) throw fail("daemon needs --uid, the console user's");
  if (!isAbsolute(userHome)) throw fail("daemon needs --user-home, the console user's home");
  // the account's own home, never a path pointed elsewhere
  if (lstatSync(userHome).uid !== uid) throw fail(`${userHome} isn't uid ${uid}'s`);

  for (const s of migrationPlan(uid, userHome, home)) {
    say(stepText(s));
    try {
      await applyStep(s);
    } catch (e) {
      throw fail(`${stepText(s)}: ${errText(e)}`);
    }
  }
  mkdirSync(home, { recursive: true, mode: 0o755 });
  writeFileSync(ownerFile(), `${uid}\n`, { mode: 0o644 });
  let shares: string[] = [];
  try {
    shares = settings().shares.map((s) => absTo(home, s.dir));
  } catch {}
  ownHome(home, shares);
  envfile.ensure(envPath());

  // the admin setup (ssh, PATH) here, the prompt already given
  try {
    if (await os.needSetup()) await os.setupOS();
  } catch (e) {
    say(`setup: ${errText(e)}`);
  }
  const want = f.payload ? readTrim(join(f.payload, "VERSION")) : "";
  const have = readTrim(at(".phosphorus-installed"));
  if (f.payload && want !== have) await install(f.payload, !!have);
  // a moved home's env baked again for its new paths
  else if (!keysMissing()) await rebuild();
  // the socket up with no keys too: the tray sets them through it
  await os.svcInstall();
  if (!(await quiet("launchctl", "print", "system/" + label))) await os.svcStart();
  say("the daemon is up");
}
