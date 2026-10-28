// Windows: the phosphorus service (LocalSystem, startable by the account that
// set it up), OpenSSH Server and the ssh include through UAC, Tailscale's msi,
// run inside a job, and the update agent for a host with no one signed in
import type { Subprocess } from "bun";
import { dlopen, FFIType, JSCallback, ptr, type Pointer } from "bun:ffi";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Feed } from "@phosphorus/appfeed";
import { list } from "@phosphorus/procs";
import { which } from "@phosphorus/util";
import { at, binPath, capture, errText, fail, fileExists, home, lastLine, logTo, openLog, output, quiet, readTrim, run, say, selfArgv, sleep, sshdUp, sshInclude } from "./base.ts";
import type { OS, Reporter, Stop } from "./os.ts";
import { newStop } from "./os.ts";
import { installTailscale, tailscaleLogin } from "./tailnet.ts";
import { agentReport } from "./upgrade.ts";

const svcName = "phosphorus";

// the app's own feed, set by the build's --define as the tray's is; a dev build has none
declare const PHOSPHORUS_FEED_URL: string, PHOSPHORUS_FEED_PUBKEY: string;
const defined = (f: () => string) => {
  try {
    return f();
  } catch {
    return "";
  }
};
const feedURL = defined(() => PHOSPHORUS_FEED_URL), feedPubkey = defined(() => PHOSPHORUS_FEED_PUBKEY);

// how long the app gets to pick a request up first, it looking every 2s
const appPickup = 10_000;

const ps = (script: string) => output("powershell", "-NoProfile", "-NonInteractive", "-Command", script);
export const psq = (s: string) => "'" + s.replaceAll("'", "''") + "'";

// escapeArg as Go's syscall.EscapeArg: quoted when it has a space or tab,
// quotes and the backslashes before them escaped
export function escapeArg(s: string): string {
  if (s === "") return '""';
  let needsBackslash = false, hasSpace = false;
  for (const c of s) {
    if (c === '"' || c === "\\") needsBackslash = true;
    else if (c === " " || c === "\t") hasSpace = true;
  }
  if (!needsBackslash && !hasSpace) return s;
  if (!needsBackslash) return '"' + s + '"';
  let b = hasSpace ? '"' : "";
  let slashes = 0;
  for (const c of s) {
    if (c === "\\") slashes++;
    else if (c === '"') {
      b += "\\".repeat(slashes) + "\\";
      slashes = 0;
    } else slashes = 0;
    b += c;
  }
  if (hasSpace) b += "\\".repeat(slashes) + '"';
  return b;
}

// a NUL-terminated UTF-16 string for the ffi, kept alive by its caller
const wstr = (s: string) => Buffer.from(s + "\0", "utf16le");

const { u32, u64, ptr: P, bool } = FFIType;
const lazy = <T>(f: () => T) => {
  let v: T | undefined;
  return () => (v ??= f());
};
const kernel32 = lazy(
  () =>
    dlopen("kernel32.dll", {
      CreateFileW: { args: [P, u32, u32, u64, u32, u32, u64], returns: u64 },
      CloseHandle: { args: [u64], returns: bool },
      CreateJobObjectW: { args: [u64, u64], returns: u64 },
      SetInformationJobObject: { args: [u64, u32, P, u32], returns: bool },
      AssignProcessToJobObject: { args: [u64, u64], returns: bool },
      GetCurrentProcess: { args: [], returns: u64 },
      GetModuleHandleW: { args: [P], returns: u64 },
      GetProcAddress: { args: [u64, P], returns: u64 },
      CreateThread: { args: [u64, u64, u64, P, u32, u64], returns: u64 },
    }).symbols,
);
const advapi32 = lazy(
  () =>
    dlopen("advapi32.dll", {
      RegisterServiceCtrlHandlerExW: { args: [P, P, u64], returns: u64 },
      SetServiceStatus: { args: [u64, P], returns: bool },
    }).symbols,
);

// --- a detached process, PATH, the admin setup ------------------------------------------

