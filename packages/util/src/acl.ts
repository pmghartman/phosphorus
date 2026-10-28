// a file's ACL to SYSTEM and Administrators, plus Authenticated Users read when
// shared, nothing inherited: what OpenSSH accepts for a SYSTEM caller; nothing
// off Windows, file modes do it there
import { runSync } from "./proc.ts";

export function lockACL(file: string, shared: boolean) {
  if (process.platform !== "win32") return;
  // /reset takes no other option: the default ACL first, then ours in its place
  const grants = [file, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F"];
  if (shared) grants.push("*S-1-5-11:RX");
  for (const args of [[file, "/reset"], grants]) {
    const r = runSync(["icacls", ...args]);
    if (!r.ok) throw new Error(`icacls ${file}: ${r.output.trim()}`);
  }
}
