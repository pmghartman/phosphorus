// phosphorus run, the service's main process: this host on the mesh (joined
// first when new), the mesh's tunnel in this process, then the frontend and the
// model daemon as labelled children, all down with a core one; the frontend started again when
// the mesh's domain changes

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { writeRoles } from "@phosphorus/procs";
import { RestartExit } from "@phosphorus/util";
import type { Subprocess } from "bun";
import {
  at,
  binPath,
  durText,
  ExitCode,
  envPath,
  errText,
  fail,
  fileExists,
  home,
  isModelHost,
  print,
  say,
  setTag,
  sleep,
  stamp,
  stdio,
} from "./base.ts";
import { nativeEnvFile, runEnv, withPath } from "./native.ts";
import { joinMesh } from "./net/join.ts";
import { meshKey, readJoined } from "./net/key.ts";
import { type Net, startNet } from "./net/main.ts";
import { keepName, meshName } from "./net/name.ts";
import { readView } from "./net/plan.ts";
import { os, type Stop } from "./os.ts";
import { ensureTools } from "./tools.ts";

// child one process phosphorus run keeps, labelled by PHOSPHORUS_ROLE
type Child = {
  role: string;
  core: boolean;
  graceMs: number;
  argv: string[];
  env: Record<string, string>;
  // third-party output, prefixed with the role
  prefix: boolean;
  proc?: Subprocess;
  done?: Promise<void>;
  exited: boolean;
  started: number;
};

const child = (
  c: Omit<Child, "started" | "core" | "prefix" | "exited"> & { core?: boolean; prefix?: boolean },
): Child => ({ core: false, prefix: false, started: 0, exited: false, ...c });

function start(c: Child) {
  const io = c.prefix ? "pipe" : stdio();
  const p = Bun.spawn(c.argv, {
    cwd: home,
    env: { ...c.env, PHOSPHORUS_ROLE: c.role },
    stdin: "ignore",
    stdout: io,
    stderr: io,
    windowsHide: true,
    detached: os.childDetached,
  });
  if (c.prefix) {
    void prefixed(c.role, p.stdout as ReadableStream<Uint8Array>);
    void prefixed(c.role, p.stderr as ReadableStream<Uint8Array>);
  }
  c.proc = p;
  c.started = Date.now();
  c.exited = false;
  c.done = p.exited.then(() => void (c.exited = true));
  noteRole(p.pid, c.role);
}

// stop TERM to the child alone, its own shutdown in order, then its group killed
async function stopChild(c: Child) {
  const p = c.proc;
  if (!p || !c.done || c.exited) return;
  if (os.terminate(p)) {
    const t = await Promise.race([c.done.then(() => true), sleep(c.graceMs).then(() => false)]);
    if (!t) say(`${c.role} ignored TERM for ${durText(c.graceMs)}, killing it`);
  }
  if (!c.exited) await os.killTree(p);
  await c.done;
}

const roles = new Map<number, string>();

// noteRole each child's pid for the status tab on any OS
function noteRole(pid: number, role: string) {
  for (const [p, r] of roles) if (r === role) roles.delete(p);
  roles.set(pid, role);
  writeRoles(roles);
}

// each line of a child's output, stamped and tagged with its role
async function prefixed(role: string, s: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder();
  let rest = "";
  try {
    for await (const chunk of s) {
      rest += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = rest.indexOf("\n")) >= 0) {
        print(`${stamp()}[${role}] ${rest.slice(0, i).replace(/\r$/, "")}\n`);
        rest = rest.slice(i + 1);
      }
    }
  } catch {}
  if (rest) print(`${stamp()}[${role}] ${rest}\n`);
}

// onMesh this host on the mesh under its name: its own record in the store with
// its key, or a join just answered; a new or removed host joins with MESH_KEY
async function onMesh(name: string): Promise<string> {
  const pub = meshKey().pub;
  const me = readView(process.env.PHOSPHORUS_SYS_DIR || at("sys"), name).hosts.get(name);
  const joined = readJoined();
  const removed = me?.removed === true && me.key === pub;
  if (me && !me.removed && me.key === pub) return name;
  if (!removed && joined?.name === name && (!me || me.key === pub)) return name;
  const mk = envfile.parseMeshKey(envfile.read(envPath()).MESH_KEY);
  if (!mk)
    throw fail("this host isn't on the mesh: make a join key in settings, network on a mesh host, then phos keys");
  if (removed && joined?.token === mk.token.split(".")[0])
    throw fail(`${name} was removed from the mesh: make a new join key in settings, network, then phos keys`);
  say(`joining the mesh at ${mk.url} as ${name}...`);
  const j = await joinMesh(mk, name, process.platform);
  say(`joined as ${j.name} at ${j.ip}`);
  return j.name;
}