// a process started outside this one's job and session via WMI, its pid; 0 when it couldn't
async function wmiStart(line: string): Promise<number> {
  const pid = Number(await ps("(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=" + psq(line) + "}).ProcessId"));
  return Number.isInteger(pid) ? pid : 0;
}

// spawnDetached outside the ssh session via WMI, Windows' sshd taking a dropped
// session's whole process tree with it
async function spawnDetached(args: string[], log: string): Promise<() => Promise<void>> {
  const q = [...selfArgv(), ...args].map((a) => `"${a}"`).join(" ");
  const pid = await wmiStart(`cmd /c set PHOSPHORUS_DETACHED=1&& ${q} > "${log}" 2>&1`);
  if (!pid) throw fail("couldn't start it detached");
  return () => quiet("powershell", "-NoProfile", "-NonInteractive", "-Command", `Wait-Process -Id ${pid}`).then(() => {});
}

// prepareOS phosphorus on PATH for new shells
async function prepareOS() {
  const bin = at("bin");
  const path = await ps("[Environment]::GetEnvironmentVariable('Path', 'User')");
  for (const p of path.split(";")) if (p.replace(/\\+$/, "").toLowerCase() === bin.toLowerCase()) return;
  say("putting phosphorus on PATH, new shells pick it up");
  await ps("[Environment]::SetEnvironmentVariable('Path', ((@([Environment]::GetEnvironmentVariable('Path', 'User'), " + psq(bin) + ") | Where-Object { $_ }) -join ';'), 'User')");
}

const sshConfig = () => join(process.env.ProgramData ?? "", "ssh", "ssh_config");
const readFile = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

async function needSetup(): Promise<string> {
  if (!(await sshdUp())) return "OpenSSH Server";
  if (!readFile(sshConfig()).includes(sshInclude())) return "ssh to hosts by name";
  if (!(await svcInstalled())) return "the phosphorus service";
  if (!tailscaleInstalled()) return "Tailscale";
  return "";
}

// an elevated run of this program with args, through UAC, waited on
async function runAs(args: string[]) {
  const [file, ...pre] = selfArgv();
  const list = [...pre, ...args, "--home", `"${home}"`].map(psq).join(",");
  await ps("Start-Process -Wait -Verb RunAs -FilePath " + psq(file!) + " -ArgumentList @(" + list + ")");
}

// elevateWindows setup through UAC, waited on
async function elevateWindows() {
  await runAs(["setup"]);
  const todo = await needSetup();
  if (todo) throw fail(`still needs ${todo}: run phos setup in an elevated shell`);
}

async function setupOS() {
  if (await sshdUp()) say("sshd already running, skipping");
  else {
    say("installing and starting OpenSSH Server...");
    await ps("if ((Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0').State -ne 'Installed') { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null }; Set-Service -Name sshd -StartupType Automatic; Start-Service sshd");
    if (!(await sshdUp())) throw fail("sshd didn't start");
  }
  // the Include first, counting only ahead of every Host block
  const b = readFile(sshConfig());
  if (!b.includes(sshInclude())) {
    say("letting ssh reach hosts by name...");
    mkdirSync(dirname(sshConfig()), { recursive: true });
    writeFileSync(sshConfig(), sshInclude() + "\r\n" + b, { mode: 0o644 });
  }
  if (!tailscaleInstalled()) await tailscaleInstall();
  await createService();
}

// --- the phosphorus service, LocalSystem, startable by the account that set it up -------------

const STOPPED = 1, STOP_PENDING = 3, RUNNING = 4;

// svcState sc's numeric state, 0 when there's no such service: query rights
// alone, what a non-admin may ask for
async function svcState(): Promise<number> {
  const m = /STATE\s*:\s*(\d+)/.exec(await output("sc", "query", svcName));
  return m ? Number(m[1]) : 0;
}
const svcInstalled = async () => (await svcState()) !== 0;
const svcActive = async () => (await svcState()) === RUNNING;

