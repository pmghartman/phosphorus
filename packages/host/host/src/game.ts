// the frontend's play/stop onto this host: a key in state/game-control/,
// authorized for the forced command alone, which runs a game's start or stop
// line from config/services.export
import { chownSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseIni } from "@phosphorus/ini";
import { lockACL } from "@phosphorus/util";
import { at, binPath, eprint, ExitCode, fail, fileExists, home, isWindows, output, run, say } from "./base.ts";

const gameTag = "phosphorus-game-control";
const gameName = /^[a-z0-9][a-z0-9-]*$/;

// one account, as Go's os/user names it: the uid and gid strings, "" where unknown
export type User = { username: string; homeDir: string; uid: string; gid: string };

export function currentUser(): User {
  const u = userInfo();
  return { username: u.username, homeDir: u.homedir, uid: u.uid < 0 ? "" : String(u.uid), gid: u.gid < 0 ? "" : String(u.gid) };
}

// lookupUser by name: passwd on Linux, Directory Services on macOS, the
// profile list on Windows; undefined when there's no such account
export async function lookupUser(name: string): Promise<User | undefined> {
  const me = currentUser();
  if (me.username === name) return me;
  if (process.platform === "linux") {
    const f = (await output("getent", "passwd", name)).split(":");
    if (f.length < 6) return undefined;
    return { username: name, uid: f[2]!, gid: f[3]!, homeDir: f[5]! };
  }
  if (process.platform === "darwin") {
    const out = await output("dscl", ".", "-read", "/Users/" + name, "UniqueID", "PrimaryGroupID", "NFSHomeDirectory");
    const get = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(out)?.[1]?.trim() ?? "";
    if (!get("UniqueID")) return undefined;
    return { username: name, uid: get("UniqueID"), gid: get("PrimaryGroupID"), homeDir: get("NFSHomeDirectory") };
  }
  const q = "'" + name.replaceAll("'", "''") + "'";
  const out = await output("powershell", "-NoProfile", "-NonInteractive", "-Command", `$s = (New-Object System.Security.Principal.NTAccount(${q})).Translate([System.Security.Principal.SecurityIdentifier]).Value; $s; (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\$s" -ErrorAction SilentlyContinue).ProfileImagePath`);
  const [sid = "", homeDir = ""] = out.split(/\r?\n/).map((l) => l.trim());
  if (!sid) return undefined;
  return { username: name, uid: sid, gid: "", homeDir };
}

// gameControl the play/stop key's forced command: a game's start or stop line
// from config/services.export, on the host, the key never reaching a shell
export async function gameControl() {
  const f = (process.env.SSH_ORIGINAL_COMMAND ?? "").trim().split(/\s+/).filter(Boolean);
  if (f.length !== 2 || (f[0] !== "start" && f[0] !== "stop")) throw fail("usage: start|stop <name>");
  const [action, name] = f as [string, string];
  if (!gameName.test(name)) throw fail("bad game name");
  let text = "";
  try {
    text = readFileSync(at("config", "services.export"), "utf8");
  } catch {}
  const keys = parseIni(text);
  const cmd = keys.get(name + "\0type") === "game" ? keys.get(name + "\0" + action) ?? "" : "";
  if (!cmd) throw fail(`${name} has no ${action} command in services.export`);
  // output to a file, not the ssh channel a backgrounded server would hold open
  const dir = at("state", "game-control");
  mkdirSync(dir, { recursive: true });
  const logf = join(dir, name + ".log");
  const l = openSync(logf, "a", 0o644);
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const now = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  writeFileSync(l, `--- ${now} ${action}: ${cmd}\n`);
  const argv = isWindows ? ["powershell", "-NoProfile", "-Command", cmd] : [process.env.SHELL || "/bin/sh", "-lc", cmd];
  let code: number;
  try {
    code = await Bun.spawn(argv, { stdin: "ignore", stdout: l, stderr: l, windowsHide: true }).exited;
  } finally {
    closeSync(l);
  }
  if (code !== 0) {
    let ls: string[] = [];
    try {
      ls = readFileSync(logf, "utf8").replace(/\n+$/, "").split("\n");
    } catch {}
    eprint(ls.slice(-5).join("\n") + "\n");
    throw new ExitCode(code);
  }
}

