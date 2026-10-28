// phosphorus run, the service's main process: tailscale checked, the
// frontend, the tunnel, the model and git daemons as labelled children,
// all down with a core one
import type { Subprocess } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import * as envfile from "@phosphorus/envfile";
import { writeRoles } from "@phosphorus/procs";
import { env as envOf, TunnelMetrics } from "@phosphorus/util";
import { at, binPath, durText, errText, ExitCode, fail, fileExists, gitd, home, isGitHost, isModelHost, print, say, setTag, sleep, stamp, stdio } from "./base.ts";
import { nativeEnvFile, runEnv, tool, withPath } from "./native.ts";
import { os, type Stop } from "./os.ts";
import { meshKeyValues, tailnetJoin, tailscaleStatus } from "./tailnet.ts";

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

const child = (c: Omit<Child, "started" | "core" | "prefix" | "exited"> & { core?: boolean; prefix?: boolean }): Child => ({ core: false, prefix: false, started: 0, exited: false, ...c });

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

// noteRole each child's pid for phos ps and the status tab on any OS
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

// tailnetSelf this node's DNS name, on the mesh's tailnet first
async function tailnetSelf(): Promise<string> {
  type Status = { BackendState?: string; Self?: { DNSName?: string } };
  const read = async (): Promise<Status | undefined> => {
    const out = await tailscaleStatus();
    try {
      return out ? JSON.parse(out) : undefined;
    } catch {
      return undefined;
    }
  };
  let st: Status | undefined;
  for (let i = 0; i < 60; i++) {
    st = await read();
    const s = st?.BackendState ?? "";
    if (s && s !== "NoState" && s !== "Starting") break;
    await sleep(500);
  }
  if (!st?.BackendState) throw fail("tailscale isn't answering");
  await tailnetJoin(st.BackendState);
  st = await read();
  if (!st) throw fail("tailscale isn't answering");
  return (st.Self?.DNSName ?? "").replace(/\.$/, "");
}

// fillMeshKeys a joining host's missing keys from a peer, waited on only
// when this host can't run without them
async function fillMeshKeys() {
  let need = true, missing = false;
  for (const k of envfile.Keys) {
    missing ||= k.mesh && !process.env[k.name];
    need &&= !k.mesh || !process.env[k.name];
  }
  if (!missing) return;
  const tries = need ? 30 : 1;
  for (let i = 0; i < tries; i++) {
    try {
      const vals = await meshKeyValues();
      for (const [k, v] of Object.entries(vals)) process.env[k] = v;
      return;
    } catch {}
    await sleep(2000);
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
  const dns = await tailnetSelf();
  say(`on the tailnet as ${dns}`);
  await fillMeshKeys();
  // no domain: the tailnet alone, http://<host>/
  if (!process.env.BASE_DOMAIN) say("no BASE_DOMAIN, served on the tailnet only");
  writeFileSync(at("state", "base-domain"), (process.env.BASE_DOMAIN ?? "") + "\n", { mode: 0o644 });
  const first = dns.split(".")[0] ?? "";
  process.env.SELF_HOST = first.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  process.env.HOST_SSH_PORT = "22";
  const env = withPath(Object.fromEntries(Object.entries(process.env).filter((kv): kv is [string, string] => kv[1] !== undefined)));
  const bin = binPath("phosphorus");

  const frontend = child({ role: "frontend", core: true, graceMs: 15_000, argv: [bin, "serve"], env });
  const tunnel = child({
    role: "cloudflared", core: true, graceMs: 10_000, prefix: true, env,
    argv: [tool("cloudflared"), "tunnel", "--no-autoupdate", "--loglevel", "warn", "--protocol", envOf("TUNNEL_PROTOCOL", "http2"), "--metrics", TunnelMetrics, "run"],
  });
  const kids = [frontend];
  const extra: Child[] = [];
  if (isModelHost()) extra.push(child({ role: "model", graceMs: 30_000, argv: [bin, "model"], env }));
  // forgejo's ROOT_URL at git.<domain>, no git without one
  if (isGitHost() && !process.env.BASE_DOMAIN) say("git: no BASE_DOMAIN, not started");
  else if (isGitHost()) extra.push(child({ role: "git", graceMs: 60_000, env, argv: ["/bin/bash", gitd("git-daemon.sh")] }));

  try {
    start(frontend);
  } catch (e) {
    throw fail(`couldn't start the frontend: ${errText(e)}`);
  }
  // the ingress answering before the tunnel hands it anything
  await waitHealthz();
  if (!process.env.TUNNEL_TOKEN) say("tunnel: no TUNNEL_TOKEN, tailnet only");
  else {
    say("tunnel: joining the Cloudflare tunnel as a replica");
    try {
      start(tunnel);
    } catch (e) {
      await stopChild(frontend);
      throw fail(`couldn't start cloudflared: ${errText(e)}`);
    }
    kids.push(tunnel);
  }
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
  // git before the model, both before the tunnel and frontend, so a
  // master hands off while the mesh can still see it
  const shutdown = async () => {
    for (let i = all.length - 1; i >= 0; i--) await stopChild(all[i]!);
  };
  const backoff = new Map<string, number>();
  for (;;) {
    const c = await Promise.race([stop.p.then(() => undefined), ex.next()]);
    if (!c) {
      say("shutting down");
      await shutdown();
      return 0;
    }
    if (c.core) {
      say(`${c.role} exited, stopping the rest so this host leaves tunnel rotation`);
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
