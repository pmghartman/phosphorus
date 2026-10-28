// what a write made keeps the owner it replaced: phosphorus writes as root, so a
// home handed to its user's own login on this machine stays that login's, file
// by file; Windows' files keep their folder's permissions on their own
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { runSync } from "@phosphorus/util";

type Owner = { uid: number; gid: number; mode: number; ok: boolean };
const none: Owner = { uid: 0, gid: 0, mode: 0, ok: false };
const posix = process.platform !== "win32";
const root = () => posix && process.geteuid?.() === 0;

// a file's owner and mode, as it was before a write replaced it
export function ownerAt(p: string): Owner {
  if (!posix) return none;
  try {
    const st = lstatSync(p);
    return { uid: st.uid, gid: st.gid, mode: st.mode & 0o777, ok: true };
  } catch {
    return none;
  }
}

// what a write made at p: the file it replaced's owner and mode, else its folder's owner
export function adopt(p: string, prev: Owner) {
  if (!root()) return;
  const o = prev.ok ? prev : { ...ownerAt(dirname(p)), mode: 0 };
  if (!o.ok || o.uid === 0) return;
  try {
    lchownSync(p, o.uid, o.gid);
    if (prev.ok && prev.mode) chmodSync(p, prev.mode);
  } catch {}
}

// mkdir -p, each folder it makes its parent's owner's
export function mkdirAll(abs: string) {
  const missing: string[] = [];
  for (let d = abs; !existsSync(d); d = dirname(d)) {
    missing.push(d);
    if (dirname(d) === d) break;
  }
  mkdirSync(abs, { recursive: true, mode: 0o755 });
  for (let i = missing.length - 1; i >= 0; i--) adopt(missing[i]!, none);
}

// a user's home on this machine handed to their own login here, so its builds
// and shells write in it as phosphorus does: the folder and all in it
export function own(home: string, login: string): [number, any] {
  if (!posix) return [200, { ok: true, owner: login, already: true }];
  if (process.geteuid?.() !== 0)
    return [409, { error: "Phosphorus doesn't run as root here: the home's already as its files' owners left it" }];
  const id = runSync(["id", "-u", login]),
    gid = runSync(["id", "-g", login]);
  if (!id.ok) return [404, { error: login + " isn't an account on this machine" }];
  const uid = Number(id.stdout.trim()),
    g = Number(gid.stdout.trim());
  if (uid === 0) return [400, { error: "not root's: a home is handed to a person's own login" }];
  const o = ownerAt(home);
  if (o.ok && o.uid === uid) return [200, { ok: true, owner: login, already: true }];
  let bad: Error | undefined;
  const walk = (p: string) => {
    try {
      lchownSync(p, uid, g);
    } catch (e: any) {
      if (e?.code !== "ENOENT") bad ??= e;
    }
    let ents;
    try {
      ents = lstatSync(p).isDirectory() ? readdirSync(p) : [];
    } catch {
      return;
    }
    for (const n of ents) walk(join(p, n));
  };
  walk(home);
  return bad ? [500, { error: bad.message }] : [200, { ok: true, owner: login }];
}
