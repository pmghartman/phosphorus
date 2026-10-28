// run: its children in a job, the service's main, the update agent

import { FFIType, JSCallback, type Pointer, ptr } from "bun:ffi";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Feed } from "@phosphorus/appfeed";
import { list } from "@phosphorus/procs";
import type { Subprocess } from "bun";
import {
  at,
  capture,
  errText,
  fail,
  fileExists,
  home,
  lastLine,
  logTo,
  openLog,
  output,
  quiet,
  readTrim,
  say,
  sleep,
} from "../base.ts";
import type { OS, Reporter, Stop } from "../os.ts";
import { newStop } from "../os.ts";
import { tailscaleLogin } from "../tailnet.ts";
import { agentReport } from "../upgrade.ts";
import {
  createService,
  lockRebuild,
  RUNNING,
  STOP_PENDING,
  STOPPED,
  svcActive,
  svcInstalled,
  svcStart,
  svcStop,
  tailscaleCLI,
  tailscaleDirs,
  tailscaleInstall,
  tailscaleInstalled,
  uninstallAdmin,
  unpath,
} from "./service.ts";
import {
  advapi32,
  appPickup,
  elevateWindows,
  escapeArg,
  feedPubkey,
  feedURL,
  kernel32,
  needSetup,
  P,
  prepareOS,
  ps,
  psq,
  runAs,
  setupOS,
  spawnDetached,
  svcName,
  u32,
  wmiStart,
  wstr,
} from "./setup.ts";

// killOnClose run in a job its children inherit, all of them gone with run
export function killOnClose() {
  const k = kernel32();
  const j = k.CreateJobObjectW(0n, 0n) as bigint;
  if (!j) return;
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, LimitFlags at 16: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  const info = Buffer.alloc(144);
  info.writeUInt32LE(0x2000, 16);
  k.SetInformationJobObject(j, 9 /* JobObjectExtendedLimitInformation */, ptr(info), info.length);
  k.AssignProcessToJobObject(j, k.GetCurrentProcess() as bigint);
}

// isService started by the service manager: services.exe the parent
export function isService(): boolean {
  const all = list();
  const me = all.find((p) => p.pid === process.pid);
  const parent = me && all.find((p) => p.pid === me.ppid);
  return parent?.name.toLowerCase() === "services.exe";
}

// the SCM's picture of this service: SERVICE_STATUS, 28 bytes
export let statusHandle = 0n;
export const status = Buffer.alloc(28);
export function setStatus(state: number, accepts: number, exitCode = 0, specific = 0) {
  status.writeUInt32LE(0x10 /* SERVICE_WIN32_OWN_PROCESS */, 0);
  status.writeUInt32LE(state, 4);
  status.writeUInt32LE(accepts, 8);
  status.writeUInt32LE(exitCode, 12);
  status.writeUInt32LE(specific, 16);
  status.writeUInt32LE(0, 20);
  status.writeUInt32LE(0, 24);
  if (statusHandle) advapi32().SetServiceStatus(statusHandle, ptr(status));
}

// kept alive for the dispatcher's life: the table, the name, the callbacks
export const keep: unknown[] = [];

// dispatch the service control dispatcher on a thread of its own, this one's
// event loop free: ServiceMain reports RUNNING and returns, the handler marks
// stop; both run on the SCM's threads and only touch flags
export function dispatch(stop: Stop) {
  const k = kernel32(),
    adv = advapi32();
  let stopAsked = false;
  const handler = new JSCallback(
    (control: number): number => {
      if (control === 4 /* INTERROGATE */) return 0;
      if (control === 1 /* STOP */ || control === 5 /* SHUTDOWN */) {
        setStatus(STOP_PENDING, 0);
        stopAsked = true;
        return 0;
      }
      return 120 /* ERROR_CALL_NOT_IMPLEMENTED */;
    },
    { args: [u32, u32, P, P], returns: u32, threadsafe: true },
  );
  const name = wstr(svcName);
  const serviceMain = new JSCallback(
    () => {
      statusHandle = adv.RegisterServiceCtrlHandlerExW(ptr(name), handler.ptr as Pointer, 0n) as bigint;
      setStatus(RUNNING, 1 | 4 /* ACCEPT_STOP | ACCEPT_SHUTDOWN */);
    },
    { args: [u32, P], returns: FFIType.void, threadsafe: true },
  );
  // SERVICE_TABLE_ENTRYW[2], the last one empty
  const table = Buffer.alloc(32);
  table.writeBigUInt64LE(BigInt(ptr(name)), 0);
  table.writeBigUInt64LE(BigInt(serviceMain.ptr as number), 8);
  keep.push(handler, serviceMain, name, table);
  const fn = k.GetProcAddress(
    k.GetModuleHandleW(ptr(wstr("advapi32.dll"))) as bigint,
    ptr(Buffer.from("StartServiceCtrlDispatcherW\0")),
  ) as bigint;
  k.CreateThread(0n, 0n, fn, ptr(table), 0, 0n);
  const t = setInterval(() => {
    if (stopAsked) {
      clearInterval(t);
      stop.fire();
    }
  }, 250);
  stop.p.then(() => clearInterval(t));
}

