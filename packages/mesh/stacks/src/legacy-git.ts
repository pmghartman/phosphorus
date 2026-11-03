// the move off the git service phosphorus used to run itself: the old master's
// Forgejo data (<phosphorus>/git: db, obj, conf, custom) copied into the Forgejo
// stack's data folder and installed there, the old servants its standbys; the old
// copies deleted only once an admin says the stack serves. Gone once every mesh
// has moved.
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as store from "@phosphorus/store";
import { env, errText, markHot, now, obj, RepoDir, run, StateDir } from "@phosphorus/util";
import type { LegacyGit } from "@phosphorus/wire";
import { logf } from "./docker.ts";
import { dirOf } from "./reconcile.ts";
import { seams } from "./seams.ts";
import { Install, wantOf } from "./want.ts";

export const legacyRel = "etc/stacks/legacy/git.json";
// the stack it becomes: the featured Forgejo, route git
const id = "git";
const app = { source: "phosphorus", ref: "forgejo" };

export const legacyDir = () => env("LEGACY_GIT_DIR", join(RepoDir, "git"));

// the copy's db: the master's live one, else a servant's last snapshot
function dbOf(root: string): string {
  for (const p of [join(root, "db", "forgejo.db"), join(root, "snap", "forgejo.db")])
    if (existsSync(p) && statSync(p).size > 0) return p;
  return "";
}

// this host's old copy and its version ("<gen> <stamp>" in GIT_VERSION), for its info
export function legacyInfo(root = legacyDir()): { gen: number; stamp: number } | undefined {
  if (!dbOf(root)) return;
  let f: string[] = [];
  try {
    f = readFileSync(join(root, "GIT_VERSION"), "utf8").trim().split(/\s+/);
  } catch {}
  const num = (s: string | undefined) => (Number.isFinite(Number(s)) ? Math.trunc(Number(s)) : 0);
  return { gen: num(f[0]), stamp: num(f[1]) };
}

export function legacyOf(): LegacyGit | undefined {
  const o = obj(store.read(legacyRel));
  if (!o || typeof o.from !== "string") return;
  return o as LegacyGit;
}

function write(l: LegacyGit) {
  store.write(legacyRel, l);
  markHot();
}

// --- the copy --------------------------------------------------------------------

// the old app.ini for the image's layout: the old root's paths (the db's folder's
// parent) as the container's, forgejo's own account and work path; what the compose
// sets is set again on every start
export function rewriteIni(text: string): string {
  const r = iniValue(text, "database", "PATH").replace(/\/db\/forgejo\.db$/, "") || "/var/lib/phosphorus/git";
  const paths: [string, string][] = [
    [`${r}/db/forgejo.db`, "/data/gitea/forgejo.db"],
    [`${r}/obj/forgejo-repositories`, "/data/git/repositories"],
    [`${r}/obj/lfs`, "/data/git/lfs"],
    [`${r}/obj`, "/data/gitea"],
    [`${r}/state`, "/data/gitea"],
    [`${r}/custom`, "/data/gitea"],
    [`${r}/conf`, "/data/gitea/conf"],
    [r, "/data/gitea"],
  ];
  let out = text;
  for (const [from, to] of paths) out = out.replaceAll(from, to);
  return out.replace(/^(\s*RUN_USER\s*=).*$/m, "$1 git").replace(/^\s*WORK_PATH\s*=.*\r?\n/m, "");
}

