// what a write made keeps the owner it replaced: phosphorus writes as root, so a
// home handed to its user's own login on this machine stays that login's, file
// by file; Windows' files keep their folder's permissions on their own
import { chmodSync, existsSync, lchownSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

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