// serve under the service manager, or a console's Ctrl-C when run by hand
export async function serve(main: (stop: Stop) => Promise<number>): Promise<number> {
  const stop = newStop();
  if (!isService()) {
    process.once("SIGINT", () => stop.fire());
    return main(stop);
  }
  dispatch(stop);
  let code = 1;
  try {
    code = await main(stop);
  } finally {
    setStatus(STOPPED, 0, code ? 1066 /* ERROR_SERVICE_SPECIFIC_ERROR */ : 0, code);
  }
  return code;
}

// updating an update already under way here, the app's or this agent's,
// one stuck past the frontend's 20 minutes not counted
export function updating(): boolean {
  try {
    const a = JSON.parse(readFileSync(at("state", "update-agent.json"), "utf8"));
    return a?.state === "running" && Date.now() - Number(a.at) < 20 * 60_000;
  } catch {
    return false;
  }
}

// watchUpdateRequests run's: a request the app left past appPickup handed on
// to a detached upgrade
export async function watchUpdateRequests(stop: Stop) {
  const req = at("state", "update-request.json");
  while (!stop.on) {
    await Promise.race([sleep(2000), stop.p]);
    if (stop.on) return;
    let mtime: number;
    try {
      mtime = statSync(req).mtimeMs;
    } catch {
      continue;
    }
    if (Date.now() - mtime < appPickup || updating()) continue;
    let id = "";
    try {
      id = String(JSON.parse(readFileSync(req, "utf8"))?.id ?? "");
    } catch (e) {
      if ((e as any)?.code === "ENOENT") continue;
    }
    // consumed first, never handed on twice
    try {
      rmSync(req);
    } catch {
      continue;
    }
    say(`update ${id}: no app picked it up, updating as the service`);
    try {
      writeFileSync(at("state", "upgrade.log"), "");
      void (await spawnDetached(["upgrade", id, "--home", home], at("state", "upgrade.log")))();
    } catch (e) {
      say(`couldn't start the update: ${errText(e)}`);
      agentReport(id)("failed", false, "", "couldn't start the update: " + errText(e));
    }
  }
}

// appDir the app's folder: where it last said it runs from, else the per-user
// install's default in the home's profile
export const appDir = () => readTrim(at("state", "app-dir")) || join(dirname(home), "AppData", "Local", "Phosphorus");

// homeOwner the user account the home belongs to, "" when it's none
export const homeOwner = () =>
  ps(
    `$s = (Get-Acl -LiteralPath ${psq(home)}).GetOwner([System.Security.Principal.SecurityIdentifier]).Value; ` +
      `$a = Get-CimInstance Win32_Account -Filter "SID='$s'"; if ($a -and $a.SIDType -eq 1 -and $s -ne 'S-1-5-18') { $a.Name }`,
  );

