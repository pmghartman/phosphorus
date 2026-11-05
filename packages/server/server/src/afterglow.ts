// afterglow kept up on this host apart from phosphorus's own releases: its latest release's
// manifest read from github.com/pmghartman/afterglow and checked against the release key,
// the archive for this platform downloaded, its sha256 checked, unpacked beside the copy the
// release seeded (<home>/afterglow-update/<version>) and taken up; every host's own copy
// reported with its info, the mesh's update started from one host
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  exeName,
  type Installed,
  pickAfterglow,
  protoOK,
  protoWhy,
  updatesDir,
  versionCmp,
} from "@phosphorus/afterglow";
import { auditRow } from "@phosphorus/mcp";
import { parsePublicKey } from "@phosphorus/minisign";
import { env, errText, logf as log, peerCall, RepoDir, SelfHost, tailnetIP } from "@phosphorus/util";
import { releaseKey } from "@phosphorus/webapps";
import { binSelf } from "./mcpops.ts";

const repo = env("AFTERGLOW_REPO", "pmghartman/afterglow");
const windows = process.platform === "win32";

export type Manifest = { version: string; proto: number; assets: Record<string, { name: string; sha256: string }> };
export type Status = {
  version?: string;
  proto?: number;
  from?: Installed["from"];
  state: "idle" | "updating" | "failed";
  error?: string;
  at?: number;
};

// this host's build: the manifest's key for its archive
export const platformKey = () =>
  `${windows ? "windows" : process.platform}-${process.arch === "arm64" ? "aarch64" : "x86_64"}`;

let cached: { at: number; m?: Manifest; error?: string } = { at: 0 };
const ttl = 600_000;
const retry = 30_000;

// the latest release's manifest, its signature checked by phosphorus's release key
export async function latest(fresh = false): Promise<Manifest> {
  const age = Date.now() - cached.at;
  if (!fresh && cached.m && age < ttl) return cached.m;
  if (!fresh && cached.error && age < retry) throw new Error(cached.error);
  try {
    const key = releaseKey();
    if (!key) throw new Error("this build has no release key to check afterglow's releases by");
    const base = `https://github.com/${repo}/releases/latest/download/afterglow.json`;
    const [body, sig] = await Promise.all([get(base), get(`${base}.minisig`)]);
    parsePublicKey(key).verify(body, new TextDecoder().decode(sig));
    const m = manifestOf(JSON.parse(new TextDecoder().decode(body)));
    cached = { at: Date.now(), m };
    return m;
  } catch (e) {
    cached = { at: Date.now(), error: `afterglow's latest release: ${errText(e)}` };
    throw new Error(cached.error);
  }
}

