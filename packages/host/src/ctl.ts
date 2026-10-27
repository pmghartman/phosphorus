// stop, restart and update: the first two rerun detached and their log
// followed, the update handed to the host's agent and its verdict waited on
import { mkdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import * as envfile from "@phosphorus/envfile";
import { at, envPath, fail, home, print, println, sleep } from "./base.ts";
import { nativeRestart, nativeStop } from "./native.ts";
import { os } from "./os.ts";

// detached this command rerun in its own session and its log followed: a
// terminal inside phosphorus dropping mid-stop never leaves git stopped
async function detached(cmd: string): Promise<boolean> {
  if (process.env.PHOSPHORUS_DETACHED) return false;
  mkdirSync(at("state"), { recursive: true });
  const logf = at("state", cmd + ".log");
  let wait: Promise<void>;
  try {
    writeFileSync(logf, "");
    wait = (await os.spawnDetached([cmd, "--home", home], logf))();
  } catch {
    return false;
  }
  let seen = 0;
  const follow = () => {
    try {
      const b = readFileSync(logf);
      if (b.length > seen) print(b.subarray(seen).toString());
      seen = Math.max(seen, b.length);
    } catch {}
  };
  let done = false;
  void wait.then(() => void (done = true));
  while (!done) {
    await sleep(300);
    follow();
  }
  await sleep(300);
  follow();
  return true;
}

// stop git first (run stops it before the rest), so a master hands off;
// kept stopped through reboots
export async function stop() {
  if (await detached("stop")) return;
  await nativeStop();
}

export async function restart() {
  if (await detached("restart")) return;
  await nativeRestart();
}

// readPassword a line typed with no echo; undefined when stdin isn't a terminal
export async function readPassword(): Promise<string | undefined> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return undefined;
  stdin.setRawMode(true);
  const buf = Buffer.alloc(1);
  let s = "";
  try {
    for (;;) {
      const n = readSync(0, buf, 0, 1, null);
      if (n === 0) break;
      const c = buf[0]!;
      if (c === 3) process.exit(130);
      if (c === 10 || c === 13) break;
      if (c === 127 || c === 8) s = s.slice(0, -1);
      else s += String.fromCharCode(c);
    }
  } finally {
    stdin.setRawMode(false);
  }
  return s;
}

type Agent = { id?: string; state?: string; version?: string; error?: string; current?: boolean };

// update handed to the host's agent (the systemd path unit, the app), its
// verdict waited on; ADMIN_PASS the gate when set
export async function update() {
  const want = envfile.read(envPath()).ADMIN_PASS;
  if (want) {
    print("admin password: ");
    const got = await readPassword();
    println();
    if (got !== want) throw fail("wrong password");
  }
  const id = `cli-${Math.floor(Date.now() / 1000)}-${process.pid}`;
  mkdirSync(at("state"), { recursive: true });
  const tmp = at("state", "update-request.json.tmp");
  writeFileSync(tmp, JSON.stringify({ id, at: Date.now() }), { mode: 0o644 });
  renameSync(tmp, at("state", "update-request.json"));
  println("update requested, checking the release feed...");
  let last = "";
  for (let i = 1; i <= 1800; i++) {
    let raw = "";
    try {
      raw = readFileSync(at("state", "update-agent.json"), "utf8");
    } catch {}
    let a: Agent | undefined;
    try {
      a = JSON.parse(raw);
    } catch {}
    if (a && a.id === id && raw !== last) {
      last = raw;
      if (a.state === "failed") throw fail(`update failed: ${a.error ?? ""}`);
      if (a.state === "ok" && a.current) {
        println("already up to date");
        return;
      }
      if (a.state === "ok") {
        println(`updated to ${a.version ?? ""}`);
        return;
      }
      println("updating...");
    }
    if (i === 30 && last === "") println("nothing picked it up yet: is the update agent running (Linux: phosphorus-update.path, Windows: the phosphorus service, macOS: the Phosphorus app)?");
    await sleep(1000);
  }
  throw fail(`gave up waiting, see ${at("state", "update-agent.json")}`);
}