// createService installed once by the elevated setup, run with the home's
// binary; its DACL letting signed-in users start and stop it
async function createService() {
  const bin = escapeArg(binPath("phosphorus")) + " " + ["run", "--home", home].map(escapeArg).join(" ");
  if (await svcInstalled()) await quiet("sc", "config", svcName, "binPath=", bin, "start=", "auto");
  else {
    say("installing the phosphorus service...");
    if (!(await run("sc", "create", svcName, "binPath=", bin, "start=", "auto", "DisplayName=", "Phosphorus host"))) throw fail("couldn't install the service: sc create failed");
    await quiet("sc", "description", svcName, "phosphorus run: the frontend, the tunnel and the model as its own processes");
    await quiet("sc", "failure", svcName, "reset=", "0", "actions=", "restart/5000");
  }
  // SY and BA full, interactive and service users query, authenticated users start and stop
  await run("sc", "sdset", svcName, "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWRPWPLOCRRC;;;AU)");
}

// svcWait true once the service is in want, false past wait
async function svcWait(want: number, waitMs: number): Promise<boolean> {
  for (const end = Date.now() + waitMs; ; await sleep(1000)) {
    if ((await svcState()) === want) return true;
    if (Date.now() > end) return false;
  }
}

// svcStart on the binary now in place: one the recovery action already
// brought back (sc's 1056) stopped to STOPPED first, then started fresh
async function svcStart() {
  await quiet("sc", "config", svcName, "start=", "auto");
  const st = await svcState();
  if (st !== 0 && st !== STOPPED) {
    await quiet("sc", "stop", svcName);
    if (!(await svcWait(STOPPED, 150_000))) throw fail("the service never reached STOPPED to start again");
  }
  const ok = await run("sc", "start", svcName);
  if (await svcWait(RUNNING, 60_000)) return;
  throw fail(ok ? "the service never reached RUNNING" : "sc start failed");
}

// svcStop kept off through reboots
async function svcStop() {
  await quiet("sc", "config", svcName, "start=", "demand");
  await quiet("sc", "stop", svcName);
  await svcWait(STOPPED, 150_000);
}

// --- tailscale: the Tailscale app's own node ---------------------------------------------

const tailscaleDirs = () => [join(process.env.ProgramFiles ?? "", "Tailscale")];

// tailscaleCLI Program Files', else one on PATH
function tailscaleCLI(): string {
  const p = join(tailscaleDirs()[0]!, "tailscale.exe");
  if (!fileExists(p)) {
    const l = which("tailscale");
    if (l) return l;
  }
  return p;
}
const tailscaleInstalled = () => fileExists(tailscaleCLI());

// silent, unattended so it stays up signed out of Windows
const tailscaleInstall = () =>
  installTailscale("tailscale-setup-1.104.1-amd64.msi", "6da8bcdb0d45a214cae0e8a88c2987ad48dec134bf04dffb9c05f1354c02b0b4", (msi) => run("msiexec", "/i", msi, "/quiet", "/norestart", "TS_UNATTENDEDMODE=always"));

// --- the rebuild lock, uninstall -----------------------------------------------------------

const INVALID = 0xffffffffffffffffn;

// lockRebuild state/rebuild.lock held for the rebuild, a second one waiting: the
// file opened with no sharing, a second open failing while the first holds it
async function lockRebuild(): Promise<() => void> {
  const k = kernel32();
  const name = wstr(at("state", "rebuild.lock"));
  for (;;) {
    const h = k.CreateFileW(ptr(name), 0x40000000 /* GENERIC_WRITE */, 0, 0n, 4 /* OPEN_ALWAYS */, 0x80 /* FILE_ATTRIBUTE_NORMAL */, 0n) as bigint;
    if (BigInt(h) !== INVALID) return () => void k.CloseHandle(h);
    await sleep(500);
  }
}

// unpath the home's bin out of the user's PATH
async function unpath() {
  await ps("$b = " + psq(at("bin")) + "; [Environment]::SetEnvironmentVariable('Path', ((([Environment]::GetEnvironmentVariable('Path', 'User')) -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne $b }) -join ';'), 'User')");
}

