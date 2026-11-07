// bring-up, the one-time admin setup, phos alone, status and the join key
import * as envfile from "@phosphorus/envfile";
import {
  at,
  ExitCode,
  envPath,
  fail,
  home,
  inDpkg,
  isWindows,
  keysMissing,
  println,
  say,
  selfArgv,
  setTag,
  spawnIO,
} from "./base.ts";
import { askKeys, desktopLinks, front, meshDomain } from "./front.ts";
import { rebuild, waitFrontend } from "./native.ts";
import { meshUp, readNetStatus } from "./net/status.ts";
import { os } from "./os.ts";

// start bring-up, safe to re-run: checks, the one-time admin setup, then
// the rebuild, which starts the service and waits on the frontend
export async function start() {
  if (keysMissing()) throw fail(`no MESH_KEY in ${envPath()}, run phosphorus to enter the join key`);
  envfile.lock(envPath());
  await os.prepareOS(await os.svcActive());
  const todo = await os.needSetup();
  if (todo) {
    say(`needs ${todo}`);
    try {
      await elevate();
    } catch (e) {
      say(e instanceof Error ? e.message : String(e));
    }
  }
  say("building and starting phosphorus...");
  try {
    await rebuild();
  } catch (e) {
    throw fail(`start failed: ${e instanceof Error ? e.message : e}`);
  }
  if (inDpkg() && !(await os.svcActive())) return;
  if (!(await waitFrontend(2 * 60_000))) throw fail(`the frontend never came up, check: ${os.logHint()}`);
  say("the frontend is up");
}

// setup the steps only an admin can take, once per machine: the ssh server,
// ssh <host> by name, phosphorus on PATH
export async function setup(opts: string[]) {
  for (const o of opts) {
    // the app asking whether its admin prompt is needed
    if (o === "--check") {
      const todo = await os.needSetup();
      if (todo) {
        println(todo);
        throw new ExitCode(1);
      }
      return;
    }
  }
  if (!(await os.isAdmin())) throw fail("setup needs root (sudo phosphorus setup) or an elevated shell");
  await os.setupOS();
  say("done");
}

// elevate setup run as admin: sudo on a terminal, the app's own prompt otherwise
async function elevate() {
  if (await os.isAdmin()) return os.setupOS();
  if (isWindows) return os.elevateWindows();
  if (!process.stdin.isTTY) throw fail("left for the Phosphorus app's admin prompt, or: sudo phosphorus setup");
  const code = await spawnIO(["sudo", ...selfArgv(), "setup", "--home", home], { stdin: "inherit" });
  if (code !== 0) throw fail(`exit status ${code}`);
}

// overview phos alone: on a new host the join key asked for and phosphorus
// started, then the front page with the link to the desktop, where setup goes on
export async function overview(version: string) {
  if (!(await os.svcActive()) && keysMissing()) {
    try {
      envfile.ensure(envPath());
    } catch (e) {
      throw fail(`can't write ${envPath()}: ${e instanceof Error ? e.message : e}`);
    }
    if (!(await askKeys(envPath()))) return;
    envfile.lock(envPath());
    setTag("start");
    await start();
    setTag("phosphorus");
    println("\n  open the desktop to finish: a new mesh asks for its first admin there, then its domain in settings");
  }
  await front(version);
}

// status this host's service, VPN and the desktop's address, as text or, with
// --json, for the app's tray
export async function status(args: string[]) {
  const running = await os.svcActive(),
    net = readNetStatus();
  if (args[0] === "--json") {
    println(JSON.stringify({ running, vpn: meshUp(net) }));
    return;
  }
  const tunnel = !net
    ? "down"
    : net.tun
      ? `up as ${net.ip} on ${net.tun}${net.hub ? ", the hub" : meshUp(net) ? "" : ", the hub not answering"}`
      : `waiting on ${net.waiting}`;
  println(`phosphorus ${running ? "running" : "stopped"}, the mesh tunnel ${tunnel}`);
  println((await desktopLinks()).join("  "));
  if (!running) println(keysMissing() ? "run phos to enter the join key" : "phos start brings it up");
}

// keySet which keys .env holds, never their values
export function keySet(have: Record<string, string>): Record<string, boolean> {
  const set: Record<string, boolean> = {};
  for (const k of envfile.Keys) set[k.name] = !!have[k.name];
  return set;
}

// keys the join key replaced in .env, never shown; the app's through --state and --stdin
export async function keys(opts: string[]) {
  try {
    envfile.ensure(envPath());
  } catch (e) {
    throw fail(`can't write ${envPath()}: ${e instanceof Error ? e.message : e}`);
  }
  for (const o of opts) {
    if (o === "--state") {
      // not secret, the domain: the app's window opened on it
      println(JSON.stringify({ keys: keySet(envfile.read(envPath())), domain: meshDomain() }));
      return;
    }
    if (o === "--stdin") {
      const b = (await Bun.stdin.bytes()).subarray(0, 1 << 16);
      try {
        envfile.set(envPath(), envfile.parse(new TextDecoder().decode(b)));
      } catch (e) {
        throw fail(`can't write ${envPath()}: ${e instanceof Error ? e.message : e}`);
      }
      envfile.lock(envPath());
      return;
    }
  }
  if (!(await askKeys(envPath()))) return;
  envfile.lock(envPath());
  if (!(await os.svcActive())) {
    say("saved, phos start to bring phosphorus up");
    return;
  }
  // .env read once at start: restarted on the new key
  say("saved, restarting phosphorus with it");
  await rebuild();
}
