import { realpathSync } from "node:fs";
import { join } from "node:path";
import { env, ini, RepoDir, StateDir as UtilStateDir } from "@phosphorus/util";
import "./shares.ts";
import "./paths.ts";
import "./listing.ts";
import "./read.ts";
import "./write.ts";
import "./gate.ts";

export const FilesRoot = env("FILES_ROOT", join(RepoDir, "files"));
export const StateDir = UtilStateDir;
export const HomeFS = env("HOME_FS", FilesRoot);
export const Home = "home";
export const HomeRoot = join(HomeFS, Home);

// a text file read or saved whole: source as big as an amalgamation's
export const MaxText = 16 << 20;
export const MaxUpload = 64 * 2 ** 30;
export const maxEntries = 5000;
export const treeDepthMax = 8;
export const uploadTmp = ".phosphorus-upload-";
export const fullPerms = "rwd";
export const Desktop = "Desktop";
export const Shared = "shared";
export const Sys = ".sys";
// what a path nobody may see answers, the same as one that is not there
export const Gone = "no such file or folder";

// [status, body]: what every call here answers
export type Res = [number, any];
export const errBody = (msg: string) => ({ error: msg });

// one served folder
export type Share = {
  id: string;
  label: string;
  perms: string;
  root: string;
  real: string;
  ok: boolean;
  home?: boolean;
};

// a share as the API shows it
export const shareJSON = (s: Share) => ({
  id: s.id,
  label: s.label,
  perms: s.perms,
  ...(s.home ? { home: true } : {}),
});

export const cleanPerms = (spec: string) => ["r", "w", "d"].filter((c) => spec.toLowerCase().includes(c)).join("");
export const splitList = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// [files] dir as phosphorus.ini says now
export const configuredDirs = () => splitList(ini("files", "dir"));
export const mountedDirs = () => splitList(process.env.PHOSPHORUS_FILES_DIRS ?? "");

// a path with forward slashes, trailing ones dropped
export const slashed = (src: string) => src.replaceAll("\\", "/").replace(/(.)\/+$/, "$1");
export const absRe = /^([A-Za-z]:)?\//;

export const realOf = (p: string) => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};
export { gateCode, homeFilterList, homeFilterTree, homeGate, pending, quiet, type Who } from "./gate.ts";
export { globRe, jsNumber, list, search, setTreeMax, TreeMax, tree } from "./listing.ts";
export { own } from "./owner.ts";
export { type Entry, inside, type Located, locate, relOf, safePath, toAbs } from "./paths.ts";
export { downloadPath, looksBinary, makeParents, read, statPath } from "./read.ts";
export { can, enabled, homeDir, init, shareOf, shares } from "./shares.ts";
export { mkdir, onChange, remove, renamePath, type SaveP, save, setOnChange, type UploadQ, write } from "./write.ts";
