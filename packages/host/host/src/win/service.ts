// the phosphorus service, LocalSystem, startable by the account that set it up
import { ptr } from "bun:ffi";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { which } from "@phosphorus/util";
import { at, binPath, fail, fileExists, home, output, quiet, run, say, sleep, sshInclude } from "../base.ts";
import { installTailscale } from "../tailnet.ts";
import { escapeArg, kernel32, ps, psq, readFile, sshConfig, svcName, wstr } from "./setup.ts";

export const STOPPED = 1,
  STOP_PENDING = 3,
  RUNNING = 4;

// svcState sc's numeric state, 0 when there's no such service: query rights
// alone, what a non-admin may ask for
export async function svcState(): Promise<number> {
  const m = /STATE\s*:\s*(\d+)/.exec(await output("sc", "query", svcName));
  return m ? Number(m[1]) : 0;
}
export const svcInstalled = async () => (await svcState()) !== 0;
export const svcActive = async () => (await svcState()) === RUNNING;

// createService installed once by the elevated setup, run with the home's
// binary; its DACL letting signed-in users start and stop it
export async function createService() {
  const bin = escapeArg(binPath("phosphorus")) + " " + ["run", "--home", home].map(escapeArg).join(" ");
  if (await svcInstalled()) await quiet("sc", "config", svcName, "binPath=", bin, "start=", "auto");
  else {
    say("installing the phosphorus service...");
    if (!(await run("sc", "create", svcName, "binPath=", bin, "start=", "auto", "DisplayName=", "Phosphorus host")))
      throw fail("couldn't install the service: sc create failed");
    await quiet(
      "sc",
      "description",
      svcName,
      "phosphorus run: the frontend, the tunnel and the model as its own processes",
    );
    await quiet("sc", "failure", svcName, "reset=", "0", "actions=", "restart/5000");
  }
  // SY and BA full, interactive and service users query, authenticated users start and stop
  await run(
    "sc",
    "sdset",
    svcName,
    "D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;CCLCSWRPWPLOCRRC;;;AU)",
  );
}

// svcWait true once the service is in want, false past wait
export async function svcWait(want: number, waitMs: number): Promise<boolean> {
  for (const end = Date.now() + waitMs; ; await sleep(1000)) {
    if ((await svcState()) === want) return true;
    if (Date.now() > end) return false;
  }
}

// svcStart on the binary now in place: one the recovery action already
// brought back (sc's 1056) stopped to STOPPED first, then started fresh
export async function svcStart() {
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
export async function svcStop() {
  await quiet("sc", "config", svcName, "start=", "demand");
  await quiet("sc", "stop", svcName);
  await svcWait(STOPPED, 150_000);
}

export const tailscaleDirs = () => [join(process.env.ProgramFiles ?? "", "Tailscale")];

// tailscaleCLI Program Files', else one on PATH
export function tailscaleCLI(): string {
  const p = join(tailscaleDirs()[0]!, "tailscale.exe");
  if (!fileExists(p)) {
    const l = which("tailscale");
    if (l) return l;
  }
  return p;
}
export const tailscaleInstalled = () => fileExists(tailscaleCLI());

// silent, unattended so it stays up signed out of Windows
export const tailscaleInstall = () =>
  installTailscale(
    "tailscale-setup-1.104.1-amd64.msi",
    "6da8bcdb0d45a214cae0e8a88c2987ad48dec134bf04dffb9c05f1354c02b0b4",
    (msi) => run("msiexec", "/i", msi, "/quiet", "/norestart", "TS_UNATTENDEDMODE=always"),
  );

export const INVALID = 0xffffffffffffffffn;

// lockRebuild state/rebuild.lock held for the rebuild, a second one waiting: the
// file opened with no sharing, a second open failing while the first holds it
export async function lockRebuild(): Promise<() => void> {
  const k = kernel32();
  const name = wstr(at("state", "rebuild.lock"));
  for (;;) {
    const h = k.CreateFileW(
      ptr(name),
      0x40000000 /* GENERIC_WRITE */,
      0,
      0n,
      4 /* OPEN_ALWAYS */,
      0x80 /* FILE_ATTRIBUTE_NORMAL */,
      0n,
    ) as bigint;
    if (BigInt(h) !== INVALID) return () => void k.CloseHandle(h);
    await sleep(500);
  }
}

// unpath the home's bin out of the user's PATH
export async function unpath() {
  await ps(
    "$b = " +
      psq(at("bin")) +
      "; [Environment]::SetEnvironmentVariable('Path', ((([Environment]::GetEnvironmentVariable('Path', 'User')) -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne $b }) -join ';'), 'User')",
  );
}

// uninstallAdmin the service deleted, the ssh include dropped, the home's
// SYSTEM-written files removed
export async function uninstallAdmin() {
  await svcStop();
  if (await svcInstalled()) await quiet("sc", "delete", svcName);
  const b = readFile(sshConfig());
  if (b.includes(sshInclude())) {
    const kept = b.split("\n").filter((l) => l.replace(/\r$/, "") !== sshInclude());
    writeFileSync(sshConfig(), kept.join("\n"), { mode: 0o644 });
  }
  rmSync(home, { recursive: true, force: true });
}
