// what differs by OS: the service manager, Tailscale's install, the admin
// setup, run's children and the update agent; each platform's in its own file
import type { Subprocess } from "bun";
import { darwin } from "./darwin.ts";
import { linux } from "./linux.ts";
import { windows } from "./windows.ts";

// an update's word in state/update-agent.json, what the frontend and `phos update` wait on
export type Reporter = (state: string, current: boolean, version: string, why: string) => void;

// a stop signal: p settles once asked, on true from then on
export type Stop = { p: Promise<void>; on: boolean; fire(): void };

export function newStop(): Stop {
  let fire = () => {};
  const s: Stop = { on: false, fire: () => fire(), p: Promise.resolve() };
  s.p = new Promise<void>((r) => {
    fire = () => {
      s.on = true;
      r();
    };
  });
  return s;
}

export type OS = {
  sshdName: string;
  enableSSHD(): Promise<void>;
  // this command again as root, its exit code; Windows raises admin steps one by one
  asRoot(args: string[]): Promise<number>;
  isAdmin(): Promise<boolean>;
  // args rerun in its own session, its output to log; what's returned waits on its end
  spawnDetached(args: string[], log: string): Promise<() => Promise<void>>;
  prepareOS(up: boolean): Promise<void>;
  needSetup(): Promise<string>;
  elevateWindows(): Promise<void>;
  setupOS(): Promise<void>;
  // state/rebuild.lock held for the rebuild, a second one waiting; the unlock
  lockRebuild(): Promise<() => void>;
  unpath(): Promise<void>;
  uninstallAdmin(): Promise<void>;
  elevateUninstall(): Promise<void>;
  libexec(): string;
  logHint(): string;
  svcInstall(): Promise<void>;
  svcActive(): Promise<boolean>;
  svcSince(): Promise<string>;
  svcStart(): Promise<void>;
  svcStop(): Promise<void>;
  svcRestart(noBlock: boolean): Promise<void>;
  svcRemove(): void;
  tailscaleDirs(): string[];
  tailscaleCLI(): string;
  tailscaleInstalled(): boolean;
  tailscaleInstall(): Promise<void>;
  tailscaleKeepUp(): Promise<void>;
  tailscaleReady(): Promise<void>;
  tailscaleStart(): Promise<void>;
  tailscaleUpFlags(): string[];
  missingDeps(): Promise<string[]>;
  aptInstall(pkgs: string[]): Promise<void>;
  deferRebuild(): Promise<void>;
  gitEnv(): Record<string, string>;
  ensureGitUser(): Promise<void>;
  runtimeDir(): string;
  // run's children in their own group (Linux), run's own (macOS), run's job (Windows)
  childDetached: boolean;
  // TERM to the child alone, false where the OS has none
  terminate(p: Subprocess): boolean;
  killTree(p: Subprocess): Promise<void>;
  logToFile(): void;
  serve(main: (stop: Stop) => Promise<number>): Promise<number>;
  watchUpdateRequests(stop: Stop): void;
  upgradeApp(report: Reporter): Promise<void>;
};

export const os: OS = process.platform === "win32" ? windows : process.platform === "darwin" ? darwin : linux;
