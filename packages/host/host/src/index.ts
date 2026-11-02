// the machine's side, run by the installers and phos: install, bring-up,
// rebuild, start and stop, keys, the update agent and game play/stop
import {
  at,
  ExitCode,
  eprint,
  fail,
  home,
  homeDir,
  isLinux,
  print,
  println,
  readTrim,
  setHome,
  setTag,
  tag,
} from "./base.ts";
import { restart, stop, update } from "./ctl.ts";
import { desktopLinks } from "./front.ts";
import { gameControl, gameControlSetup } from "./game.ts";
import { install } from "./install.ts";
import { rebuild } from "./native.ts";
import { os } from "./os.ts";
import { runHost } from "./run.ts";
import { keys, overview, setup, start, status } from "./start.ts";
import { uninstall } from "./uninstall.ts";
import { upgrade } from "./upgrade.ts";

// commands the ones main takes, everything else run's children's roles
export const commands = new Set([
  "",
  "start",
  "stop",
  "restart",
  "update",
  "keys",
  "install",
  "setup",
  "rebuild",
  "upgrade",
  "game-control",
  "game-control-setup",
  "run",
  "uninstall",
  "status",
  "version",
  "help",
  "-h",
  "--help",
]);

export const usageText = `usage: phos            this host's state and the link to the desktop; on a new host, the keys first
       phos keys       replace the keys in .env
       phos start      start phosphorus on this host
       phos stop       stop it
       phos restart    restart it
       phos status     whether phosphorus and Tailscale are up, and the address
       phos update     update this host (the desktop updates every host)
       phos uninstall  remove phosphorus and its data from this host
       phos version    the installed release
       phos help       this text
`;

export type Flags = { update: boolean; payload: string; home: string; rest: string[] };

// parse --update, --home and --payload out of args, the rest kept in order
export function parse(args: string[]): Flags {
  const f: Flags = { update: false, payload: "", home: "", rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--update") f.update = true;
    else if (a === "--home" && i + 1 < args.length) f.home = args[++i]!;
    else if (a === "--payload" && i + 1 < args.length) f.payload = args[++i]!;
    else f.rest.push(a);
  }
  return f;
}

// the release's version: the home's VERSION file, else the build's, else dev
declare const PHOSPHORUS_APP_VERSION: string;
export function version(): string {
  if (!home) setHome(homeDir());
  const v = readTrim(at("VERSION"));
  if (v) return v;
  try {
    return PHOSPHORUS_APP_VERSION || "dev";
  } catch {
    return "dev";
  }
}

// main one host command, its exit code
export async function main(cmd: string, args: string[]): Promise<number> {
  const f = parse(args);
  if (f.home) setHome(f.home);
  if (!home) setHome(homeDir());
  // Linux: root's /var/lib/phosphorus, its .env root's alone
  if (
    isLinux &&
    process.geteuid?.() !== 0 &&
    !["game-control", "game-control-setup", "help", "-h", "--help", "version"].includes(cmd)
  )
    return os.asRoot([cmd, ...args]);
  setTag(cmd);
  try {
    switch (cmd) {
      case "":
        setTag("phosphorus");
        await overview(version());
        break;
      case "start":
        await start();
        break;
      case "stop":
        await stop();
        break;
      case "restart":
        await restart();
        break;
      case "update":
        if (f.rest.length) throw fail("update takes no arguments: it updates this host");
        await update();
        break;
      case "keys":
        await keys(f.rest);
        break;
      case "install":
        await install(f.payload, f.update);
        break;
      case "setup":
        await setup(f.rest);
        break;
      case "rebuild":
        await rebuild();
        break;
      case "upgrade":
        await upgrade(f.rest[0] ?? "");
        break;
      case "game-control":
        await gameControl();
        break;
      case "game-control-setup":
        await gameControlSetup();
        break;
      case "run":
        return await runHost();
      case "uninstall":
        await uninstall(f.rest);
        break;
      case "status":
        await status(f.rest);
        break;
      case "version":
        println(version());
        break;
      default:
        print(usageText);
        println(`\nevery app and setting is on the desktop: ${(await desktopLinks()).join("  ")}`);
        return 0;
    }
  } catch (e) {
    if (e instanceof ExitCode) return e.code;
    eprint(`[${tag}] ERROR: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
  return 0;
}
