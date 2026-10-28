// llama-server on the one host with [model] host = true, fetched there alone,
// every other host asking it through its frontend
import { spawn, type Subprocess } from "bun";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { networkInterfaces, totalmem } from "node:os";
import { join } from "node:path";
import * as tools from "@phosphorus/tools";
import { env, envInt, errText, ini, marshal, Notes, now, readJSON, run, sleep, StateDir, writeJSONAtomic } from "@phosphorus/util";

const stateDir = StateDir;
let selfHost = process.env.SELF_HOST ?? "";
const selfHostFile = join(stateDir, "self-host");
const claimFile = join(stateDir, "model-claim.json");
const installedFile = join(stateDir, "model-installed.json");
const slotDir = join(stateDir, "llama-slots");
const modelDir = env("MODEL_DIR", join(StateDir, "models"));
const serverPort = envInt("MODEL_SERVER_PORT", 8791);
const tickMS = envInt("MODEL_TICK_MS", 1000);
const notes = new Notes("model");
export const vramRe = /cudaMalloc failed|out of memory|OutOfDeviceMemory|(failed|unable) to allocate (CUDA|Vulkan)\d* buffer/i;
// a gpu gone from under a running server: Vulkan's device lost, or any of its
// commands failing a decode; every call fails after while /health stays 200
export const gpuLostRe = /ErrorDeviceLost|decode\(\) failed: vk::/;
// "  Vulkan0: AMD Radeon RX 7800 XT (16368 MiB, 15600 MiB free)"
export const deviceRe = /^\s*(\S+): .* \((\d+) MiB, (\d+) MiB free\)\s*$/gm;
const hfBlob = /^(https:\/\/huggingface\.co\/.+?)\/blob\//;

const defaultCtx = 65536;
const defaultSlots = 4;
const needFactor = 1.03;
const kvBytesPerToken = 64 * 1024;
const gib = 1 << 30;
const retry = 15_000;
const downloadRetry = 60_000;

const gb = (b: number) => `${(b / gib).toFixed(1)}GB`;

function isFile(f: string): boolean {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
}

function sizeOf(f: string): number {
  try {
    return statSync(f).size;
  } catch {
    return 0;
  }
}

export type Link = { url: string; file: string };

// a https link to one .gguf, a huggingface blob page taken as its file
export function modelLink(raw: string): Link | undefined {
  let u: URL;
  try {
    u = new URL(raw.replace(hfBlob, "$1/resolve/"));
  } catch {
    return;
  }
  if (u.protocol !== "https:" || !u.hostname) return;
  let p: string;
  try {
    p = decodeURIComponent(u.pathname);
  } catch {
    return;
  }
  // path.Base: trailing slashes off, the last element
  const f = p.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!f.endsWith(".gguf")) return;
  return { url: u.href, file: f };
}

export type Config = { raw: string; url: string; file: string; ctx: number; slots: number; host: boolean; gpu: boolean };

// strconv.ParseFloat, 0 when it isn't a number
function jsNum(s: string): number {
  const f = Number(s.trim());
  return Number.isFinite(f) && s.trim() !== "" ? f : 0;
}

export function readConfig(): Config {
  const raw = ini("model", "url");
  const l = modelLink(raw);
  let ctx = Math.trunc(jsNum(ini("model", "ctx")));
  if (ctx === 0) ctx = defaultCtx;
  let slots = Math.floor(jsNum(ini("model", "slots")));
  if (slots === 0) slots = defaultSlots;
  if (slots < 1) slots = 1;
  return { raw, url: l?.url ?? "", file: l?.file ?? "", ctx, slots, host: ini("model", "host") === "true", gpu: ini("model", "gpu") === "true" };
}

// this host's tailnet IPv4, in 100.64.0.0/10
function selfAddr(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4") continue;
      const [b0, b1] = a.address.split(".").map(Number);
      if (b0 === 100 && b1! >= 64 && b1! <= 127) return a.address;
    }
  }
  return "";
}

const memTotal = () => totalmem();

