// a detached process, PATH, the admin setup
import { dlopen, FFIType } from "bun:ffi";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { at, fail, home, output, quiet, say, selfArgv, sshdUp, sshInclude } from "../base.ts";
import { createService, svcInstalled, tailscaleInstall, tailscaleInstalled } from "./service.ts";

export const svcName = "phosphorus";

// the app's own feed, set by the build's --define as the tray's is; a dev build has none
export declare const PHOSPHORUS_FEED_URL: string, PHOSPHORUS_FEED_PUBKEY: string;
export const defined = (f: () => string) => {
  try {
    return f();
  } catch {
    return "";
  }
};
export const feedURL = defined(() => PHOSPHORUS_FEED_URL),
  feedPubkey = defined(() => PHOSPHORUS_FEED_PUBKEY);

// how long the app gets to pick a request up first, it looking every 2s
export const appPickup = 10_000;

export const ps = (script: string) => output("powershell", "-NoProfile", "-NonInteractive", "-Command", script);
export const psq = (s: string) => "'" + s.replaceAll("'", "''") + "'";

// escapeArg as Go's syscall.EscapeArg: quoted when it has a space or tab,
// quotes and the backslashes before them escaped
export function escapeArg(s: string): string {
  if (s === "") return '""';
  let needsBackslash = false,
    hasSpace = false;
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
export const wstr = (s: string) => Buffer.from(s + "\0", "utf16le");

export const { u32, u64, ptr: P, bool } = FFIType;
export const lazy = <T>(f: () => T) => {
  let v: T | undefined;
  return () => (v ??= f());
};
export const kernel32 = lazy(
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
export const advapi32 = lazy(
  () =>
    dlopen("advapi32.dll", {
      RegisterServiceCtrlHandlerExW: { args: [P, P, u64], returns: u64 },
      SetServiceStatus: { args: [u64, P], returns: bool },
    }).symbols,
);

// a process started outside this one's job and session via WMI, its pid; 0 when it couldn't
export async function wmiStart(line: string): Promise<number> {
  const pid = Number(
    await ps(
      "(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=" +
        psq(line) +
        "}).ProcessId",
    ),
  );
  return Number.isInteger(pid) ? pid : 0;
}

// spawnDetached outside the ssh session via WMI, Windows' sshd taking a dropped
// session's whole process tree with it
export async function spawnDetached(args: string[], log: string): Promise<() => Promise<void>> {
  const q = [...selfArgv(), ...args].map((a) => `"${a}"`).join(" ");
  const pid = await wmiStart(`cmd /c set PHOSPHORUS_DETACHED=1&& ${q} > "${log}" 2>&1`);
  if (!pid) throw fail("couldn't start it detached");
  return () =>
    quiet("powershell", "-NoProfile", "-NonInteractive", "-Command", `Wait-Process -Id ${pid}`).then(() => {});
}

// prepareOS phosphorus on PATH for new shells
export async function prepareOS() {
  const bin = at("bin");
  const path = await ps("[Environment]::GetEnvironmentVariable('Path', 'User')");
  for (const p of path.split(";")) if (p.replace(/\\+$/, "").toLowerCase() === bin.toLowerCase()) return;
  say("putting phosphorus on PATH, new shells pick it up");
  await ps(
    "[Environment]::SetEnvironmentVariable('Path', ((@([Environment]::GetEnvironmentVariable('Path', 'User'), " +
      psq(bin) +
      ") | Where-Object { $_ }) -join ';'), 'User')",
  );
}

export const sshConfig = () => join(process.env.ProgramData ?? "", "ssh", "ssh_config");
export const readFile = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

export async function needSetup(): Promise<string> {
  if (!(await sshdUp())) return "OpenSSH Server";
  if (!readFile(sshConfig()).includes(sshInclude())) return "ssh to hosts by name";
  if (!(await svcInstalled())) return "the phosphorus service";
  if (!tailscaleInstalled()) return "Tailscale";
  return "";
}

// an elevated run of this program with args, through UAC, waited on
export async function runAs(args: string[]) {
  const [file, ...pre] = selfArgv();
  const list = [...pre, ...args, "--home", `"${home}"`].map(psq).join(",");
  await ps("Start-Process -Wait -Verb RunAs -FilePath " + psq(file!) + " -ArgumentList @(" + list + ")");
}

// elevateWindows setup through UAC, waited on
export async function elevateWindows() {
  await runAs(["setup"]);
  const todo = await needSetup();
  if (todo) throw fail(`still needs ${todo}: run phos setup in an elevated shell`);
}

export async function setupOS() {
  if (await sshdUp()) say("sshd already running, skipping");
  else {
    say("installing and starting OpenSSH Server...");
    await ps(
      "if ((Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0').State -ne 'Installed') { Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null }; Set-Service -Name sshd -StartupType Automatic; Start-Service sshd",
    );
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