async function get(url: string, max = 1 << 20): Promise<Uint8Array> {
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${new URL(url).pathname.split("/").pop()}: HTTP ${r.status}`);
  const b = new Uint8Array(await r.arrayBuffer());
  if (b.length > max) throw new Error("too big");
  return b;
}

// a manifest as afterglow's release writes it, anything else refused
export function manifestOf(v: any): Manifest {
  const version = typeof v?.version === "string" ? v.version.replace(/^v/, "") : "";
  if (!/^\d+(\.\d+)+$/.test(version)) throw new Error("the manifest has no version");
  const proto = Number.isInteger(v.proto) && v.proto > 0 ? v.proto : 0;
  if (!proto) throw new Error("the manifest has no protocol");
  const assets: Manifest["assets"] = {};
  for (const [k, a] of Object.entries(v.assets ?? {})) {
    const x = a as any;
    if (typeof x?.name === "string" && /^[\w.-]+$/.test(x.name) && /^[0-9a-f]{64}$/i.test(String(x.sha256)))
      assets[k] = { name: x.name, sha256: String(x.sha256).toLowerCase() };
  }
  return { version, proto, assets };
}

// --- this host ---------------------------------------------------------------------

let state: Status = { state: "idle" };

// this host's afterglow as its info reports it: the copy in use and the last update's word
export function status(): Status {
  const i = pickAfterglow(RepoDir, windows);
  return { ...state, version: i?.version, proto: i?.proto, from: i?.from };
}

// the latest release installed here when it's newer and spoken; the update's own word in status
export async function updateSelf(by: string): Promise<void> {
  if (state.state === "updating") return;
  state = { state: "updating", at: Date.now() };
  try {
    const m = await latest(true);
    if (!protoOK(m.proto)) throw new Error(protoWhy(m.proto, m.version));
    const have = pickAfterglow(RepoDir, windows);
    if (have && versionCmp(have.version, m.version) >= 0) {
      // already here: Windows' service moved onto it again, should an earlier try have stopped short
      if (windows) await run([...binSelf(), "afterglow"], 180_000);
      state = { state: "idle", at: Date.now() };
      return;
    }
    const a = m.assets[platformKey()];
    if (!a) throw new Error(`afterglow ${m.version} has no build for ${platformKey()}`);
    await install(m, a);
    // Windows' service moved onto it; Linux runs the newest per stream
    if (windows) await run([...binSelf(), "afterglow"], 180_000);
    state = { state: "idle", at: Date.now() };
    audit(by, { version: m.version });
    log("[afterglow] updated to %s", m.version);
  } catch (e) {
    state = { state: "failed", error: errText(e).slice(0, 300), at: Date.now() };
    audit(by, {}, e);
    log("[afterglow] update failed: %s", errText(e));
  }
}

async function install(m: Manifest, a: { name: string; sha256: string }) {
  const root = updatesDir(RepoDir);
  const dir = join(root, m.version);
  const stage = join(root, `.${m.version}.new`);
  mkdirSync(root, { recursive: true });
  // walked into by the viewer's own login over ssh on Linux
  if (!windows) chmodSync(root, 0o755);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const archive = join(root, `.${a.name}`);
  try {
    const body = await get(`https://github.com/${repo}/releases/download/v${m.version}/${a.name}`, 512 << 20);
    if (createHash("sha256").update(body).digest("hex") !== a.sha256) throw new Error(`${a.name}: checksum mismatch`);
    writeFileSync(archive, body);
    // tar reads both: Linux's tarball, and the zip on Windows (its bsdtar)
    await run(["tar", "-xf", archive, "-C", stage], 120_000);
    const got = versionIn(stage);
    if (got !== m.version) throw new Error(`${a.name} holds afterglow ${got || "nothing"}, not ${m.version}`);
    writeFileSync(join(stage, "PROTO"), `${m.proto}\n`);
    // read and run by the viewer's own login over ssh on Linux
    if (!windows) openUp(stage);
    rmSync(dir, { recursive: true, force: true });
    renameSync(stage, dir);
  } finally {
    rmSync(archive, { force: true });
    rmSync(stage, { recursive: true, force: true });
  }
}

// the afterglow a folder holds: its VERSION, "" without its binary
function versionIn(dir: string): string {
  try {
    if (!statSync(join(dir, exeName(windows))).isFile()) return "";
    return readFileSync(join(dir, "VERSION"), "utf8").trim();
  } catch {
    return "";
  }
}

// every folder 755 and every file 644, the binary 755
function openUp(dir: string) {
  chmodSync(dir, 0o755);
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) openUp(p);
    else chmodSync(p, e.name === "afterglow" ? 0o755 : 0o644);
  }
}

async function run(argv: string[], ms: number) {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill(), ms);
  const code = await p.exited;
  clearTimeout(t);
  if (code !== 0) {
    const err = (await new Response(p.stderr).text()).trim().split("\n").pop() ?? "";
    throw new Error(
      `${argv[argv.length - 1] === "afterglow" ? "taking it up" : argv[0]} failed${err ? `: ${err}` : ""}`,
    );
  }
}

function audit(user: string, args: Record<string, any>, err?: unknown) {
  const row: Record<string, any> = { user, via: "desktop", tool: "afterglow_update", args, ok: !err, host: SelfHost };
  if (err) row.error = errText(err);
  auditRow(row);
}

// --- the mesh ------------------------------------------------------------------------

// each host asked to update its own afterglow, this one directly; the answers as they start
export async function updateMesh(hosts: string[], by: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    hosts.map(async (h) => {
      if (h === SelfHost) {
        void updateSelf(by);
        out[h] = "started";
        return;
      }
      const ip = await tailnetIP(h);
      if (!ip) {
        out[h] = "not on the tailnet";
        return;
      }
      const [st, b] = await peerCall(h, { host: ip, method: "POST", path: "/api/afterglow/local", body: { by } });
      out[h] = st === 202 ? "started" : String(b?.error ?? `status ${st}`);
    }),
  );
  return out;
}
