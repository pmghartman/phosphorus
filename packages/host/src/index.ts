// the machine's side, run by the installers and the cli: install, bring-up,
// rebuild, start and stop, keys, the update agent and game play/stop
import { eprint, ExitCode, home, homeDir, isLinux, print, readTrim, setHome, setTag, tag, at } from "./base.ts";
import { restart, stop, update } from "./ctl.ts";
import { gameControl, gameControlSetup } from "./game.ts";
import { install } from "./install.ts";
import { psHost, rebuild } from "./native.ts";
import { os } from "./os.ts";
import { runHost } from "./run.ts";
import { keys, setup, start, tui } from "./start.ts";
import { uninstall } from "./uninstall.ts";
import { upgrade } from "./upgrade.ts";
import { status, vpn } from "./vpn.ts";

// commands the ones main takes, everything else run's children's roles
export const commands = new Set([
  "", "start", "stop", "restart", "update", "keys", "install", "setup", "rebuild", "upgrade", "game-control", "game-control-setup",
  "run", "ps", "uninstall", "status", "vpn", "help", "-h", "--help",
]);

export const usageText = `usage: phos             the cli, the keys asked for on first start
       phos start       start host
       phos stop        stop host
       phos restart     restart host
       phos update      update host
       phos update all  update mesh
       phos keys        replace keys in .env
       phos ps          phosphorus's processes, by role
       phos status      whether phosphorus and Tailscale are up
       phos vpn on|off  Tailscale up, or phosphorus stopped and Tailscale down
       phos uninstall   remove phosphorus and its data from this host
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
  if (isLinux && process.geteuid?.() !== 0 && cmd !== "game-control" && cmd !== "game-control-setup" && cmd !== "help") return os.asRoot([cmd, ...args]);
  setTag(cmd);
  try {
    switch (cmd) {
      case "":
        setTag("phosphorus");
        await tui([]);
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
        if (f.rest[0] === "all") await tui(["update-all"]);
        else await update();
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
      case "vpn":
        await vpn(f.rest);
        break;
      case "ps":
        // the roles file under this home, not the default state dir
        process.env.STATE_DIR = at("state");
        psHost();
        break;
      default:
        print(usageText);
        return 0;
    }
  } catch (e) {
    if (e instanceof ExitCode) return e.code;
    eprint(`[${tag}] ERROR: ${e instanceof Error ? e.message : e}\n`);
    return 1;
  }
  return 0;
}
