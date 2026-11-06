// macOS updates as root takes them: the tray's download read once, checked against
// the release key, unpacked where only root writes, installed by its own binary

import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parsePublicKey } from "@phosphorus/minisign";
import { at, capture, errText, fail, fileExists, home, lastLine, readTrim } from "../base.ts";
import type { Reporter } from "../os.ts";

// the feed's key, set by the build's --define as the tray's is; a dev build has none
declare const PHOSPHORUS_FEED_PUBKEY: string;
export function releaseKey(): string {
  try {
    return PHOSPHORUS_FEED_PUBKEY;
  } catch {
    return "";
  }
}

export const stageDir = () => at("state", "run", "update");

// a bundle's limit, well past the app's own size
const maxBundle = 1 << 30;

// readSigned the file's bytes, read once: a plain file of the asking user's,
// signed by the release key; what's checked is what's unpacked
export function readSigned(file: string, signature: string, uid: number, key: string): Buffer {
  if (!key) throw fail("this build has no release key: install the latest release by hand");
  if (!isAbsolute(file)) throw fail("the update isn't a full path");
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (e) {
    throw fail(`can't read the update: ${errText(e)}`);
  }
  if (!st.isFile()) throw fail("the update isn't a plain file");
  if (uid !== 0 && st.uid !== uid) throw fail("the update isn't the asking user's own file");
  if (st.size > maxBundle) throw fail("the update is too big");
  const data = readFileSync(file);
  try {
    parsePublicKey(key).verify(data, signature);
  } catch (e) {
    throw fail("the update's signature doesn't match the release key: " + errText(e));
  }
  return data;
}

export type Staged = { bin: string; payload: string; version: string };

// staged the unpacked app's binary and release, undefined when there's none
export function staged(dir = stageDir()): Staged | undefined {
  const x = join(dir, "x");
  let name: string | undefined;
  try {
    name = readdirSync(x).find((n) => n.endsWith(".app"));
  } catch {}
  if (!name) return;
  const app = join(x, name, "Contents");
  const s = {
    bin: join(app, "MacOS", "Phosphorus"),
    payload: join(app, "Resources", "release"),
    version: readTrim(join(app, "Resources", "release", "VERSION")),
  };
  return fileExists(s.bin) && s.version ? s : undefined;
}

// stageUpdate the checked bundle unpacked into a fresh dir of root's alone
export async function stageUpdate(
  file: string,
  signature: string,
  uid: number,
  key: string,
  dir = stageDir(),
): Promise<Staged> {
  const data = readSigned(file, signature, uid, key);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "x"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tgz = join(dir, "app.tar.gz");
  writeFileSync(tgz, data, { mode: 0o600 });
  const r = await capture(["/usr/bin/tar", "-xzf", tgz, "-C", join(dir, "x")], false);
  rmSync(tgz, { force: true });
  const s = staged(dir);
  if (r.code !== 0 || !s) {
    rmSync(dir, { recursive: true, force: true });
    throw fail(r.code !== 0 ? "unpacking the update: " + lastLine(r.out) : "no Phosphorus.app in the update");
  }
  return s;
}

// upgradeApp the staged release installed by its own binary, its word
// reported, the stage then gone
export async function upgradeApp(report: Reporter) {
  const s = staged();
  if (!s) {
    report("failed", false, "", "nothing staged: the Phosphorus app brings this host's updates");
    throw fail("no staged update");
  }
  report("running", false, s.version, "");
  const r = await capture([s.bin, "install", "--update", "--payload", s.payload, "--home", home], true);
  rmSync(stageDir(), { recursive: true, force: true });
  if (r.code !== 0) {
    report("failed", false, "", lastLine(r.out, /ERROR/) || "install failed");
    throw fail("install failed");
  }
  report("ok", false, s.version, "");
}
