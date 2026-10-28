// Linux: systemd's units shipped by the package, the machine's tailscaled or
// the bundled one, distro packages, forgejo's account, run's children by group

import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runSync } from "@phosphorus/util";
import type { Subprocess } from "bun";
import {
  at,
  binPath,
  fail,
  fileExists,
  gitd,
  has,
  home,
  iniGet,
  isGitHost,
  isModelHost,
  output,
  quiet,
  run,
  say,
  sleep,
  spawnIO,
} from "./base.ts";
import type { OS } from "./os.ts";
import {
  asRoot,
  elevateUninstall,
  isAdmin,
  lockRebuild,
  needSetup,
  serve,
  setupOS,
  spawnDetached,
  terminate,
  uninstallAdmin,
  unixOnly,
} from "./unix.ts";

const unit = "phosphorus.service",
  tsUnit = "phosphorus-tailscaled.service";
// runDir the git daemon's and elector's shared files, systemd's RuntimeDirectory
const runDir = "/run/phosphorus";
const gitUser = "phosphorus-git";

// libexec the package's bundled tools
const libexec = () => "/usr/libexec/phosphorus";
const tool = (name: string) => join(libexec(), name);

const unitActive = (u: string) => quiet("systemctl", "is-active", "--quiet", u);
// the machine's own tailscaled, asked for on each use as Go did, synchronously
const systemTailscale = () => runSync(["systemctl", "is-active", "--quiet", "tailscaled.service"]).ok;

// installed already as the package's dependency: enabled only
async function enableSSHD() {
  if (!existsSync("/usr/sbin/sshd")) {
    if (has("apt-get")) await run("apt-get", "install", "-y", "openssh-server");
    else if (has("dnf")) await run("dnf", "install", "-y", "openssh-server");
    else if (has("pacman")) await run("pacman", "-Sy", "--noconfirm", "openssh");
    else throw fail("no apt, dnf or pacman: install and enable an ssh server, then run phos start again");
  }
  if (!(await quiet("systemctl", "enable", "--now", "ssh")) && !(await quiet("systemctl", "enable", "--now", "sshd")))
    throw fail("couldn't enable the ssh server");
  let cfg = "";
  try {
    cfg = readFileSync("/etc/ssh/ssh_config", "utf8");
  } catch {}
  if (!cfg.includes("ssh_config.d"))
    say(
      "/etc/ssh/ssh_config never reads ssh_config.d, add 'Include /etc/ssh/ssh_config.d/*.conf' at its top for ssh <host>",
    );
}

type Dep = { bin?: string; lib?: string; file?: string; pkg: string };

// missingDeps the distro packages this host's roles need and lack
async function missingDeps(): Promise<string[]> {
  const want: Dep[] = [
    { bin: "ss", pkg: "iproute2" },
    { bin: "ssh", pkg: "openssh-client" },
    { bin: "setpriv", pkg: "util-linux" },
  ];
  if (isGitHost())
    want.push({ bin: "git", pkg: "git" }, { bin: "rsync", pkg: "rsync" }, { bin: "sqlite3", pkg: "sqlite3" });
  if (isModelHost()) {
    want.push(
      { bin: "curl", pkg: "curl" },
      { bin: "git", pkg: "git" },
      { bin: "rg", pkg: "ripgrep" },
      { lib: "libgomp.so.1", pkg: "libgomp1" },
    );
    // llama-server's vulkan build, for amd and intel gpus
    if (iniGet("model", "gpu") === "true" && !has("nvidia-smi"))
      want.push(
        { lib: "libvulkan.so.1", pkg: "libvulkan1" },
        { file: "/usr/share/vulkan/icd.d/radeon_icd.x86_64.json", pkg: "mesa-vulkan-drivers" },
      );
  }
  let libs = "";
  const out: string[] = [],
    seen = new Set<string>();
  for (const d of want) {
    let ok: boolean;
    if (d.bin) ok = has(d.bin);
    else if (d.file) ok = fileExists(d.file);
    else {
      if (!libs) libs = await output("ldconfig", "-p");
      ok = libs.includes(d.lib!);
    }
    if (!ok && !seen.has(d.pkg)) {
      seen.add(d.pkg);
      out.push(d.pkg);
    }
  }
  return out;
}

// aptInstall from the distro's own sources, waiting out a running dpkg
async function aptInstall(pkgs: string[]) {
  if (!has("apt-get")) throw fail(`missing ${pkgs.join(", ")} and no apt-get: install them, then phos start`);
  say(`installing ${pkgs.join(", ")}...`);
  const args = ["-q", "-y", "--no-install-recommends", "-o", "DPkg::Lock::Timeout=900", "install", ...pkgs];
  const tryIt = async () =>
    (await spawnIO(["apt-get", ...args], { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } })) === 0;
  if (await tryIt()) return;
  // lists missing on a fresh image, or stale
  await run("apt-get", "-q", "-o", "DPkg::Lock::Timeout=900", "update");
  if (!(await tryIt())) throw fail(`couldn't install ${pkgs.join(", ")}`);
}