// upgradeApp the app's update without it: the feed's newer setup downloaded,
// its signature checked and run silently into the app's folder, then the app's
// release installed into the home as the app would; this release re-applied
// when it's the newest
export async function upgradeApp(report: Reporter) {
  const dir = appDir();
  const host = join(dir, "phosphorus-host.exe");
  if (!fileExists(host)) {
    report("failed", false, "", "no Phosphorus app in " + dir + ": reinstall from the latest release");
    throw fail(`no Phosphorus app in ${dir}`);
  }
  const feed = new Feed(feedURL, feedPubkey);
  let rel;
  try {
    rel = await feed.check(readTrim(join(dir, "release", "VERSION")));
  } catch (e) {
    report("failed", false, "", "update feed: " + errText(e));
    throw fail(`update feed: ${errText(e)}`);
  }
  if (rel) {
    say(`downloading ${rel.version}`);
    report("running", false, rel.version, "");
    let setup: string;
    try {
      setup = await feed.fetch(rel);
    } catch (e) {
      report("failed", false, "", errText(e));
      throw e;
    }
    try {
      say(`installing the app ${rel.version} into ${dir}`);
      // NSIS's /D last and unquoted, spaces and all, the command line verbatim
      // with setup's own path quoted; /AGENT: no tray started and nothing
      // written to the service's own registry
      let out = "",
        code = -1;
      try {
        const p = Bun.spawn([escapeArg(setup), "/S", "/AGENT", "/D=" + dir], {
          argv0: setup,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          windowsHide: true,
          windowsVerbatimArguments: true,
        });
        const [o, e, c] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        out = o + e;
        code = c;
      } catch (e) {
        out = errText(e);
      }
      if (code !== 0) {
        report("failed", false, "", "the app's setup failed: " + `exit status ${code} ${out}`.trim());
        throw fail(`the app's setup failed: exit status ${code}`);
      }
    } finally {
      rmSync(dirname(setup), { recursive: true, force: true });
    }
  }
  // the .env lock granting the home's user, not this service's account
  const env = { ...process.env };
  const u = await homeOwner();
  if (u) env.USERNAME = u;
  const r = await capture([host, "install", "--update", "--payload", join(dir, "release"), "--home", home], true, env);
  if (r.code !== 0) {
    report("failed", false, "", lastLine(r.out, /ERROR/) || "install failed");
    throw fail("install failed");
  }
  report("ok", !rel && r.out.includes("already up to date"), readTrim(join(dir, "release", "VERSION")), "");
}

export const windows: OS = {
  sshdName: "OpenSSH Server",
  async enableSSHD() {},
  // asRoot never: Windows' admin steps raised one by one
  asRoot: async () => 0,
  isAdmin: () => quiet("net", "session"),
  spawnDetached,
  prepareOS,
  needSetup,
  elevateWindows,
  setupOS,
  lockRebuild,
  unpath,
  uninstallAdmin,
  // elevateUninstall the admin half through UAC, waited on
  elevateUninstall: () => runAs(["uninstall", "--admin"]),
  // libexec the app's bundled tools, synced into the home with the release
  libexec: () => at("tools"),
  logHint: () => at("state", "phosphorus.log"),
  async svcInstall() {
    if (await svcInstalled()) return;
    if (!(await quiet("net", "session")))
      throw fail("the phosphorus service isn't installed yet: phos start (it asks for admin once)");
    await createService();
  },
  svcActive,
  async svcSince() {
    for (const l of (await output("sc", "queryex", svcName)).split("\n")) {
      const i = l.indexOf(":");
      if (i >= 0 && l.slice(0, i).trim() === "PID") return l.slice(i + 1).trim();
    }
    return "";
  },
  svcStart,
  svcStop,
  async svcRestart(noBlock) {
    if (noBlock) {
      // started through WMI, outside run's job that the stop kills
      if (!(await wmiStart("powershell -NoProfile -NonInteractive -Command Restart-Service " + svcName + " -Force")))
        throw fail("couldn't start the restart detached");
      return;
    }
    await svcStop();
    await svcStart();
  },
  svcRemove() {},
  tailscaleDirs,
  tailscaleCLI,
  tailscaleInstalled,
  tailscaleInstall,
  // tailscaleKeepUp an existing install's node kept up signed out of Windows, for the service
  async tailscaleKeepUp() {
    await quiet(tailscaleCLI(), "set", "--unattended");
  },
  async tailscaleReady() {
    if (!fileExists(tailscaleCLI()))
      throw fail("no Tailscale here: install Tailscale for Windows (tailscale.com/download), then phos start");
    // tailscaleLaunch its service, set to start by the installer
    await tailscaleLogin(
      async () => void (await quiet("net", "start", "Tailscale")),
      () => "start Tailscale from the Start menu",
    );
  },
  async tailscaleStart() {},
  tailscaleUpFlags: () => ["--unattended"],
  missingDeps: async () => [],
  async aptInstall() {},
  async deferRebuild() {},
  gitEnv: () => ({}),
  async ensureGitUser() {},
  runtimeDir: () => at("state", "run"),
  // no console; the job run sits in kills it with run
  childDetached: false,
  // terminate none: Windows has no TERM for another process, killTree does it
  terminate: () => false,
  async killTree(p: Subprocess) {
    if (!(await quiet("taskkill", "/T", "/F", "/PID", String(p.pid)))) p.kill();
  },
  // logToFile state/phosphorus.log for run and its children, the last one kept
  // as .1 once past 20MB
  logToFile() {
    killOnClose();
    const fd = openLog();
    if (fd !== undefined) logTo(fd);
  },
  serve,
  watchUpdateRequests(stop) {
    void watchUpdateRequests(stop);
  },
  upgradeApp,
};