// meshDomain the mesh's domain as the store on disk has it, the frontend's
// BASE_DOMAIN; "" before the desktop sets one or when this host hasn't synced it
export function meshDomain(sysDir = process.env.PHOSPHORUS_SYS_DIR || at("sys")): string {
  try {
    const f = JSON.parse(readFileSync(join(sysDir, "etc", "mesh", "domain.json"), "utf8"));
    const name = f?.gone ? "" : f?.data?.name;
    return typeof name === "string" && /^[a-z0-9.-]+$/.test(name) ? name : "";
  } catch {
    return "";
  }
}

async function waitHealthz() {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch("http://127.0.0.1:80/healthz", { signal: AbortSignal.timeout(1000) });
      return;
    } catch {}
    await sleep(100);
  }
}

export const runHost = () => os.serve(runMain);

// each child's end, taken one at a time by the main loop
type Exits = { push(c: Child): void; next(): Promise<Child> };
function exits(): Exits {
  const q: Child[] = [];
  let wake: (() => void) | undefined;
  return {
    push(c) {
      q.push(c);
      wake?.();
    },
    async next() {
      while (q.length === 0) await new Promise<void>((r) => (wake = r));
      return q.shift()!;
    },
  };
}

export async function runMain(stop: Stop): Promise<number> {
  setTag("run");
  mkdirSync(os.runtimeDir(), { recursive: true });
  os.logToFile();
  noteRole(process.pid, "run");
  for (const [k, v] of Object.entries(runEnv())) process.env[k] = v;
  if (!fileExists(nativeEnvFile())) throw fail(`no ${nativeEnvFile()}, run: phos start`);
  // the pinned tools fetched again when state/cache/ was cleared
  try {
    await ensureTools();
  } catch (e) {
    say(errText(e));
  }
  const name = await onMesh(meshName());
  keepName(name);
  say(`on the mesh as ${name}`);
  process.env.SELF_HOST = name;
  process.env.HOST_SSH_PORT = "22";
  // the mesh's domain from the store, the frontend's BASE_DOMAIN; the mesh alone without one
  const withDomain = () => {
    const domain = meshDomain();
    process.env.BASE_DOMAIN = domain;
    writeFileSync(at("state", "run", "base-domain"), domain + "\n", { mode: 0o644 });
    say(domain ? `serving ${domain}` : "no domain yet, served on the mesh only");
    return withPath(
      Object.fromEntries(Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined)),
    );
  };
  const env = withDomain();
  const bin = binPath("phosphorus");

  // the tunnel up before the frontend, the mesh's links riding it
  let net: Net | undefined;
  try {
    net = await startNet();
  } catch (e) {
    say(`couldn't start the mesh's tunnel: ${errText(e)}`);
  }
  const frontend = child({ role: "frontend", core: true, graceMs: 15_000, argv: [bin, "serve"], env });
  const kids = [frontend];
  const extra: Child[] = [];
  if (isModelHost()) extra.push(child({ role: "model", graceMs: 30_000, argv: [bin, "model"], env }));

  try {
    start(frontend);
  } catch (e) {
    await net?.stop();
    throw fail(`couldn't start the frontend: ${errText(e)}`);
  }
  await waitHealthz();
  for (const c of extra) {
    try {
      start(c);
    } catch (e) {
      say(`couldn't start ${c.role}: ${errText(e)}`);
    }
  }
  const all = [...kids, ...extra];
  say(`all up: ${all.map((c) => c.role).join(" ")}`);
  os.watchUpdateRequests(stop);

  const ex = exits();
  const watch = (c: Child) => void c.done?.then(() => ex.push(c));
  for (const c of all) watch(c);
  // the model first, then the frontend so its services hand off while the mesh
  // can still see it, the tunnel last
  const shutdown = async () => {
    await Promise.all(extra.map(stopChild));
    await stopChild(frontend);
    await net?.stop();
  };
  const backoff = new Map<string, number>();
  for (;;) {
    const c = await Promise.race([stop.p.then(() => undefined), ex.next()]);
    if (!c) {
      say("shutting down");
      await shutdown();
      return 0;
    }
    // the frontend asking for the mesh's new domain: started again with it, alone
    if (c === frontend && c.proc?.exitCode === RestartExit) {
      frontend.env = withDomain();
      try {
        start(frontend);
        watch(frontend);
        continue;
      } catch (e) {
        say(`couldn't restart the frontend: ${errText(e)}`);
      }
    }
    if (c.core) {
      say(`${c.role} exited, stopping the rest`);
      await shutdown();
      throw new ExitCode(1);
    }
    let d = backoff.get(c.role) ?? 0;
    // a long run forgiven, a crash loop slowed
    if (d === 0 || Date.now() - c.started > 5 * 60_000) d = 5000;
    say(`${c.role} exited, restarting it in ${durText(d)}`);
    backoff.set(c.role, Math.min(d * 2, 60_000));
    void sleep(d).then(() => {
      try {
        start(c);
      } catch (e) {
        say(`couldn't restart ${c.role}: ${errText(e)}`);
      }
      // a failed restart's old end seen again: tried once more, slower
      watch(c);
    });
  }
}