// the device llama-server's own build lists with the most free memory, and 95%
// of that free memory
async function gpuDevice(gpu: boolean): Promise<[string, number]> {
  const r = await run([tools.llamaServer(gpu), "--list-devices"], { env: { ...process.env, LD_LIBRARY_PATH: tools.llamaDir(gpu) }, timeoutMs: 30_000 });
  let name = "", free = 0;
  for (const m of r.output.matchAll(deviceRe)) {
    const f = jsNum(m[3]!);
    if (f > free) [name, free] = [m[1]!, f];
  }
  return [name, Math.floor(free * (1 << 20) * 0.95)];
}

// --- download ---------------------------------------------------------------

type Download = { proc?: Subprocess; file: string; total: number; retryAt: number };

let dl: Download = { file: "", total: 0, retryAt: 0 };

const modelPath = (c: Config) => join(modelDir, c.file);

async function remoteSize(u: string): Promise<number> {
  let res: Response;
  try {
    res = await fetch(u, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
  } catch {
    return 0;
  }
  const linked = Number(res.headers.get("X-Linked-Size"));
  if (Number.isInteger(linked) && linked > 0) return linked;
  const n = Number(res.headers.get("Content-Length"));
  return Number.isInteger(n) ? n : 0;
}

function pauseDownload(why: string) {
  const { proc, file } = dl;
  dl.proc = undefined;
  proc?.kill();
  notes.log(`download of ${file} paused (${why})`);
}

function ensureModel(c: Config): boolean {
  if (dl.proc && dl.file !== c.file) pauseDownload(c.file + " named instead");
  if (isFile(modelPath(c))) return true;
  if (dl.proc || now() < dl.retryAt) return false;
  const part = modelPath(c) + ".part";
  let proc: Subprocess;
  try {
    proc = spawn(["curl", "-fsSL", "--retry", "5", "--retry-delay", "5", "-C", "-", "-o", part, c.url], { stdin: "ignore", stdout: "inherit", stderr: "inherit", windowsHide: true });
  } catch (e) {
    dl.retryAt = now() + downloadRetry;
    notes.log(`download of ${c.file} failed (${errText(e)}), retrying in ${downloadRetry / 1000}s`);
    return false;
  }
  dl = { proc, file: c.file, total: 0, retryAt: 0 };
  notes.log(`downloading ${c.file} from ${new URL(c.url).host}`);
  remoteSize(c.url).then((n) => {
    if (dl.proc === proc) dl.total = n;
  });
  proc.exited.then((code) => {
    if (dl.proc !== proc) return;
    dl.proc = undefined;
    if (code === 0) {
      try {
        renameSync(part, join(modelDir, dl.file));
        notes.log(dl.file + " downloaded");
        return;
      } catch {}
    }
    dl.retryAt = now() + downloadRetry;
    notes.log(`download of ${dl.file} failed (${proc.signalCode ?? code}), retrying in ${downloadRetry / 1000}s`);
  });
  return false;
}

type Installed = { url: string; file: string };

let installed: Installed | undefined;

// the previous model's file gone once [model] url names another
function replaceOld(c: Config) {
  if (installed && installed.url === c.url) return;
  if (installed && installed.file) {
    if (dl.proc) pauseDownload(c.file + " named instead");
    stopServer();
    for (const f of [installed.file, installed.file + ".part"]) {
      try {
        rmSync(join(modelDir, f));
        notes.log(`uninstalled ${f}, replaced by ${c.file}`);
      } catch {}
    }
  }
  installed = { url: c.url, file: c.file };
  writeJSONAtomic(installedFile, installed);
}

// --- llama-server -----------------------------------------------------------

type Server = { proc?: Subprocess; sig: string; state: string; retryAt: number; since: number };
type Trouble = { exits: number; lastExit: string; oom: boolean };

let srv: Server = { sig: "", state: "down", retryAt: 0, since: 0 };
let vram = 0;
let device = "";
let fitNeed = 0;
let fitWhy = "";
let trouble: Trouble = { exits: 0, lastExit: "", oom: false };
let triedSig = "";

// stop asks p to end, killed where there's no TERM to ask with (Windows)
const stop = (p: Subprocess) => p.kill("SIGTERM");

function stopServer() {
  if (srv.proc) stop(srv.proc);
  srv = { sig: "", state: "down", retryAt: 0, since: 0 };
}

// /health answering 200, no proxy from the environment on the way
async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${serverPort}/health`, { proxy: false, signal: AbortSignal.timeout(1500) } as RequestInit);
    await res.body?.cancel();
    return res.status === 200;
  } catch {
    return false;
  }
}

async function serve(c: Config) {
  if (!tools.ready(tools.llamaDir(c.gpu))) {
    fitNeed = 0;
    fitWhy = "fetching llama-server " + tools.LlamaTag;
    const st = toolState.llama ?? "";
    if (st.startsWith("failed")) fitWhy = `llama-server ${tools.LlamaTag} ${st}, retrying`;
    stopServer();
    return;
  }
  if (!srv.proc && (!c.gpu || now() >= srv.retryAt)) {
    if (c.gpu) [device, vram] = await gpuDevice(c.gpu);
    else [device, vram] = ["", 0];
  }
  if (c.gpu && vram === 0) {
    fitNeed = 0;
    const b = tools.backend(c.gpu);
    fitWhy = b ? `gpu is on but llama-server's ${b} build finds no usable gpu here` : "gpu is on but upstream has no gpu build of llama-server for this machine";
    notes.note("gpu", fitWhy);
    stopServer();
    srv.retryAt = now() + retry;
    return;
  }
  notes.clear("gpu");
  const need = Math.ceil(sizeOf(modelPath(c)) * needFactor + c.ctx * kvBytesPerToken);
  let has = memTotal();
  // macOS' gpu memory is its ram
  if (process.platform !== "darwin") has += vram;
  [fitNeed, fitWhy] = [need, ""];
  if (has < need) {
    fitWhy = `${selfHost || "the model host"} has ${gb(has)}, short of the ${gb(need)} ${c.file} needs at ${c.ctx} ctx`;
    notes.note("fit", fitWhy);
    stopServer();
    return;
  }
  notes.clear("fit");
  const sig = marshal([c.file, c.ctx, c.slots, c.gpu]);
  if (srv.proc && srv.sig === sig) {
    const p = srv.proc;
    const up = await healthy();
    if (srv.proc !== p) return;
    if (up && srv.state !== "ready") {
      notes.log(c.file + " loaded");
      trouble = { exits: 0, lastExit: "", oom: false };
    }
    srv.state = up ? "ready" : "loading";
    return;
  }
  if (srv.proc) {
    notes.log("[model] changed, reloading");
    stopServer();
    return;
  }
  if (now() < srv.retryAt) return;
  mkdirSync(slotDir, { recursive: true, mode: 0o755 });
  if (sig !== triedSig) {
    trouble = { exits: 0, lastExit: "", oom: false };
    triedSig = sig;
  }
  const args = ["-m", modelPath(c), "--load-mode", c.gpu ? "dio" : "mlock", "-c", String(c.ctx), "-np", String(c.slots), "--kv-unified", "--jinja", "-fa", "on", "-ctk", "q8_0", "-ctv", "q8_0"];
  if (c.gpu) args.push("--device", device, "-ngl", "999");
  else args.push("-ngl", "0");
  args.push("--cache-ram", c.gpu ? "0" : "2048", "--cache-reuse", "256", "--slots", "--slot-save-path", slotDir, "--host", "127.0.0.1", "--port", String(serverPort));
  const dir = tools.llamaDir(c.gpu);
  let oom = false;
  const gone = (why: string) => {
    srv = { sig: "", state: "down", retryAt: now() + retry, since: 0 };
    trouble = { exits: trouble.exits + 1, lastExit: why, oom };
    notes.log(`llama-server stopped (${why}), retrying in ${retry / 1000}s`);
  };
  let cmd: Subprocess;
  try {
    cmd = spawn([tools.llamaServer(c.gpu), ...args], {
      env: { ...process.env, LD_LIBRARY_PATH: dir, PHOSPHORUS_ROLE: "llama-server" },
      stdin: "ignore",
      stdout: "inherit",
      stderr: "pipe",
      windowsHide: true,
    });
  } catch (e) {
    gone(errText(e));
    return;
  }
  const v = vram;
  (async () => {
    let lost = false;
    const dec = new TextDecoder();
    for await (const chunk of cmd.stderr as ReadableStream<Uint8Array>) {
      process.stderr.write(chunk);
      if (v <= 0) continue;
      const s = dec.decode(chunk, { stream: true });
      if (vramRe.test(s)) oom = true;
      // stopped, so the retry loads it on the gpu afresh
      if (!lost && gpuLostRe.test(s)) {
        lost = true;
        notes.log("llama-server lost its gpu, restarting it");
        stop(cmd);
      }
    }
  })().catch(() => {});
  srv = { proc: cmd, sig, state: "loading", retryAt: 0, since: now() };
  const on = vram > 0 ? `the gpu's ${gb(vram)} and ` : "";
  notes.log(`loading ${c.file} on ${on}${gb(memTotal())} ram, ${gb(need)} needed`);
  cmd.exited.then((code) => {
    if (srv.proc === cmd) gone(cmd.signalCode ? String(cmd.signalCode) : `exit ${code}`);
  });
}

