// macOS: a LaunchDaemon run as root, the console user's tray over its socket,
// no distro packages

import { chownSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import {
  at,
  binPath,
  ExitCode,
  errText,
  fail,
  fileExists,
  home,
  isMac,
  keysMissing,
  logTo,
  openLog,
  output,
  quiet,
  readTrim,
  run,
  say,
  sleep,
} from "./base.ts";
import { newStop, type OS, type Stop } from "./os.ts";
import {
  asRoot,
  elevateUninstall,
  isAdmin,
  lockRebuild,
  needSetup,
  setupOS,
  spawnDetached,
  terminate,
  uninstallAdmin,
  unixOnly,
} from "./unix.ts";

if (isMac) {
  // Finder's PATH: no homebrew tools
  process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:" + (process.env.PATH ?? "");
}

export const label = "dev.phosphorus.host";
export const plistPath = "/Library/LaunchDaemons/" + label + ".plist";
const target = "system/" + label;

const libexec = () => at("state", "cache", "tools");
const tool = (name: string) => join(libexec(), name);
const logHint = () => at("state", "log", "phosphorus.log");

// the console user the daemon answers, recorded by the app's admin step
export const ownerFile = () => at(".phosphorus-tray-uid");
export function ownerUid(): number | undefined {
  const n = Number(readTrim(ownerFile()));
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

// stop and start with the daemon kept: held asks run to stop its children,
// holding is run's word that none are up
export const heldFile = () => at("state", "run", "held");
export const holdingFile = () => at("state", "run", "holding");
// nativeEnvFile's path, native.ts importing this file through os.ts
const bakedEnv = () => at("state", "run", "native.env");

export const xmlEsc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// the LaunchDaemon: run --home as root, kept alive, its output to the log
export const plistText = (bin: string, home: string, log: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>${label}</string>
	<key>ProgramArguments</key>
	<array><string>${xmlEsc(bin)}</string><string>run</string><string>--home</string><string>${xmlEsc(home)}</string></array>
	<key>EnvironmentVariables</key>
	<dict><key>PHOSPHORUS_HOME</key><string>${xmlEsc(home)}</string></dict>
	<key>WorkingDirectory</key><string>${xmlEsc(home)}</string>
	<key>UserName</key><string>root</string>
	<key>GroupName</key><string>wheel</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>ExitTimeOut</key><integer>150</integer>
	<key>StandardOutPath</key><string>${xmlEsc(log)}</string>
	<key>StandardErrorPath</key><string>${xmlEsc(log)}</string>
</dict>
</plist>
`;

const pidRe = /^\s*pid = (\d+)/m;
const svcPrint = () => output("launchctl", "print", target);
const loaded = () => quiet("launchctl", "print", target);
const daemonUp = async () => pidRe.test(await svcPrint());
// up: the daemon's pid, its children neither held nor down
const svcActive = async () => (await daemonUp()) && !fileExists(heldFile()) && !fileExists(holdingFile());

// svcStart the hold lifted, the daemon (re)started on the binary and env now there
async function svcStart() {
  rmSync(heldFile(), { force: true });
  await quiet("launchctl", "enable", target);
  if (!(await loaded())) {
    if (!(await run("launchctl", "bootstrap", "system", plistPath))) throw fail("launchctl bootstrap failed");
    return;
  }
  if (!(await run("launchctl", "kickstart", "-k", target))) throw fail("launchctl kickstart failed");
}

// argv as the console user in their own session: what root can't open for them
export function asOwner(argv: string[]): string[] {
  const uid = ownerUid();
  if (process.geteuid?.() !== 0 || !uid) return argv;
  return ["launchctl", "asuser", String(uid), "sudo", "-u", "#" + uid, ...argv];
}

// serve run's rounds until TERM, the socket up throughout: a round held, waited
// on for keys and the baked env, or tried again slower after a failure
export async function serve(main: (stop: Stop) => Promise<number>): Promise<number> {
  const stop = newStop();
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.once(sig, () => stop.fire());
  darwin.logToFile();
  let up = false;
  const { daemonDeps, serveControl } = await import("./mac/ctl.ts");
  const close = serveControl(daemonDeps(() => up));
  const ready = () => !fileExists(heldFile()) && fileExists(bakedEnv()) && !keysMissing();
  const idle = (on: boolean) => {
    try {
      if (on) writeFileSync(holdingFile(), "", { mode: 0o644 });
      else rmSync(holdingFile(), { force: true });
    } catch {}
  };
  mkdirSync(at("state", "run"), { recursive: true });
  let backoff = 0;
  while (!stop.on) {
    if (!ready()) {
      idle(true);
      await Promise.race([sleep(1000), stop.p]);
      continue;
    }
    idle(false);
    const round = newStop();
    const watch = setInterval(() => {
      if (fileExists(heldFile())) round.fire();
    }, 1000);
    void stop.p.then(() => round.fire());
    up = true;
    let code = 1;
    try {
      code = await main(round);
    } catch (e) {
      if (!(e instanceof ExitCode)) say(`ERROR: ${errText(e)}`);
    }
    up = false;
    clearInterval(watch);
    if (stop.on) break;
    if (round.on) {
      say("held: its services stopped until phos start");
      backoff = 0;
      continue;
    }
    // a crash loop slowed, as launchd would have
    backoff = Math.min(Math.max(backoff * 2, 5000), 60_000);
    say(`run ended (${code}), again in ${backoff / 1000}s`);
    await Promise.race([sleep(backoff), stop.p]);
  }
  idle(true);
  close();
  return 0;
}

let logOpen = false;

export const darwin: OS = {
  sshdName: "Remote Login (ssh)",
  async enableSSHD() {
    if (await run("systemsetup", "-setremotelogin", "on")) return;
    // systemsetup without Full Disk Access on newer macOS
    if (!(await run("launchctl", "load", "-w", "/System/Library/LaunchDaemons/ssh.plist")))
      throw fail("couldn't turn on Remote Login");
  },
  asRoot,
  isAdmin,
  spawnDetached,
  needSetup,
  setupOS,
  lockRebuild,
  uninstallAdmin,
  elevateUninstall,
  ...unixOnly,
  libexec,
  logHint,
  // svcInstall the daemon's plist, root's and read by all; a loaded one booted
  // out to take a changed plist
  async svcInstall() {
    if (process.geteuid?.() !== 0) throw fail("the daemon is root's: sudo phos start, or the Phosphorus app");
    const plist = plistText(binPath("phosphorus"), home, logHint());
    let have = "";
    try {
      have = readFileSync(plistPath, "utf8");
    } catch {}
    if (have === plist) return;
    try {
      writeFileSync(plistPath, plist, { mode: 0o644 });
      chownSync(plistPath, 0, 0);
    } catch (e) {
      throw fail(`couldn't write ${plistPath}: ${errText(e)}`);
    }
    if (await loaded()) await quiet("launchctl", "bootout", target);
  },
  svcActive,
  svcSince: async () => pidRe.exec(await svcPrint())?.[1] ?? "",
  svcStart,
  // svcStop run's children stopped in order, the daemon and its socket kept; held through reboots
  async svcStop() {
    mkdirSync(at("state", "run"), { recursive: true });
    writeFileSync(heldFile(), "", { mode: 0o644 });
    if (!(await daemonUp())) return;
    for (const end = Date.now() + 150_000; Date.now() < end; await sleep(500))
      if (fileExists(holdingFile()) || !(await daemonUp())) return;
    throw fail("phosphorus didn't stop its services in time");
  },
  async svcRestart(noBlock) {
    if (!(await svcActive())) return svcStart();
    if (noBlock) {
      Bun.spawn(["launchctl", "kickstart", "-k", target], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).unref();
      return;
    }
    if (!(await run("launchctl", "kickstart", "-k", target))) throw fail("launchctl kickstart failed");
  },
  // svcRemove the daemon booted out, its plist gone
  svcRemove() {
    Bun.spawnSync(["launchctl", "bootout", target], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    rmSync(plistPath, { force: true });
  },
  missingDeps: async () => [],
  async aptInstall() {},
  async deferRebuild() {},
  runtimeDir: () => at("state", "run"),
  // run's own group kept, launchd killing it whole when run goes
  childDetached: false,
  terminate,
  async killTree(p: Subprocess) {
    p.kill("SIGKILL");
  },
  // logToFile state/log/phosphorus.log for run and its children, the last one kept
  // as .1 once past 20MB; once for the daemon's life, not every round
  logToFile() {
    if (logOpen) return;
    const fd = openLog();
    if (fd !== undefined) logTo(fd);
    logOpen = fd !== undefined;
  },
  serve,
  // upgradeApp the bundle the daemon checked and staged, installed by its own binary
  upgradeApp: async (report) => (await import("./mac/update.ts")).upgradeApp(report),
};
