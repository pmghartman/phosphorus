// Linux's and macOS's shared side: sudo, a detached session, the admin setup
// (ssh server, ssh by name, PATH links), the rebuild lock and run's signals
import type { Subprocess } from "bun";
import { dlopen } from "bun:ffi";
import { closeSync, mkdirSync, openSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { at, binPath, fail, home, isMac, readTrim, say, selfArgv, spawnIO, sshdUp, sshInclude } from "./base.ts";
import type { OS, Reporter, Stop } from "./os.ts";
import { newStop, os } from "./os.ts";

// asRoot this command again through sudo, its exit code passed on
export async function asRoot(args: string[]): Promise<number> {
  const code = await spawnIO(["sudo", ...selfArgv(), ...args], { stdin: "inherit" });
  return code < 0 ? 1 : code;
}

export const isAdmin = async () => process.geteuid?.() === 0;

// spawnDetached its own session, out of reach of a dropped terminal's hangup
export async function spawnDetached(args: string[], log: string): Promise<() => Promise<void>> {
  const fd = openSync(log, "w");
  let p: Subprocess;
  try {
    p = Bun.spawn([...selfArgv(), ...args], {
      env: { ...process.env, PHOSPHORUS_DETACHED: "1" },
      stdin: "ignore",
      stdout: fd,
      stderr: fd,
      detached: true,
    });
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return () => p.exited.then(() => closeSync(fd));
}

const sshInc = "/etc/ssh/ssh_config.d/phosphorus.conf";
const links = ["/usr/local/bin/phosphorus", "/usr/local/bin/phos"];

const readlink = (p: string) => {
  try {
    return readlinkSync(p);
  } catch {
    return "";
  }
};

const linked = () => links.every((l) => readlink(l) === binPath("phosphorus"));

export async function needSetup(): Promise<string> {
  if (!(await sshdUp())) return os.sshdName;
  if (readTrim(sshInc) !== sshInclude()) return "ssh to hosts by name";
  if (!linked()) return "phosphorus on PATH";
  if (!os.tailscaleInstalled()) return "Tailscale";
  return "";
}

export async function setupOS() {
  if (await sshdUp()) say(`${os.sshdName} already up, skipping`);
  else {
    say(`turning on ${os.sshdName}...`);
    await os.enableSSHD();
  }
  if (readTrim(sshInc) !== sshInclude()) {
    say("letting ssh reach hosts by name...");
    mkdirSync("/etc/ssh/ssh_config.d", { recursive: true });
    writeFileSync(sshInc, sshInclude() + "\n", { mode: 0o644 });
  }
  if (!linked()) {
    say("putting phosphorus and phos on PATH...");
    mkdirSync("/usr/local/bin", { recursive: true });
    for (const l of links) {
      rmSync(l, { force: true });
      symlinkSync(binPath("phosphorus"), l);
    }
  }
  if (!os.tailscaleInstalled()) await os.tailscaleInstall();
}

const LOCK_EX = 2, LOCK_NB = 4;
let flock: ((fd: number, op: number) => number) | undefined;
const libc = () => (flock ??= dlopen(isMac ? "libSystem.B.dylib" : "libc.so.6", { flock: { args: ["i32", "i32"], returns: "i32" } }).symbols.flock);

// lockRebuild state/rebuild.lock held for the rebuild, a second one waiting
export async function lockRebuild(): Promise<() => void> {
  const fd = openSync(at("state", "rebuild.lock"), "a+", 0o644);
  const lock = libc();
  if (lock(fd, LOCK_EX | LOCK_NB) !== 0) {
    say("another rebuild is running, waiting for it...");
    if (lock(fd, LOCK_EX) !== 0) {
      closeSync(fd);
      throw fail("couldn't lock " + at("state", "rebuild.lock"));
    }
  }
  return () => closeSync(fd);
}

// uninstallAdmin setup's ssh include and PATH links, only while still ours
export async function uninstallAdmin() {
  if (readTrim(sshInc) === sshInclude()) rmSync(sshInc, { force: true });
  for (const l of links) if (readlink(l) === binPath("phosphorus")) rmSync(l, { force: true });
}

// elevateUninstall sudo on a terminal, else left for the app's own prompt
export async function elevateUninstall() {
  if (!process.stdin.isTTY) {
    say("admin setup left for the Phosphorus app's prompt, or: sudo phosphorus uninstall --admin");
    return;
  }
  await spawnIO(["sudo", ...selfArgv(), "uninstall", "--admin", "--home", home], { stdin: "inherit" });
}

// serve main until TERM or INT
export async function serve(main: (stop: Stop) => Promise<number>): Promise<number> {
  const stop = newStop();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.fire());
  return main(stop);
}

export const terminate = (p: Subprocess) => {
  try {
    p.kill("SIGTERM");
    return true;
  } catch {
    return false;
  }
};

// nothing here: Windows' admin steps and update agent alone
export const unixOnly: Pick<OS, "prepareOS" | "elevateWindows" | "unpath" | "watchUpdateRequests" | "upgradeApp"> = {
  async prepareOS() {},
  async elevateWindows() {},
  async unpath() {},
  // watchUpdateRequests none: systemd's path unit (Linux) or the app (macOS) the agent
  watchUpdateRequests() {},
  // upgradeApp Windows' alone
  async upgradeApp(report: Reporter) {
    report("failed", false, "", "no update feed here");
    throw fail("no update feed");
  },
};
