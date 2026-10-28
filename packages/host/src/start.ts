// bring-up, the one-time admin setup, the cli on the service's env and the keys
import { keys as cliKeys } from "@phosphorus/cli";
import * as envfile from "@phosphorus/envfile";
import { at, envPath, ExitCode, fail, fileExists, home, inDpkg, isWindows, keysMissing, println, say, selfArgv, setTag, spawnIO } from "./base.ts";
import { attach, rebuild, waitFrontend } from "./native.ts";
import { os } from "./os.ts";

// start bring-up, safe to re-run: checks, the one-time admin setup, then
// the rebuild, which starts the service and waits on the frontend
export async function start() {
  if (keysMissing()) throw fail(`no TS_AUTHKEY in ${envPath()}, run phosphorus to enter the keys`);
  if (!fileExists(at("config", "services.export"))) throw fail(`config/services.export not found in ${home}`);
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

// tui the cli on the service's env, the keys asked for first on a new host
export async function tui(args: string[]) {
  if (!(await os.svcActive())) {
    if (!keysMissing()) throw fail("phosphorus isn't running, run: phos start");
    try {
      envfile.ensure(envPath());
    } catch (e) {
      throw fail(`can't write ${envPath()}: ${e instanceof Error ? e.message : e}`);
    }
    if ((await cliKeys(envPath())) !== 0) return;
    envfile.lock(envPath());
    setTag("start");
    await start();
    setTag("phosphorus");
  }
  await attach(args);
}

// keySet which keys .env holds, never their values
export function keySet(have: Record<string, string>): Record<string, boolean> {
  const set: Record<string, boolean> = {};
  for (const k of envfile.Keys) set[k.name] = !!have[k.name];
  return set;
}

// keys replaced in .env, never shown; the app's through --state and --stdin
export async function keys(opts: string[]) {
  try {
    envfile.ensure(envPath());
  } catch (e) {
    throw fail(`can't write ${envPath()}: ${e instanceof Error ? e.message : e}`);
  }
  for (const o of opts) {
    if (o === "--state") {
      // not secret, the domain: the app's window opened on it
      const have = envfile.read(envPath());
      println(JSON.stringify({ keys: keySet(have), domain: have.BASE_DOMAIN ?? "" }));
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
  if ((await cliKeys(envPath())) !== 0) return;
  envfile.lock(envPath());
  if (!(await os.svcActive())) {
    say("saved, phos start to bring phosphorus up");
    return;
  }
  // .env read once at start: restarted on the new keys
  say("saved, restarting phosphorus with them");
  await rebuild();
}
