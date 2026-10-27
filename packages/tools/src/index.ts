// llama-server, fetched on the model host alone into the model volume, pinned to
// upstream's releases, gone once it stops being the model host
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { env, StateDir, which } from "@phosphorus/util";
import { untar, unzip } from "./archive.ts";

// upstream's llama.cpp release
export const LlamaTag = "b11838";
const retryAfterMs = 60_000;
const okStamp = ".phosphorus-ok";

const root = join(env("MODEL_DIR", join(StateDir, "models")), "tools");

// where every fetched tool lives
export const toolsRoot = () => root;

let nvidia: boolean | undefined;
const hasNvidia = () => (nvidia ??= !!which("nvidia-smi"));

// llama-server's gpu build: cuda on an nvidia gpu, vulkan for amd and intel ones,
// metal on macOS, none with gpu off or off x64
export function backend(gpu: boolean): string {
  if (!gpu) return "";
  if (process.platform === "darwin") return "metal";
  if (process.arch !== "x64") return "";
  return hasNvidia() ? "cuda" : "vulkan";
}

// upstream's build for this OS and backend
function llamaKind(gpu: boolean): string {
  const a = ({ x64: "x64", arm64: "arm64" } as Record<string, string>)[process.arch] ?? "";
  const b = backend(gpu);
  if (process.platform === "darwin") return "macos-" + a;
  if (process.platform === "win32") return b === "cuda" ? "win-cuda-12.4-x64" : b === "vulkan" ? "win-vulkan-x64" : "win-cpu-" + a;
  return b === "cuda" ? "cuda-12.8-x64" : b === "vulkan" ? "vulkan-x64" : a;
}

const exeName = (n: string) => (process.platform === "win32" ? n + ".exe" : n);

// llama-server and its libs, the gpu build when gpu
export const llamaDir = (gpu: boolean) => join(root, `llama-${LlamaTag}-${llamaKind(gpu)}`);
// the llama-server binary of that build
export const llamaServer = (gpu: boolean) => join(llamaDir(gpu), exeName("llama-server"));

// a tool's folder fully unpacked
export const ready = (dir: string) => existsSync(join(dir, okStamp));

export type Fetch = { dir: string; urls: string[]; strip: number };

function llamaFetch(gpu: boolean): Fetch {
  const base = "https://github.com/ggml-org/llama.cpp/releases/download/" + LlamaTag;
  const k = llamaKind(gpu);
  if (process.platform === "darwin") return { dir: llamaDir(gpu), urls: [`${base}/llama-${LlamaTag}-bin-${k}.tar.gz`], strip: 1 };
  if (process.platform === "win32") {
    const urls = [`${base}/llama-${LlamaTag}-bin-${k}.zip`];
    if (k.includes("cuda")) urls.push(`${base}/cudart-llama-bin-${k}.zip`);
    return { dir: llamaDir(gpu), urls, strip: 0 };
  }
  const urls = [`${base}/llama-${LlamaTag}-bin-ubuntu-${k}.tar.gz`];
  if (k.startsWith("cuda")) urls.push(`${base}/cudart-llama-${LlamaTag}-bin-ubuntu-${k}.tar.gz`);
  return { dir: llamaDir(gpu), urls, strip: 1 };
}

// one tool: fetching, or why it failed and when to try again
type State = { busy: boolean; err: string; retryAt: number };
const states = new Map<string, State>();

// llama-server here, fetched in the background once missing; its state by name:
// ready, fetching or the failure
export function ensure(gpu: boolean): Record<string, string> {
  dropOpencode();
  const out = { llama: ensureOne(llamaFetch(gpu)) };
  prune(gpu);
  return out;
}

let dropped = false;
// once per run, what older releases fetched for opencode: its opencode-* folders
// under the tools root and its home on the model volume, so the disk is handed back
function dropOpencode() {
  if (dropped) return;
  dropped = true;
  try {
    for (const n of readdirSync(root)) if (n.startsWith("opencode-")) rmSync(join(root, n), { recursive: true, force: true });
  } catch {}
  rmSync(join(dirname(root), "opencode"), { recursive: true, force: true });
}

function ensureOne(f: Fetch): string {
  if (ready(f.dir)) return "ready";
  let s = states.get(f.dir);
  if (!s) states.set(f.dir, (s = { busy: false, err: "", retryAt: 0 }));
  if (s.busy) return "fetching";
  if (Date.now() < s.retryAt) return s.err;
  s.busy = true;
  install(f).then(
    () => Object.assign(s, { busy: false, err: "" }),
    (e) => Object.assign(s, { busy: false, err: "failed: " + (e?.message ?? e), retryAt: Date.now() + retryAfterMs }),
  );
  return "fetching";
}

// every other version and build dropped, so an upgrade or a gpu switch never
// leaves the old one on disk
function prune(gpu: boolean) {
  const keep = basename(llamaDir(gpu));
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {}
  for (const n of names) {
    const base = n.replace(/\.part$/, "");
    if (base === keep && (n === base || states.get(join(root, base))?.busy)) continue;
    rmSync(join(root, n), { recursive: true, force: true });
  }
}

// every fetched tool gone, this host no longer the model host
export function remove() {
  for (const s of states.values()) if (s.busy) return;
  rmSync(root, { recursive: true, force: true });
  dropOpencode();
}

// each archive into dir.part, renamed to dir once all are in
export async function install(f: Fetch) {
  const part = f.dir + ".part";
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part, { recursive: true });
  try {
    for (const u of f.urls) {
      const res = await fetch(u, { signal: AbortSignal.timeout(30 * 60_000) });
      if (res.status !== 200) throw new Error(`${basename(new URL(u).pathname)}: ${res.status} ${res.statusText}`);
      const data = new Uint8Array(await res.arrayBuffer());
      (u.endsWith(".zip") ? unzip : untar)(data, part, f.strip);
    }
  } catch (e) {
    rmSync(part, { recursive: true, force: true });
    throw e;
  }
  writeFileSync(join(part, okStamp), f.urls.join("\n") + "\n");
  rmSync(f.dir, { recursive: true, force: true });
  renameSync(part, f.dir);
}