// deferRebuild the rest once dpkg lets go: apt can't run inside a package's own script
async function deferRebuild() {
  const name = `phosphorus-rebuild-${Math.floor(Date.now() / 1000)}`;
  const ok = await run(
    "systemd-run",
    "--unit=" + name,
    "--collect",
    "--no-block",
    "--description=Phosphorus rebuild",
    "--setenv=PHOSPHORUS_HOME=" + home,
    binPath("phosphorus"),
    "rebuild",
    "--home",
    home,
  );
  if (!ok) throw fail("couldn't hand the rebuild to systemd: systemd-run failed");
  say(`finishing once the package manager is done, follow it with: journalctl -fu ${name}`);
}

export const linux: OS = {
  sshdName: "an ssh server",
  enableSSHD,
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
  logHint: () => "journalctl -u phosphorus",
  async svcInstall() {
    if (!fileExists("/run/systemd/system"))
      throw fail("phosphorus runs under systemd on Linux, and this machine has none");
    await run("systemctl", "daemon-reload");
    await quiet("systemctl", "enable", unit);
  },
  svcActive: () => unitActive(unit),
  svcSince: () => output("systemctl", "show", "-p", "ActiveEnterTimestampMonotonic", "--value", unit),
  async svcStart() {
    if (!(await run("systemctl", "start", unit))) throw fail("systemctl start failed");
  },
  // svcStop git handing off first, kept off through reboots
  async svcStop() {
    if (!(await run("systemctl", "disable", "--now", unit))) throw fail("systemctl disable --now failed");
  },
  async svcRestart(noBlock) {
    await quiet("systemctl", "enable", unit);
    const ok = noBlock
      ? await run("systemctl", "--no-block", "restart", unit)
      : await run("systemctl", "restart", unit);
    if (!ok) throw fail("systemctl restart failed");
  },
  svcRemove() {},
  tailscaleDirs: () => [],
  tailscaleCLI: () => (systemTailscale() ? "tailscale" : tool("tailscale")),
  // tailscaleInstalled the package's own tailscaled, nothing for setup to fetch
  tailscaleInstalled: () => true,
  async tailscaleInstall() {},
  async tailscaleKeepUp() {},
  async tailscaleReady() {
    if (!systemTailscale() && !fileExists(tool("tailscaled")))
      throw fail("no tailscaled here: reinstall the phosphorus package");
  },
  // tailscaleStart the bundled tailscaled, its CLI on PATH when the machine has none
  async tailscaleStart() {
    if (systemTailscale()) {
      if (await unitActive(tsUnit)) await quiet("systemctl", "disable", "--now", tsUnit);
      return;
    }
    mkdirSync(at("tailscale"), { recursive: true, mode: 0o700 });
    if (!(await run("systemctl", "enable", "--now", tsUnit))) throw fail("couldn't start tailscaled");
    if (!has("tailscale")) {
      try {
        symlinkSync(tool("tailscale"), "/usr/local/bin/tailscale");
      } catch {}
    }
    for (let i = 0; i < 60; i++) {
      if (await quiet(tool("tailscale"), "status", "--json")) return;
      await sleep(500);
    }
  },
  tailscaleUpFlags: () => ["--accept-dns=true"],
  missingDeps,
  aptInstall,
  deferRebuild,
  // gitEnv the git daemon's and elector's paths
  gitEnv: () => ({
    DATA_ROOT: at("git"),
    GIT_USER: gitUser,
    GIT_GROUP: gitUser,
    FORGEJO_BIN: tool("forgejo"),
    ELECTOR: binPath("phosphorus") + " elector",
    APP_INI_TMPL: gitd("app.ini.tmpl"),
    RSYNCD_CONF_TMPL: gitd("rsyncd.conf"),
    RSYNCD_CONF: runDir + "/rsyncd.conf",
    RSYNCD_PID: runDir + "/rsyncd.pid",
    LOCAL_FILE: runDir + "/git-local",
    DECISION_FILE: runDir + "/git-decision",
    LEASE_UNTIL_FILE: runDir + "/git-lease-until",
    FORGEJO_PID_FILE: runDir + "/git-forgejo-pid",
    PROMOTING_FILE: runDir + "/git-promoting",
  }),
  // ensureGitUser forgejo's account, a system user of its own
  async ensureGitUser() {
    if (await quiet("getent", "passwd", gitUser)) return;
    if (!(await run("useradd", "--system", "--user-group", "-d", at("git"), "-M", "-s", "/usr/sbin/nologin", gitUser)))
      throw fail(`couldn't add the ${gitUser} user`);
  },
  runtimeDir: () => runDir,
  // its own group, killed whole on the way out
  childDetached: true,
  // terminate TERM to the child alone, its own shutdown in order
  terminate,
  async killTree(p: Subprocess) {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      p.kill("SIGKILL");
    }
  },
  // logToFile none: systemd's journal has stdout
  logToFile() {},
  serve,
};
