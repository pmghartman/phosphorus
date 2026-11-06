// Tailscale, the mesh's transport: its status, signing in under phosphorus's
// name, and the pinned installer
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { run as runCmd } from "@phosphorus/util";
import { at, envPath, eprint, fail, fileExists, readTrim, say, sleep } from "./base.ts";
import { os } from "./os.ts";

// this host's name and key on the mesh, phosphorus's own
const meshFile = (f: string) => at("state", "data", "mesh", f);

// the name kept, blank before the first run
export const keptName = () => readTrim(meshFile("name"));

export function keepName(name: string) {
  if (!name || name === keptName()) return;
  mkdirSync(at("state", "data", "mesh"), { recursive: true, mode: 0o700 });
  writeFileSync(meshFile("name"), name + "\n");
}

// a DNS name's first label as a host name
export const labelOf = (dns: string) =>
  (dns.split(".")[0] ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// tailscaleStatus status --json, cut off at 10s; signed out exits nonzero, its JSON still printed
export async function tailscaleStatus(): Promise<string> {
  const r = await runCmd([os.tailscaleCLI(), "status", "--json"], { timeoutMs: 10_000 });
  return r.stdout;
}

const parse = (s: string): any => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

// vpnState Tailscale's backend state: Running, Stopped, NeedsLogin, or blank when it doesn't answer
export async function vpnState(): Promise<string> {
  const st = parse(await tailscaleStatus());
  return typeof st?.BackendState === "string" ? st.BackendState : "";
}

// the prefs a bare `up` must repeat: the control server and the name, blank when unread
export async function tailscalePrefs(): Promise<{ control: string; hostname: string }> {
  const r = await runCmd([os.tailscaleCLI(), "debug", "prefs"], { timeoutMs: 10_000 });
  const p = parse(r.stdout);
  const control = typeof p?.ControlURL === "string" ? p.ControlURL.replace(/\/+$/, "") : "";
  return { control, hostname: typeof p?.Hostname === "string" ? p.Hostname : "" };
}

// the flags that keep those prefs on an `up` that doesn't reset them
export const keepFlags = (p: { control: string; hostname: string }) => [
  ...(p.control ? ["--login-server=" + p.control] : []),
  ...(p.hostname ? ["--hostname=" + p.hostname] : []),
];

// tailnetJoin Tailscale in its given state signed in to the mesh: onto MESH_KEY's
// control server when signed out or on another one, turned back on when stopped
export async function tailnetJoin(state: string) {
  const env = envfile.read(envPath());
  const joined = at("state", "run", "tailnet-joined");
  const mark = () => {
    mkdirSync(at("state", "run"), { recursive: true });
    writeFileSync(joined, new Date().toISOString().replace(/\.\d+Z$/, "Z") + "\n");
  };
  const known = fileExists(joined);
  const mk = envfile.parseMeshKey(env.MESH_KEY);
  const prefs = await tailscalePrefs();
  // on the key's server, or a known install whose prefs didn't read
  const here = mk ? prefs.control === mk.url || (!prefs.control && known) : known;
  if (here && state === "Stopped") {
    if ((await runCmd([os.tailscaleCLI(), "up", ...keepFlags(prefs), ...os.tailscaleUpFlags()])).ok) {
      await os.tailscaleKeepUp();
      return;
    }
  }
  if (here && state === "Running") {
    await os.tailscaleKeepUp();
    if (!known) mark();
    return;
  }
  if (!mk) throw fail("Tailscale isn't on the mesh and there's no MESH_KEY in .env to join with");
  await joinControl(mk, state);
  mark();
}

// joinControl signed in with its join key under phosphorus's name, a new mesh key
// made for it so a host removed comes back
async function joinControl(mk: envfile.MeshKey, state: string) {
  const self = parse(await tailscaleStatus())?.Self;
  const name = keptName() || labelOf(process.env.TS_HOSTNAME || String(self?.DNSName ?? ""));
  const a = ["up", "--reset", "--timeout=90s", "--login-server=" + mk.url, "--authkey=" + mk.key];
  if (name) a.push("--hostname=" + name);
  a.push(...os.tailscaleUpFlags());
  if (state === "Running" || state === "Stopped") a.push("--force-reauth");
  say(`joining the mesh's control server ${mk.url}...`);
  const r = await runCmd([os.tailscaleCLI(), ...a]);
  if (!r.ok) {
    eprint(r.output);
    const why = r.output.trim().split("\n").pop() || r.error || `exit status ${r.code}`;
    throw fail(`couldn't join ${mk.url} (${why}); MESH_KEY in .env must be unexpired and its server up`);
  }
  rmSync(meshFile("key.json"), { force: true });
  await os.tailscaleKeepUp();
}

// tailscaleVersion the installer setup fetches when the machine has no Tailscale
export const tailscaleVersion = "1.104.1";

// installTailscale the pinned installer downloaded, checked and run; admin only
export async function installTailscale(name: string, sum: string, install: (file: string) => Promise<boolean>) {
  const f = join(tmpdir(), name);
  try {
    say(`installing Tailscale ${tailscaleVersion}...`);
    try {
      await download(f, "https://pkgs.tailscale.com/stable/" + name, sum);
    } catch (e) {
      throw fail(`couldn't download Tailscale: ${e instanceof Error ? e.message : e}`);
    }
    if (!(await install(f))) throw fail("the Tailscale installer failed");
  } finally {
    rmSync(f, { force: true });
  }
}

async function download(dst: string, url: string, sum: string) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (r.status !== 200) throw fail(`${url}: ${r.status} ${r.statusText}`);
  const data = new Uint8Array(await r.arrayBuffer());
  writeFileSync(dst, data);
  const got = createHash("sha256").update(data).digest("hex");
  if (got !== sum) throw fail(`checksum mismatch on ${url} (got ${got})`);
}

// a backend state that is settled: not blank, NoState or Starting
const settled = (st: string) => st !== "" && st !== "NoState" && st !== "Starting";

// tailscaleLogin Tailscale launched and waited on, an existing install's too, then
// on the mesh's tailnet
export async function tailscaleLogin(launch: () => Promise<void>, hint: () => string) {
  let st = await vpnState();
  if (!settled(st)) {
    say("waiting on Tailscale...");
    await launch();
    for (let i = 0; i < 120 && !settled(st); i++) {
      await sleep(1000);
      st = await vpnState();
    }
    if (st === "") throw fail(`Tailscale isn't running: ${hint()}, then Start`);
  }
  await tailnetJoin(st);
}