// --- the tick ---------------------------------------------------------------

function claim(c: Config): Record<string, any> {
  const out: Record<string, any> = { host: selfHost, ip: selfAddr(), runs: c.host, total: memTotal(), machine: memTotal() };
  if (c.host) {
    const d = dl.proc ? { done: sizeOf(modelPath(c) + ".part"), total: dl.total } : null;
    Object.assign(out, {
      file: c.file, size: sizeOf(modelPath(c)), ctx: c.ctx, slots: c.slots, gpu: vram > 0, vram,
      server: srv.state, serverSince: srv.since, need: fitNeed, why: fitWhy,
      exits: trouble.exits, lastExit: trouble.lastExit, oom: trouble.oom, download: d, tools: toolState,
    });
  }
  return out;
}

// the tools' states on the model host: ready, fetching or why not
let toolState: Record<string, string> = {};

// phosphorus-model has no tailnet of its own: the name phosphorus wrote
function readSelf() {
  if (process.env.SELF_HOST) return;
  try {
    selfHost = readFileSync(selfHostFile, "utf8").trim();
  } catch {}
}

async function tick() {
  readSelf();
  const c = readConfig();
  // fetched on the model host, dropped from every other
  let st: Record<string, string> = {};
  if (c.host) st = tools.ensure(c.gpu);
  else tools.remove();
  toolState = st;
  if (!c.host || !c.file) {
    if (dl.proc) pauseDownload(c.host ? "[model] url cleared" : "[model] host is off");
    stopServer();
    fitNeed = 0;
    fitWhy = !c.host ? "" : c.raw ? "[model] url isn't a https link to a single .gguf: " + c.raw : "no model yet, enter its download link in the model tab of phosphorus";
    if (fitWhy) notes.note("link", fitWhy);
    else notes.clear("link");
  } else {
    replaceOld(c);
    if (ensureModel(c)) await serve(c);
    else stopServer();
  }
  if (c.file) notes.clear("link");
  writeJSONAtomic(claimFile, claim(c));
}

// the daemon until SIGTERM
export async function main(): Promise<number> {
  mkdirSync(modelDir, { recursive: true, mode: 0o755 });
  const inst = readJSON<Installed>(installedFile);
  if (inst && typeof inst === "object") installed = { url: String(inst.url ?? ""), file: String(inst.file ?? "") };
  readSelf();
  notes.log("starting as " + (selfHost || "an unnamed host"));
  let done: (() => void) | undefined;
  const ended = new Promise<void>((r) => (done = r));
  for (const s of ["SIGTERM", "SIGINT"] as const) {
    try {
      process.on(s, () => done?.());
    } catch {}
  }
  let over = false;
  ended.then(() => (over = true));
  while (!over) {
    const t0 = now();
    try {
      await tick();
      notes.clear("tick");
    } catch (e) {
      notes.note("tick", `tick failed, still retrying: ${errText(e)}`);
    }
    const wait = Math.max(0, tickMS - (now() - t0));
    await Promise.race([ended, sleep(wait)]);
  }
  try {
    rmSync(claimFile);
  } catch {}
  for (const p of [srv.proc, dl.proc]) if (p) stop(p);
  return 0;
}
