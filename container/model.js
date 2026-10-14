'use strict';
// the mesh's model: llama-server on the one host with [model] host = true,
// every other host asking it through its frontend

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { notes, phosphorusIni, readJson, requestJson, writeJsonAtomic } = require(`${process.env.FRONTEND_DIR || '/opt/frontend'}/util`);

const num = (k, d) => Number(process.env[k] || d);
const STATE_DIR = process.env.STATE_DIR || '/state';
const SELF_HOST = process.env.SELF_HOST || '';
// read by the frontend, carried to peers on the mesh poll
const CLAIM_FILE = path.join(STATE_DIR, 'model-claim.json');
// the machine's own ram, left by the host's run script (/proc/meminfo is
// docker's vm on windows and macos)
const MACHINE_FILE = path.join(STATE_DIR, 'machine.json');
// the link the model on disk came from, a new one replacing it
const INSTALLED_FILE = path.join(STATE_DIR, 'model-installed.json');
// llama-server's slot actions, wanted for /purge's erase
const SLOT_DIR = path.join(STATE_DIR, 'llama-slots');
const LLAMA_DIR = process.env.LLAMA_DIR || '/opt/llama';
const MODEL_DIR = process.env.MODEL_DIR || '/models';
// loopback only, peers reaching it through the model host's frontend
const SERVER_PORT = num('MODEL_SERVER_PORT', 8791);

// [model] ctx when phosphorus.ini names none, the model itself without a default
const DEFAULT_CTX = 65536;
// asks answered at once, sharing the one context window
const DEFAULT_SLOTS = 4;
// the weights plus compute buffers, as a share of the file
const NEED_FACTOR = 1.03;
// the kv cache on top, per context token: twice the default model's
// grouped-query attention, so a bigger ctx is priced before it loads
const KV_BYTES_PER_TOKEN = 64 * 1024;
const GIB = 1024 ** 3;

const TICK_MS = num('MODEL_TICK_MS', 1000);
const RETRY_MS = 15000;
const DOWNLOAD_RETRY_MS = 60000;
const NVSMI = ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi'];

const { log, note, clear } = notes('model');
const now = () => performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gb = (bytes) => `${(bytes / GIB).toFixed(1)}GB`;
const exists = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };
const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };

// [model] url as a https link to a single .gguf, hugging face's page link
// taken for its download link, null for anything else
function modelLink(raw) {
  try {
    const u = new URL(raw.replace(/^(https:\/\/huggingface\.co\/.+?)\/blob\//, '$1/resolve/'));
    const file = path.basename(decodeURIComponent(u.pathname));
    return u.protocol === 'https:' && file.endsWith('.gguf') ? { url: u.href, file } : null;
  } catch {
    return null;
  }
}

// re-read every tick, phosphorus.ini edited in place
const config = () => ({
  raw: phosphorusIni('model', 'url') || '',
  ...(modelLink(phosphorusIni('model', 'url') || '') || { url: '', file: '' }),
  ctx: Number(phosphorusIni('model', 'ctx')) || DEFAULT_CTX,
  slots: Math.max(1, Math.floor(Number(phosphorusIni('model', 'slots')) || DEFAULT_SLOTS)),
  host: phosphorusIni('model', 'host') === 'true',
  gpu: phosphorusIni('model', 'gpu') === 'true',
});

// own tailnet IP, where peers' asks come in
function selfAddr() {
  for (const list of Object.values(os.networkInterfaces())) {
    const a = (list || []).find((x) => x.family === 'IPv4' && /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(x.address));
    if (a) return a.address;
  }
  return '';
}

function memTotal() {
  const m = (() => { try { return fs.readFileSync('/proc/meminfo', 'utf8'); } catch { return ''; } })().match(/^MemTotal:\s+(\d+)/m);
  return m ? Number(m[1]) * 1024 : os.totalmem();
}

// the first gpu's free vram, 0 without a cuda build or a visible gpu
function freeVram(i = 0) {
  if (!fs.existsSync(path.join(LLAMA_DIR, 'libggml-cuda.so'))) return Promise.resolve(0);
  if (i >= NVSMI.length) return Promise.resolve(0);
  return new Promise((resolve) => {
    execFile(NVSMI[i], ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeout: 5000 }, (err, out) => {
      if (err) { resolve(freeVram(i + 1)); return; }
      resolve(Math.floor((Number(String(out).split('\n')[0]) || 0) * 1024 ** 2 * 0.95));
    });
  });
}

// --- download ---------------------------------------------------------------

let dl = { proc: null, file: '', total: 0, retryAt: 0 };
const modelPath = (cfg) => path.join(MODEL_DIR, cfg.file);

// hugging face's own size header first, else the cdn's length after redirects
async function remoteSize(cfg) {
  try {
    const res = await fetch(cfg.url, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    return Number(res.headers.get('x-linked-size') || res.headers.get('content-length')) || 0;
  } catch {
    return 0;
  }
}

// its .part kept, for curl -C to pick up again
function pauseDownload(why) {
  const { proc, file } = dl;
  dl = { ...dl, proc: null };
  proc.kill();
  log(`download of ${file} paused (${why})`);
}

// true once the gguf is on disk
async function ensureModel(cfg) {
  if (dl.proc && dl.file !== cfg.file) pauseDownload(`${cfg.file} named instead`);
  if (exists(modelPath(cfg))) return true;
  if (dl.proc || now() < dl.retryAt) return false;
  const part = `${modelPath(cfg)}.part`;
  const proc = spawn('curl', ['-fsSL', '--retry', '5', '--retry-delay', '5', '-C', '-', '-o', part, cfg.url], { stdio: 'inherit' });
  dl = { proc, file: cfg.file, total: 0, retryAt: 0 };
  log(`downloading ${cfg.file} from ${new URL(cfg.url).host}`);
  remoteSize(cfg).then((n) => { if (dl.proc === proc) dl.total = n; });
  const done = (code) => {
    if (dl.proc !== proc) return;
    dl = { ...dl, proc: null };
    if (code === 0) {
      try { fs.renameSync(part, path.join(MODEL_DIR, dl.file)); log(`${dl.file} downloaded`); return; } catch {}
    }
    dl.retryAt = now() + DOWNLOAD_RETRY_MS;
    log(`download of ${dl.file} failed (${code}), retrying in ${DOWNLOAD_RETRY_MS / 1000}s`);
  };
  proc.on('error', (e) => done(e.message));
  proc.on('exit', (code, sig) => done(sig || code));
  return false;
}

// a new valid [model] url: the old model stopped and deleted, a part download too,
// the first link seen just recorded
let installed = readJson(INSTALLED_FILE, null);
function replaceOld(cfg) {
  if (installed && installed.url === cfg.url) return;
  if (installed && installed.file) {
    if (dl.proc) pauseDownload(`${cfg.file} named instead`);
    stopServer();
    for (const f of [installed.file, `${installed.file}.part`]) {
      try { fs.unlinkSync(path.join(MODEL_DIR, f)); log(`uninstalled ${f}, replaced by ${cfg.file}`); } catch {}
    }
  }
  installed = { url: cfg.url, file: cfg.file };
  writeJsonAtomic(INSTALLED_FILE, installed);
}

// --- llama-server -----------------------------------------------------------

let srv = { proc: null, sig: '', state: 'down', retryAt: 0, since: 0 };
// the gpu's free vram, read only while nothing of ours sits in it
let vram = 0;
// what the host has against what the model needs, and why it isn't up
let fit = { need: 0, why: '' };
// exits since it was last up, so a crash loop never reads as a slow load;
// oom set when the last exit was the gpu out of vram
let trouble = { exits: 0, lastExit: '', oom: false };
// the [model] last started, a new one starting its trouble over
let triedSig = '';
// llama.cpp's cuda allocation failures, at load or reserving compute buffers
const VRAM_RE = /cudaMalloc failed|out of memory|(failed|unable) to allocate CUDA\d* buffer/i;

function stopServer() {
  if (srv.proc) srv.proc.kill();
  srv = { proc: null, sig: '', state: 'down', retryAt: 0, since: 0 };
}

// llama-server wholly on the gpu with [model] gpu, wholly on the cpu without
async function serve(cfg) {
  if (!srv.proc && (!cfg.gpu || now() >= srv.retryAt)) vram = cfg.gpu ? await freeVram() : 0;
  // [model] gpu never falling back to the cpu, not loaded until the gpu is usable
  if (cfg.gpu && !vram) {
    fit = { need: 0, why: fs.existsSync(path.join(LLAMA_DIR, 'libggml-cuda.so'))
      ? 'gpu is on but no nvidia gpu is usable here' : 'gpu is on but llama-server here has no cuda, phosphorus update rebuilds it' };
    note('gpu', fit.why);
    // nvidia-smi asked again a retry later, not every tick
    stopServer();
    srv.retryAt = now() + RETRY_MS;
    return;
  }
  clear('gpu');
  const need = Math.ceil(sizeOf(modelPath(cfg)) * NEED_FACTOR + cfg.ctx * KV_BYTES_PER_TOKEN);
  const has = memTotal() + vram;
  fit = { need, why: '' };
  if (has < need) {
    fit.why = `${SELF_HOST || 'the model host'} has ${gb(has)}, short of the ${gb(need)} ${cfg.file} needs at ${cfg.ctx} ctx`;
    note('fit', fit.why);
    stopServer();
    return;
  }
  clear('fit');

  const sig = JSON.stringify([cfg.file, cfg.ctx, cfg.slots, cfg.gpu]);
  if (srv.proc && srv.sig === sig) {
    const up = await requestJson({ host: '127.0.0.1', port: SERVER_PORT, path: '/health', timeout: 1500 })
      .then((r) => r.status === 200, () => false);
    if (up && srv.state !== 'ready') {
      log(`${cfg.file} loaded`);
      trouble = { exits: 0, lastExit: '', oom: false };
    }
    if (srv.proc) srv.state = up ? 'ready' : 'loading';
    return;
  }
  // [model] changed: the old server out first, the new one a tick later
  if (srv.proc) { log('[model] changed, reloading'); stopServer(); return; }
  if (now() < srv.retryAt) return;

  fs.mkdirSync(SLOT_DIR, { recursive: true });
  if (sig !== triedSig) { trouble = { exits: 0, lastExit: '', oom: false }; triedSig = sig; }
  const proc = spawn(path.join(LLAMA_DIR, 'llama-server'), [
    // on the cpu read whole into ram and locked there, so no ask waits on the
    // disk; on the gpu read past the page cache, no copy of the weights left in ram
    '-m', modelPath(cfg), '--load-mode', cfg.gpu ? 'dio' : 'mlock',
    '-c', String(cfg.ctx), '-np', String(cfg.slots), '--kv-unified', '--jinja',
    // kv cache at half the size, near lossless, so more of it stays in vram
    '-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0',
    // with [model] gpu every layer on cuda's first gpu, an error if it's gone
    // rather than the cpu, else the cpu alone
    ...(cfg.gpu ? ['--device', 'CUDA0', '-ngl', '999'] : ['-ngl', '0']),
    // evicted slots' prompts saved in ram on the cpu, capped well under the
    // default 8GB; none on the gpu, its prefill quick enough to redo
    '--cache-ram', cfg.gpu ? '0' : '2048',
    // a shifted chat prefix still reused from the cache, chunks moved not
    // recomputed, a sliding-window model turning it off itself
    '--cache-reuse', '256',
    // its slots listed and erasable, for /purge
    '--slots', '--slot-save-path', SLOT_DIR,
    '--host', '127.0.0.1', '--port', String(SERVER_PORT),
  ], { stdio: ['ignore', 'inherit', 'pipe'], env: { ...process.env, LD_LIBRARY_PATH: LLAMA_DIR } });
  // its log passed on to docker's as before, read for running out of vram
  let oom = false;
  proc.stderr.on('data', (b) => {
    process.stderr.write(b);
    if (vram && VRAM_RE.test(b)) oom = true;
  });
  // wall clock, compared on whichever host renders it
  srv = { proc, sig, state: 'loading', retryAt: 0, since: Date.now() };
  log(`loading ${cfg.file} on ${vram ? `the gpu's ${gb(vram)} and ` : ''}${gb(memTotal())} ram, ${gb(need)} needed`);
  const gone = (why) => {
    if (srv.proc !== proc) return;
    srv = { proc: null, sig: '', state: 'down', retryAt: now() + RETRY_MS, since: 0 };
    trouble = { exits: trouble.exits + 1, lastExit: why, oom };
    log(`llama-server stopped (${why}), retrying in ${RETRY_MS / 1000}s`);
  };
  proc.on('error', (e) => gone(e.message));
  proc.on('exit', (code, signal) => gone(signal || `exit ${code}`));
}

// --- the tick ---------------------------------------------------------------

const claim = (cfg) => ({
  host: SELF_HOST, ip: selfAddr(), runs: cfg.host,
  // what the vm has against the machine, for the model tab's warning
  total: memTotal(), machine: Number(readJson(MACHINE_FILE, {}).ram) || 0,
  ...(cfg.host ? {
    file: cfg.file, size: sizeOf(modelPath(cfg)), ctx: cfg.ctx, slots: cfg.slots, gpu: vram > 0, vram,
    server: srv.state, serverSince: srv.since, ...fit, ...trouble,
    download: dl.proc ? { done: sizeOf(`${modelPath(cfg)}.part`), total: dl.total } : null,
  } : {}),
});

async function tick() {
  const cfg = config();
  if (!cfg.host || !cfg.file) {
    if (dl.proc) pauseDownload(cfg.host ? '[model] url cleared' : '[model] host is off');
    stopServer();
    fit = { need: 0, why: !cfg.host ? '' : cfg.raw ? `[model] url isn't a https link to a single .gguf: ${cfg.raw}`
      : 'no model yet, enter its download link in the model tab of phosphorus' };
    if (fit.why) note('link', fit.why);
    else clear('link');
  } else {
    replaceOld(cfg);
    if (await ensureModel(cfg)) await serve(cfg);
    else stopServer();
  }
  if (cfg.file) clear('link');
  writeJsonAtomic(CLAIM_FILE, claim(cfg));
}

let stopping = false;
process.on('SIGTERM', () => {
  stopping = true;
  try { fs.unlinkSync(CLAIM_FILE); } catch {}
  for (const p of [srv.proc, dl.proc]) if (p) p.kill();
  process.exit(0);
});

async function main() {
  fs.mkdirSync(MODEL_DIR, { recursive: true });
  log(`starting as ${SELF_HOST || 'an unnamed host'}`);
  for (;;) {
    const t0 = Date.now();
    if (!stopping) await tick().then(() => clear('tick'), (e) => note('tick', `tick failed, still retrying: ${e.message}`));
    await sleep(Math.max(0, TICK_MS - (Date.now() - t0)));
  }
}

main();
