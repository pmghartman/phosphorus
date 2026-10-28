// macOS: a LaunchAgent of the account the app runs as, the Tailscale app's
// own node, no distro packages and no git host
import type { Subprocess } from "bun";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { at, binPath, fail, fileExists, home, isMac, logTo, openLog, output, quiet, run } from "./base.ts";
import type { OS } from "./os.ts";
import { installTailscale, tailscaleLogin } from "./tailnet.ts";
import { asRoot, elevateUninstall, isAdmin, lockRebuild, needSetup, serve, setupOS, spawnDetached, terminate, uninstallAdmin, unixOnly } from "./unix.ts";

if (isMac) {
  // Finder's PATH: no homebrew tools
  process.env.PATH = "/opt/homebrew/bin:/usr/local/bin:" + (process.env.PATH ?? "");
  // the app's binary a GUI without a terminal's env: a hung status
  process.env.TAILSCALE_BE_CLI = "1";
}

const label = "dev.phosphorus.host";

// libexec the app's bundled tools, synced into the home with the release
const libexec = () => at("tools");
const tool = (name: string) => join(libexec(), name);
const logHint = () => at("state", "phosphorus.log");
const plistPath = () => join(process.env.HOME ?? "", "Library", "LaunchAgents", label + ".plist");
const domain = () => "gui/" + process.getuid!();

export const xmlEsc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// the LaunchAgent: run --home, kept alive, its output to the log
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
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
	<key>ExitTimeOut</key><integer>150</integer>
	<key>ProcessType</key><string>Interactive</string>
	<key>StandardOutPath</key><string>${xmlEsc(log)}</string>
	<key>StandardErrorPath</key><string>${xmlEsc(log)}</string>
</dict>
</plist>
`;

const pidRe = /^\s*pid = (\d+)/m;
const svcPrint = () => output("launchctl", "print", domain() + "/" + label);
const svcActive = async () => pidRe.test(await svcPrint());

async function svcStart() {
  await quiet("launchctl", "enable", domain() + "/" + label);
  await quiet("launchctl", "bootstrap", domain(), plistPath());
  if (!(await run("launchctl", "kickstart", domain() + "/" + label))) throw fail("launchctl kickstart failed");
}

// --- tailscale: the Tailscale app's own node ---------------------------------------------

const appCLI = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];
const appTailscale = () => appCLI.find(fileExists) ?? "";

// tailscaleLaunch the app, in the background: its daemon lives in it; Homebrew's
// tailscaled root's to start
async function tailscaleLaunch() {
  if (!fileExists(appCLI[0]!)) return;
  // GUI env: not the CLI env this process carries
  const env = { ...process.env };
  delete env.TAILSCALE_BE_CLI;
  try {
    await Bun.spawn(["open", "-a", "/Applications/Tailscale.app"], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited;
  } catch {}
}

const tailscaleHint = () => (fileExists(appCLI[0]!) ? "open the Tailscale app and allow its VPN configuration" : "start Homebrew's tailscaled with sudo brew services start tailscale");

export const darwin: OS = {
  sshdName: "Remote Login (ssh)",
  async enableSSHD() {
    if (await run("systemsetup", "-setremotelogin", "on")) return;
    // systemsetup without Full Disk Access on newer macOS
    if (!(await run("launchctl", "load", "-w", "/System/Library/LaunchDaemons/ssh.plist"))) throw fail("couldn't turn on Remote Login");
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
  async svcInstall() {
    const plist = plistText(binPath("phosphorus"), home, logHint());
    let have = "";
    try {
      have = readFileSync(plistPath(), "utf8");
    } catch {}
    if (have === plist) return;
    mkdirSync(join(plistPath(), ".."), { recursive: true });
    try {
      writeFileSync(plistPath(), plist, { mode: 0o644 });
    } catch (e) {
      throw fail(`couldn't write ${plistPath()}: ${e instanceof Error ? e.message : e}`);
    }
    // a loaded job keeps its old plist until booted out
    if (await svcActive()) await quiet("launchctl", "bootout", domain() + "/" + label);
  },
  svcActive,
  svcSince: async () => pidRe.exec(await svcPrint())?.[1] ?? "",
  svcStart,
  // svcStop TERM to run, which stops its children in order; kept off through logins
  async svcStop() {
    await quiet("launchctl", "disable", domain() + "/" + label);
    await quiet("launchctl", "bootout", domain() + "/" + label);
  },
  async svcRestart(noBlock) {
    await quiet("launchctl", "enable", domain() + "/" + label);
    if (!(await svcActive())) return svcStart();
    if (noBlock) {
      Bun.spawn(["launchctl", "kickstart", "-k", domain() + "/" + label], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).unref();
      return;
    }
    if (!(await run("launchctl", "kickstart", "-k", domain() + "/" + label))) throw fail("launchctl kickstart failed");
  },
  svcRemove: () => rmSync(plistPath(), { force: true }),
  tailscaleDirs: () => [],
  // tailscaleCLI by its own path: through a link the app's binary misses its bundle
  tailscaleCLI: () => appTailscale() || tool("tailscale"),
  tailscaleInstalled: () => appTailscale() !== "",
  tailscaleInstall: () => installTailscale("Tailscale-1.104.1-macos.pkg", "67ec55f18ee2afac0a8fb57f7811977f4ad6df1debd4a187fa0db3dbb5d401d5", (pkg) => run("installer", "-pkg", pkg, "-target", "/")),
  async tailscaleKeepUp() {},
  // tailscaleReady the app's CLI in the tools as tailscale, a script exec'ing its full
  // path for the roles' PATH, logged in with TS_AUTHKEY when it isn't
  async tailscaleReady() {
    const cli = appTailscale();
    if (!cli) throw fail("no Tailscale here: install the Tailscale app (tailscale.com/download), then phos start");
    mkdirSync(libexec(), { recursive: true });
    const sh = "#!/bin/sh\nTAILSCALE_BE_CLI=1 exec '" + cli.replaceAll("'", `'\\''`) + "' \"$@\"\n";
    let have: string | undefined;
    try {
      have = readFileSync(tool("tailscale"), "utf8");
    } catch {}
    if (have !== sh) {
      // an old symlink removed, never written through
      rmSync(tool("tailscale"), { force: true });
      writeFileSync(tool("tailscale"), sh, { mode: 0o755 });
    }
    await tailscaleLogin(tailscaleLaunch, tailscaleHint);
  },
  async tailscaleStart() {},
  tailscaleUpFlags: () => [],
  missingDeps: async () => [],
  async aptInstall() {},
  async deferRebuild() {},
  gitEnv: () => ({}),
  async ensureGitUser() {},
  runtimeDir: () => at("state", "run"),
  // run's own group kept, launchd killing it whole when run goes
  childDetached: false,
  terminate,
  async killTree(p: Subprocess) {
    p.kill("SIGKILL");
  },
  // logToFile state/phosphorus.log for run and its children, the last one kept
  // as .1 once past 20MB
  logToFile() {
    const fd = openLog();
    if (fd !== undefined) logTo(fd);
  },
  serve,
};