// gameControlSetup the frontend's play/stop onto this host: a key in
// state/game-control/, authorized for the forced command alone, safe to re-run
export async function gameControlSetup() {
  const u = currentUser();
  const dir = at("state", "game-control");
  const key = join(dir, "id_ed25519");
  // state/ root's on Linux
  let ok = true;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    ok = false;
  }
  if (!ok || !writable(dir)) {
    if (isWindows || !(await run("sudo", "mkdir", "-p", dir)) || !(await run("sudo", "chown", u.username, dir))) throw fail(`can't write ${dir}`);
  }
  if (!fileExists(key)) {
    if (!(await run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", gameTag, "-f", key))) throw fail("ssh-keygen failed");
  }
  const name = u.username.slice(u.username.lastIndexOf("\\") + 1);
  writeFileSync(join(dir, "user"), name + "\n", { mode: 0o644 });
  const changed = await authorizeGameKey(u);
  if (!changed) {
    say(`play/stop key already authorized for ${name}`);
    return;
  }
  say(`authorized the play/stop key for ${name}, it can only start and stop games in services.export`);
}

// the forced command's line for a key: restrict,command="<bin> game-control --home <home>" <key>
export const gameKeyLine = (bin: string, home: string, pub: string) => "restrict,command=" + JSON.stringify(bin + " game-control --home " + home) + " " + pub.trim();

// authorizeGameKey u's authorized_keys line for the key, pointed at this
// binary; a stale one (an older key, or a script an old release shipped) swapped out
export async function authorizeGameKey(u: User): Promise<boolean> {
  const pub = readFileSync(join(at("state", "game-control"), "id_ed25519.pub"), "utf8");
  const line = gameKeyLine(binPath("phosphorus"), home, pub);
  const [ak, admin] = await authorizedKeysFile(u);
  mkdirSync(dirname(ak), { recursive: true, mode: 0o700 });
  let b = "";
  try {
    b = readFileSync(ak, "utf8");
  } catch {}
  const keyPart = pub.trim().split(/\s+/).slice(0, 2).join(" ");
  const kept = authorizedKeysKept(b, line, keyPart);
  if (kept === undefined) {
    if (admin) lockACL(ak, false);
    return false;
  }
  writeFileSync(ak, [...kept, line].join("\n") + "\n", { mode: 0o600 });
  if (admin) lockACL(ak, false);
  return true;
}

// the lines to keep around line: undefined when it's already there, else every
// other line that isn't the tag's or the key's
export function authorizedKeysKept(text: string, line: string, keyPart: string): string[] | undefined {
  const kept: string[] = [];
  for (const l of text.replace(/\n+$/, "").split("\n")) {
    if (l === line) return undefined;
    if (l !== "" && !l.includes(gameTag) && (keyPart === "" || !l.includes(keyPart))) kept.push(l);
  }
  return kept;
}

// authorizedKeysFile where sshd reads u's keys: the profile's, but on Windows an
// administrator's only from ProgramData, and only if just SYSTEM and Administrators hold it
async function authorizedKeysFile(u: User): Promise<[string, boolean]> {
  if (isWindows && (await inAdministrators(u.username))) {
    const pd = process.env.ProgramData || "C:\\ProgramData";
    return [join(pd, "ssh", "administrators_authorized_keys"), true];
  }
  return [join(u.homeDir, ".ssh", "authorized_keys"), false];
}

// inAdministrators whether the local Administrators group, by its SID, lists name
async function inAdministrators(name: string): Promise<boolean> {
  name = name.slice(name.lastIndexOf("\\") + 1).toLowerCase();
  const out = await output("powershell", "-NoProfile", "-Command", "(Get-LocalGroupMember -SID S-1-5-32-544).Name");
  return out.split(/\s+/).some((m) => m.slice(m.lastIndexOf("\\") + 1).toLowerCase() === name);
}

// refreshGameKey at rebuild: a host already set up for play/stop kept pointed
// at the binary in place, never a path an older release used
export async function refreshGameKey() {
  const dir = at("state", "game-control");
  let name: string;
  try {
    name = readFileSync(join(dir, "user"), "utf8").trim();
  } catch {
    return;
  }
  if (!fileExists(join(dir, "id_ed25519.pub"))) return;
  const u = await lookupUser(name);
  if (!u) return;
  let changed: boolean;
  try {
    changed = await authorizeGameKey(u);
  } catch (e) {
    say(`couldn't refresh the play/stop key for ${u.username}: ${e instanceof Error ? e.message : e}`);
    return;
  }
  if (changed) {
    const [ak, admin] = await authorizedKeysFile(u);
    if (!admin) chownUser(u, dirname(ak), ak);
    say(`play/stop key for ${u.username} pointed at ${binPath("phosphorus")}`);
  }
}

// chownUser paths given to u, where ids mean anything
function chownUser(u: User, ...paths: string[]) {
  const uid = Number(u.uid), gid = Number(u.gid);
  if (!u.uid || !u.gid || !Number.isInteger(uid) || !Number.isInteger(gid)) return;
  for (const p of paths) {
    try {
      chownSync(p, uid, gid);
    } catch {}
  }
}

function writable(dir: string): boolean {
  try {
    const d = mkdtempSync(join(dir, ".w"));
    rmSync(d, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// unauthorizeGame the play/stop key's line out of authorized_keys
export function unauthorizeGame() {
  const ak = join(currentUser().homeDir, ".ssh", "authorized_keys");
  let b: string;
  try {
    b = readFileSync(ak, "utf8");
  } catch {
    return;
  }
  if (!b.includes(gameTag)) return;
  const kept = b.replace(/\n+$/, "").split("\n").filter((l) => !l.includes(gameTag));
  try {
    writeFileSync(ak, kept.join("\n") + "\n", { mode: 0o600 });
  } catch {}
}