// uninstallAdmin the service deleted, the ssh include dropped, the home's
// SYSTEM-written files removed
async function uninstallAdmin() {
  await svcStop();
  if (await svcInstalled()) await quiet("sc", "delete", svcName);
  const b = readFile(sshConfig());
  if (b.includes(sshInclude())) {
    const kept = b.split("\n").filter((l) => l.replace(/\r$/, "") !== sshInclude());
    writeFileSync(sshConfig(), kept.join("\n"), { mode: 0o644 });
  }
  rmSync(home, { recursive: true, force: true });
}

// --- run: its children in a job, the service's main, the update agent -----------------------

// killOnClose run in a job its children inherit, all of them gone with run
function killOnClose() {
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
function isService(): boolean {
  const all = list();
  const me = all.find((p) => p.pid === process.pid);
  const parent = me && all.find((p) => p.pid === me.ppid);
  return parent?.name.toLowerCase() === "services.exe";
}

// the SCM's picture of this service: SERVICE_STATUS, 28 bytes
let statusHandle = 0n;
const status = Buffer.alloc(28);
function setStatus(state: number, accepts: number, exitCode = 0, specific = 0) {
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
const keep: unknown[] = [];

// dispatch the service control dispatcher on a thread of its own, this one's
// event loop free: ServiceMain reports RUNNING and returns, the handler marks
// stop; both run on the SCM's threads and only touch flags
function dispatch(stop: Stop) {
  const k = kernel32(), adv = advapi32();
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
  const fn = k.GetProcAddress(k.GetModuleHandleW(ptr(wstr("advapi32.dll"))) as bigint, ptr(Buffer.from("StartServiceCtrlDispatcherW\0"))) as bigint;
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
async function serve(main: (stop: Stop) => Promise<number>): Promise<number> {
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
function updating(): boolean {
  try {
    const a = JSON.parse(readFileSync(at("state", "update-agent.json"), "utf8"));
    return a?.state === "running" && Date.now() - Number(a.at) < 20 * 60_000;
  } catch {
    return false;
  }
}

// watchUpdateRequests run's: a request the app left past appPickup handed on
// to a detached upgrade
async function watchUpdateRequests(stop: Stop) {
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
const appDir = () => readTrim(at("state", "app-dir")) || join(dirname(home), "AppData", "Local", "Phosphorus");

// homeOwner the user account the home belongs to, "" when it's none
const homeOwner = () =>
  ps(
    `$s = (Get-Acl -LiteralPath ${psq(home)}).GetOwner([System.Security.Principal.SecurityIdentifier]).Value; ` +
      `$a = Get-CimInstance Win32_Account -Filter "SID='$s'"; if ($a -and $a.SIDType -eq 1 -and $s -ne 'S-1-5-18') { $a.Name }`,
  );

// upgradeApp the app's update without it: the feed's newer setup downloaded,
// its signature checked and run silently into the app's folder, then the app's
// release installed into the home as the app would; this release re-applied
// when it's the newest
async function upgradeApp(report: Reporter) {
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
      let out = "", code = -1;
      try {
        const p = Bun.spawn([escapeArg(setup), "/S", "/AGENT", "/D=" + dir], { argv0: setup, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, windowsVerbatimArguments: true });
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
    if (!(await quiet("net", "session"))) throw fail("the phosphorus service isn't installed yet: phos start (it asks for admin once)");
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
      if (!(await wmiStart("powershell -NoProfile -NonInteractive -Command Restart-Service " + svcName + " -Force"))) throw fail("couldn't start the restart detached");
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
    if (!fileExists(tailscaleCLI())) throw fail("no Tailscale here: install Tailscale for Windows (tailscale.com/download), then phos start");
    // tailscaleLaunch its service, set to start by the installer
    await tailscaleLogin(async () => void (await quiet("net", "start", "Tailscale")), () => "start Tailscale from the Start menu");
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
