// the app's play/stop key on this host: kept in its folder, authorized in the
// login's authorized_keys from this host alone, as phosphorus (root, LocalSystem)
// may write there; written only for a login someone with its password allowed
import { chownSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { lockACL, run } from "@phosphorus/util";
import { utils } from "ssh2";

const tag = "phosphorus-games";
const isWindows = process.platform === "win32";

export type Key = { priv: string; pub: string };

// the key in dir, made the first time
export function keyIn(dir: string): Key {
  const priv = join(dir, "key"),
    pub = join(dir, "key.pub");
  if (!existsSync(priv) || !existsSync(pub)) {
    const k = utils.generateKeyPairSync("ed25519", { comment: tag });
    mkdirSync(dir, { recursive: true });
    writeFileSync(priv, k.private, { mode: 0o600 });
    writeFileSync(pub, k.public + "\n", { mode: 0o644 });
    lockACL(priv, false);
  }
  return { priv: readFileSync(priv, "utf8"), pub: readFileSync(pub, "utf8").trim() };
}

// the authorized_keys line: no pty or forwarding, from this host only
export const keyLine = (pub: string) => `restrict,from="127.0.0.1,::1" ${pub.trim()}`;

// the lines to keep around line: undefined when it's there already, else every
// other one that isn't this app's
export function keptAround(text: string, line: string): string[] | undefined {
  const kept: string[] = [];
  for (const l of text.replace(/\n+$/, "").split("\n")) {
    if (l === line) return undefined;
    if (l !== "" && !l.includes(tag)) kept.push(l);
  }
  return kept;
}

// one account, as the OS names it: ids where there are any, its home
type User = { name: string; home: string; uid: string; gid: string };

const out = async (...argv: string[]) => {
  const r = await run(argv, { timeoutMs: 15000 });
  return r.ok ? r.stdout : "";
};

// an account by name: passwd on Linux, Directory Services on macOS, the profile
// list on Windows; undefined when there's no such account
export async function lookupUser(name: string): Promise<User | undefined> {
  const me = userInfo();
  if (me.username === name) return { name, home: me.homedir, uid: String(me.uid), gid: String(me.gid) };
  if (process.platform === "linux") {
    const f = (await out("getent", "passwd", name)).split(":");
    return f.length < 6 ? undefined : { name, uid: f[2]!, gid: f[3]!, home: f[5]! };
  }
  if (process.platform === "darwin") {
    const o = await out("dscl", ".", "-read", "/Users/" + name, "UniqueID", "PrimaryGroupID", "NFSHomeDirectory");
    const get = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(o)?.[1]?.trim() ?? "";
    return get("UniqueID")
      ? { name, uid: get("UniqueID"), gid: get("PrimaryGroupID"), home: get("NFSHomeDirectory") }
      : undefined;
  }
  const q = "'" + name.replaceAll("'", "''") + "'";
  const o = await out(
    "powershell",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$s = (New-Object System.Security.Principal.NTAccount(${q})).Translate([System.Security.Principal.SecurityIdentifier]).Value; $s; (Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\$s" -ErrorAction SilentlyContinue).ProfileImagePath`,
  );
  const [sid = "", home = ""] = o.split(/\r?\n/).map((l) => l.trim());
  return sid && home ? { name, uid: "", gid: "", home } : undefined;
}

// whether the local Administrators group, by its SID, lists name
async function inAdministrators(name: string): Promise<boolean> {
  name = name.slice(name.lastIndexOf("\\") + 1).toLowerCase();
  const o = await out("powershell", "-NoProfile", "-Command", "(Get-LocalGroupMember -SID S-1-5-32-544).Name");
  return o.split(/\r?\n/).some(
    (m) =>
      m
        .trim()
        .slice(m.trim().lastIndexOf("\\") + 1)
        .toLowerCase() === name,
  );
}

// where sshd reads u's keys: the profile's, but on Windows an administrator's only
// from ProgramData, and only while just SYSTEM and Administrators hold it
async function keysFile(u: User): Promise<[string, boolean]> {
  if (isWindows && (await inAdministrators(u.name)))
    return [join(process.env.ProgramData || "C:\\ProgramData", "ssh", "administrators_authorized_keys"), true];
  return [join(u.home, ".ssh", "authorized_keys"), false];
}

// u's own, where ids mean anything
function chownTo(u: User, ...paths: string[]) {
  const uid = Number(u.uid),
    gid = Number(u.gid);
  if (isWindows || !u.uid || !u.gid || !Number.isInteger(uid) || !Number.isInteger(gid)) return;
  for (const p of paths)
    try {
      chownSync(p, uid, gid);
    } catch {}
}

// the key's line in login's authorized_keys, or out of it with line ""; an older
// line of this app's swapped out either way
async function edit(login: string, line: string) {
  const u = await lookupUser(login);
  if (!u) throw new Error(`there's no account ${login} here`);
  const [file, admin] = await keysFile(u);
  let text = "";
  try {
    text = readFileSync(file, "utf8").replaceAll("\r\n", "\n");
  } catch {}
  const kept = keptAround(text, line);
  if (kept === undefined) return;
  if (!line && kept.length === text.replace(/\n+$/, "").split("\n").filter(Boolean).length) return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, [...kept, ...(line ? [line] : [])].join("\n") + "\n", { mode: 0o600 });
  if (admin) lockACL(file, false);
  else chownTo(u, dirname(file), file);
}

export const authorize = (login: string, k: Key) => edit(login, keyLine(k.pub));
export const unauthorize = (login: string) => edit(login, "");
