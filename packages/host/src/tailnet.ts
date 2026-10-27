// Tailscale: its status, signing in to the mesh's tailnet, the pinned
// installer on macOS and Windows, and the mesh's keys from a peer
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as envfile from "@phosphorus/envfile";
import { FrontendPort, run as runCmd } from "@phosphorus/util";
import { at, envPath, eprint, fail, fileExists, say, sleep } from "./base.ts";
import { os } from "./os.ts";

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

// tailnetJoin Tailscale in its given state signed in to the mesh's tailnet: with
// TS_AUTHKEY when it isn't signed in, and on a first join when an existing
// install is signed in to a tailnet where no peer has the mesh's keys
export async function tailnetJoin(state: string) {
  const env = envfile.read(envPath());
  const joined = at("state", "tailnet-joined");
  const mark = () => {
    mkdirSync(at("state"), { recursive: true });
    writeFileSync(joined, new Date().toISOString().replace(/\.\d+Z$/, "Z") + "\n");
  };
  const known = !!env.BASE_DOMAIN || !!env.ADMIN_PASS || fileExists(joined);
  // turned off (vpn off, or by hand): back up as the same node, no re-auth
  if (state === "Stopped" && known) {
    if ((await runCmd([os.tailscaleCLI(), "up", ...os.tailscaleUpFlags()])).ok) {
      await os.tailscaleKeepUp();
      return;
    }
  }
  if (state === "Running") {
    if (known) {
      await os.tailscaleKeepUp();
      return;
    }
    try {
      const [, ip] = await peerKeys();
      say(`Tailscale already on the mesh's tailnet, ${ip} has the keys`);
      await os.tailscaleKeepUp();
      mark();
      return;
    } catch {}
    say("Tailscale is signed in to a tailnet without the mesh, switching to TS_AUTHKEY's");
  }
  const key = env.TS_AUTHKEY;
  if (!key) throw fail("Tailscale isn't on the mesh's tailnet and there's no TS_AUTHKEY in .env to sign in with");
  const a = ["up", "--reset", "--timeout=90s", "--authkey=" + key, ...os.tailscaleUpFlags()];
  if (state === "Running") a.push("--force-reauth");
  if (process.env.TS_HOSTNAME) a.push("--hostname=" + process.env.TS_HOSTNAME);
  say("signing Tailscale in with TS_AUTHKEY...");
  const r = await runCmd([os.tailscaleCLI(), ...a]);
  if (!r.ok) {
    eprint(r.output);
    let why = r.output.trim();
    const i = why.lastIndexOf("\n");
    if (i >= 0) why = why.slice(i + 1);
    if (!why) why = r.error ?? `exit status ${r.code}`;
    throw fail(`couldn't sign Tailscale in (${why}); TS_AUTHKEY in .env must be reusable and unexpired`);
  }
  mark();
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

// --- the mesh's keys from a peer -------------------------------------------------------

// meshKeyValues the missing keys from a peer, saved into .env, none missing none asked
export async function meshKeyValues(): Promise<Record<string, string>> {
  const want = envfile.Keys.filter((k) => k.mesh && !process.env[k.name]).map((k) => k.name);
  if (want.length === 0) return {};
  const [got, ip] = await peerKeys();
  const vals: Record<string, string> = {};
  for (const k of want) if (got[k]) vals[k] = got[k]!;
  try {
    envfile.set(envPath(), vals);
  } catch (e) {
    eprint(`can't save the keys into ${envPath()}: ${e instanceof Error ? e.message : e}\n`);
  }
  eprint(`copied ${keysOf(vals).join(", ")} from ${ip}\n`);
  return vals;
}

// peerKeys the mesh's keys from the first online peer serving them, and its address
export async function peerKeys(): Promise<[Record<string, string>, string]> {
  const status = parse(await tailscaleStatus());
  if (status === undefined) throw fail("can't list tailnet peers: no status");
  const peers = Object.values((status?.Peer ?? {}) as Record<string, { TailscaleIPs?: string[]; Online?: boolean }>);
  for (const p of peers) {
    if (!p.Online) continue;
    for (const ip of p.TailscaleIPs ?? []) {
      if (!ip.includes(".")) continue;
      try {
        const r = await fetch(`http://${ip}:${FrontendPort}/internal/keys`, { signal: AbortSignal.timeout(3000) });
        const got = await r.json();
        if (r.status !== 200 || !got || typeof got !== "object") continue;
        return [got as Record<string, string>, ip];
      } catch {}
    }
  }
  throw fail("no peer on the tailnet has the keys");
}

export const keysOf = (m: Record<string, string>) => envfile.Keys.filter((k) => m[k.name]).map((k) => k.name);