// a key of the old app.ini's [section]
export function iniValue(text: string, section: string, key: string): string {
  let at = "";
  for (const line of text.split(/\r?\n/)) {
    const s = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (s) {
      at = s[1]!.trim();
      continue;
    }
    const kv = /^\s*([^=;#\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line);
    if (kv && at === section && kv[1] === key) return kv[2]!.replace(/^(["'`])(.*)\1$/, "$2");
  }
  return "";
}

// a repo's server hooks call forgejo by the old binary and config: the image's now
const hookRe = /^("?)[^"\s]*\/(?:forgejo|gitea)\1 hook --config=(['"]?)[^'"\s]*\2/gm;
function fixHooks(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) fixHooks(p);
    else if (e.isFile()) {
      const t = readFileSync(p, "utf8");
      const n = t.replace(hookRe, `"/app/gitea/gitea" hook --config='/data/gitea/conf/app.ini'`);
      if (n !== t) writeFileSync(p, n);
    }
  }
}

function eachRepoHooks(repos: string, fn: (hooks: string) => void) {
  if (!existsSync(repos)) return;
  for (const owner of readdirSync(repos, { withFileTypes: true }))
    if (owner.isDirectory())
      for (const repo of readdirSync(join(repos, owner.name), { withFileTypes: true })) {
        const h = join(repos, owner.name, repo.name, "hooks");
        if (repo.isDirectory() && existsSync(h)) fn(h);
      }
}

const cp = (from: string, to: string) =>
  cpSync(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, force: true });

// the old root laid out as the stack's /data volume at dest (made whole, then
// renamed in); the old app.ini's secrets, for the stack's env
export function copyLegacy(root: string, dest: string): Record<string, string> {
  const db = dbOf(root);
  if (!db) throw new Error(`no forgejo.db under ${root}`);
  if (existsSync(dest)) throw new Error(`${dest} already holds data`);
  const part = `${dest}.part`;
  rmSync(part, { recursive: true, force: true });
  const gitea = join(part, "gitea");
  const git = join(part, "git");
  mkdirSync(join(gitea, "conf"), { recursive: true });
  mkdirSync(git, { recursive: true });
  for (const s of ["", "-journal", "-wal", "-shm"])
    if (existsSync(db + s)) copyFileSync(db + s, join(gitea, `forgejo.db${s}`));
  const objDir = join(root, "obj");
  if (existsSync(objDir))
    for (const e of readdirSync(objDir)) {
      const to =
        e === "forgejo-repositories" ? join(git, "repositories") : e === "lfs" ? join(git, "lfs") : join(gitea, e);
      cp(join(objDir, e), to);
    }
  const custom = join(root, "custom");
  if (existsSync(custom)) for (const e of readdirSync(custom)) cp(join(custom, e), join(gitea, e));
  const secrets: Record<string, string> = {};
  const conf = join(root, "conf");
  if (existsSync(conf))
    for (const e of readdirSync(conf)) {
      if (e !== "app.ini") {
        cp(join(conf, e), join(gitea, "conf", e));
        continue;
      }
      const ini = readFileSync(join(conf, e), "utf8");
      writeFileSync(join(gitea, "conf", e), rewriteIni(ini));
      for (const [k, name] of [
        ["SECRET_KEY", "SECRET_KEY"],
        ["INTERNAL_TOKEN", "INTERNAL_TOKEN"],
      ] as const) {
        const v = iniValue(ini, "security", k);
        if (v) secrets[name] = v;
      }
    }
  eachRepoHooks(join(git, "repositories"), fixHooks);
  renameSync(part, dest);
  return secrets;
}

// --- an admin's asks, and each host's part ---------------------------------------

// POST /api/stacks/legacy-git/move { from, standbys }: from's copy moved, on from
export function AskMove(p: Record<string, any>, by: string): [number, any] {
  const from = typeof p.from === "string" ? p.from : "";
  const hosts = seams.hosts();
  if (!hosts.includes(from)) return [400, { error: `${from || "no host"} isn't a phosphorus host` }];
  const standbys = (Array.isArray(p.standbys) ? p.standbys : []).filter(
    (h: unknown): h is string => typeof h === "string" && h !== from,
  );
  for (const h of standbys) if (!hosts.includes(h)) return [400, { error: `${h} isn't a phosphorus host` }];
  if (wantOf(id)) return [409, { error: "Forgejo is already installed as git" }];
  const cur = legacyOf();
  if (cur?.state === "asked" || cur?.state === "copying")
    return [409, { error: `the move on ${cur.from} is already under way` }];
  const l: LegacyGit = { from, standbys: [...new Set(standbys)], by, at: now(), state: "asked" };
  write(l);
  seams.kick();
  return [200, { ok: true, legacy: l }];
}

// POST /api/stacks/legacy-git/clear: the old copies deleted, once the stack serves;
// moved here or by hand
export function AskClear(by: string, serving: boolean): [number, any] {
  const cur = legacyOf();
  if (cur?.state !== "moved" && !wantOf(id)) return [409, { error: "the old git data hasn't been moved yet" }];
  if (!serving) return [409, { error: "Forgejo isn't serving yet: check it's up before deleting the old copies" }];
  const base: LegacyGit = cur ?? { from: "", standbys: [], by, at: now(), state: "moved" };
  const l: LegacyGit = { ...base, state: "moved", error: undefined, cleared: { by, at: now() } };
  write(l);
  return [200, { ok: true, legacy: l }];
}

let busy = false;

// each host's step: the asked move run on its host; the old copy, its state files
// and forgejo's old account removed once cleared
export async function tickLegacy(self: string) {
  if (busy) return;
  busy = true;
  try {
    const l = legacyOf();
    if (l?.state === "asked" && l.from === self) await move(l);
    if (l?.cleared && existsSync(legacyDir())) await clear();
  } finally {
    busy = false;
  }
}

async function move(l: LegacyGit) {
  write({ ...l, state: "copying" });
  const dest = join(dirOf(id), "data", "forgejo");
  let copied = false;
  try {
    if (wantOf(id)) throw new Error("Forgejo is already installed as git");
    const secrets = copyLegacy(legacyDir(), dest);
    copied = true;
    logf("legacy git: %s copied into %s", legacyDir(), dest);
    const [st, out] = await Install({ ...app, env: secrets, active: l.from, standbys: l.standbys }, l.by);
    if (st !== 200) throw new Error(obj(out)?.error ?? `install answered ${st}`);
    write({ ...l, state: "moved", at: now() });
  } catch (e) {
    if (copied) rmSync(dest, { recursive: true, force: true });
    logf("legacy git: the move failed: %s", errText(e));
    write({ ...l, state: "failed", error: errText(e), at: now() });
  }
}

async function clear() {
  logf("legacy git: deleting %s", legacyDir());
  rmSync(legacyDir(), { recursive: true, force: true });
  try {
    for (const f of readdirSync(StateDir).filter((f) => /^git-/.test(f)))
      rmSync(join(StateDir, f), { recursive: true, force: true });
  } catch {}
  if (process.platform === "linux") await run(["userdel", "phosphorus-git"]);
}
