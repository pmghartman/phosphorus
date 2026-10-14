'use strict';
// status tab: this host's cpu, memory, disk, network, gpus, containers and
// processes, sampled only while watched, peers fanned in, one socket each

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { FRONTEND_PORT, readJson, writeJsonAtomic } = require('./util');

const SAMPLE_MS = 1000;
// docker stats itself taking ~2s, the table a slower beat
const DOCKER_MS = 5000;
const GPU_MS = 2000;
const PROC_MS = 2000;
const PROC_TOP = 25;
// clock ticks per second, as /proc/<pid>/stat counts them
const CLK_TCK = 100;
const PAGE = 4096;
// a peer socket dropped, redialed this soon
const PEER_RETRY_MS = 3000;
// host binds, so the host's own disks, never / (docker's)
const MOUNT_ROOTS = ['/state', '/files', '/repo'];
const SHARES = '/shares';
// the host's drives, bound whole by rebuild, unset: only the binds above
const HOST_ROOT = process.env.PHOSPHORUS_HOST_ROOT ? '/hostfs' : '';
// real filesystems, plus what Docker Desktop's VM passes windows drives as
const REAL_FS = /^(ext[234]|xfs|btrfs|zfs|f2fs|bcachefs|jfs|reiserfs|ntfs3?|fuseblk|exfat|vfat|hfsplus|apfs|9p|drvfs|virtiofs)$/;
// loopback and container plumbing, never a real link
const VIRTUAL_IF = /^(lo|veth|docker|br-|virbr|cni|flannel|kube)/;
// tunnels, their traffic counted again on the link under them
const TUNNEL_IF = /^(tailscale|wg|tun|utun)/;
const WHOLE_DISK = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const readdir = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

function cpuTimes() {
  const out = [];
  for (const line of read('/proc/stat').split('\n')) {
    if (!line.startsWith('cpu')) break;
    const v = line.trim().split(/\s+/).slice(1).map(Number);
    // idle plus iowait as idle
    out.push({ idle: v[3] + (v[4] || 0), total: v.slice(0, 8).reduce((a, b) => a + b, 0) });
  }
  return out;
}

function memInfo() {
  const kb = {};
  for (const line of read('/proc/meminfo').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  const total = kb.MemTotal || os.totalmem();
  const avail = kb.MemAvailable ?? os.freemem();
  return {
    total, used: total - avail, avail,
    cached: (kb.Cached || 0) + (kb.Buffers || 0),
    swapTotal: kb.SwapTotal || 0, swapUsed: (kb.SwapTotal || 0) - (kb.SwapFree || 0),
  };
}

function netBytes() {
  const out = {};
  for (const line of read('/proc/net/dev').split('\n').slice(2)) {
    const [name, rest] = line.split(':');
    if (!rest || VIRTUAL_IF.test(name.trim())) continue;
    const v = rest.trim().split(/\s+/).map(Number);
    out[name.trim()] = { rx: v[0], tx: v[8] };
  }
  return out;
}

// sectors of 512 bytes, whole disks only
function diskBytes() {
  let r = 0;
  let w = 0;
  for (const line of read('/proc/diskstats').split('\n')) {
    const v = line.trim().split(/\s+/);
    if (!WHOLE_DISK.test(v[2] || '')) continue;
    r += Number(v[5]) * 512;
    w += Number(v[9]) * 512;
  }
  return { r, w };
}

// the host binds and, under HOST_ROOT, every real filesystem of the host
function diskMounts() {
  const out = [];
  for (const line of read('/proc/self/mountinfo').split('\n')) {
    const v = line.split(' ');
    const sep = v.indexOf('-');
    if (sep < 0) continue;
    // octal escapes, a space as \040
    const dir = v[4].replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    const bound = MOUNT_ROOTS.includes(dir) || dir.startsWith(`${SHARES}/`);
    const host = HOST_ROOT && (dir === HOST_ROOT || dir.startsWith(`${HOST_ROOT}/`)) && REAL_FS.test(v[sep + 1]);
    if (bound || host) out.push({ dir, dev: v[2] });
  }
  return out;
}

// every distinct filesystem of the host, summed, one mounted twice counted
// once, by device, else by matching size and free space
function disk() {
  const seen = new Set();
  let total = 0;
  let used = 0;
  let count = 0;
  for (const { dir, dev } of diskMounts()) {
    if (seen.has(dev)) continue;
    let s;
    try { s = fs.statfsSync(dir); } catch { continue; }
    const key = `${s.blocks}:${s.bfree}:${s.bsize}:${s.type}`;
    if (!s.blocks || seen.has(key)) continue;
    seen.add(dev).add(key);
    total += s.blocks * s.bsize;
    used += (s.blocks - s.bfree) * s.bsize;
    count += 1;
  }
  return { total, used, count };
}

let model = null;
const cpuModel = () => (model ??= (read('/proc/cpuinfo').match(/^model name\s*:\s*(.+)$/m) || [])[1]
  || (os.cpus()[0] || {}).model || '');

// --- net totals over the last day --------------------------------------------
// always on, one /proc read per bucket, persisted across restarts

const NET_DAY_FILE = path.join(process.env.STATE_DIR || '/state', 'net-day.json');
const NET_BUCKET_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const bootId = read('/proc/sys/kernel/random/boot_id').trim();
// last: raw counters per link at the last bucket, buckets: [at, rx, tx]
const netDay = (() => {
  const d = readJson(NET_DAY_FILE, null);
  return d && Array.isArray(d.buckets) ? d : { boot: '', last: null, buckets: [] };
})();

const realLinks = () => Object.fromEntries(Object.entries(netBytes()).filter(([n]) => !TUNNEL_IF.test(n)));

// since the last bucket, a new link or a reboot counted from zero
function netSince(cur) {
  let rx = 0;
  let tx = 0;
  const fresh = netDay.boot !== bootId;
  for (const [name, v] of Object.entries(cur)) {
    const p = fresh ? undefined : netDay.last[name];
    rx += p && v.rx >= p.rx ? v.rx - p.rx : v.rx;
    tx += p && v.tx >= p.tx ? v.tx - p.tx : v.tx;
  }
  return { rx, tx };
}

function netDayTick() {
  const now = Date.now();
  const cur = realLinks();
  if (netDay.last) {
    const d = netSince(cur);
    netDay.buckets.push([now, d.rx, d.tx]);
  }
  netDay.buckets = netDay.buckets.filter(([at]) => now - at < DAY_MS);
  netDay.last = cur;
  netDay.boot = bootId;
  writeJsonAtomic(NET_DAY_FILE, netDay);
}

function netDayTotals() {
  const d = netSince(realLinks());
  for (const [, rx, tx] of netDay.buckets) { d.rx += rx; d.tx += tx; }
  const first = netDay.buckets[0]?.[0];
  return { ...d, since: first ? first - NET_BUCKET_MS : netDay.at };
}

// no file yet: this tick a baseline only
netDayTick();
netDay.at ??= Date.now();
setInterval(netDayTick, NET_BUCKET_MS).unref();

// --- containers ----------------------------------------------------------------

// "1.2GiB / 3.4GiB" style from docker stats
const UNIT = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
const bytes = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*([a-z]*)$/i);
  return m ? Number(m[1]) * (UNIT[m[2].toLowerCase()] || 1) : 0;
};

let containers = [];
let dockerBusy = false;
let dockerAt = 0;
function refreshDocker() {
  if (dockerBusy || Date.now() - dockerAt < DOCKER_MS) return;
  dockerBusy = true;
  execFile('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 10000 }, (err, out) => {
    dockerBusy = false;
    dockerAt = Date.now();
    if (err) { containers = null; return; }
    containers = String(out).split('\n').filter(Boolean).map((l) => {
      try {
        const c = JSON.parse(l);
        return {
          name: c.Name, cpu: parseFloat(c.CPUPerc) || 0, mem: bytes(String(c.MemUsage).split('/')[0]),
          pids: Number(c.PIDs) || 0,
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  });
}

// --- gpus ------------------------------------------------------------------------
// nvidia through nvidia-smi (docker-compose.gpu.yml's), amd and intel off sysfs

const NVSMI = ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi'];
const VENDOR = { '0x10de': 'nvidia', '0x1002': 'amd', '0x8086': 'intel' };
let nvsmi = 0;
let nvidia = [];
let gpuBusy = false;
let gpuAt = 0;

function refreshNvidia() {
  if (gpuBusy || nvsmi >= NVSMI.length || Date.now() - gpuAt < GPU_MS) return;
  gpuBusy = true;
  const q = '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu';
  execFile(NVSMI[nvsmi], [q, '--format=csv,noheader,nounits'], { timeout: 5000 }, (err, out) => {
    gpuBusy = false;
    gpuAt = Date.now();
    // not there: the next candidate, then none
    if (err) { if (err.code === 'ENOENT') nvsmi++; nvidia = []; return; }
    nvidia = String(out).split('\n').filter(Boolean).map((l) => {
      const [name, util, used, total, temp] = l.split(',').map((x) => x.trim());
      return {
        name: name.toLowerCase(), util: Number(util) || 0,
        memUsed: (Number(used) || 0) * 1024 ** 2, memTotal: (Number(total) || 0) * 1024 ** 2,
        temp: Number(temp) || null,
      };
    });
  });
}

const num = (f) => { const v = read(f).trim(); return v === '' ? null : Number(v); };

// dedicated only: intel's integrated always at 00:02.0, an amd apu with no
// vram chips of its own, so no vram vendor
function integrated(vendor, dev) {
  if (vendor === 'intel') return /:00:02\.0$/.test(read(`${dev}/uevent`).match(/PCI_SLOT_NAME=(\S+)/)?.[1] || '');
  if (vendor === 'amd') return ['', 'unknown'].includes(read(`${dev}/mem_info_vram_vendor`).trim());
  return false;
}

function sysfsGpus() {
  const out = [];
  for (const c of readdir('/sys/class/drm').filter((n) => /^card\d+$/.test(n))) {
    const dev = `/sys/class/drm/${c}/device`;
    const vendor = VENDOR[read(`${dev}/vendor`).trim()];
    if (!vendor || (vendor === 'nvidia' && nvidia.length) || integrated(vendor, dev)) continue;
    const hwmon = readdir(`${dev}/hwmon`)[0];
    const temp = hwmon ? num(`${dev}/hwmon/${hwmon}/temp1_input`) : null;
    out.push({
      name: (read(`${dev}/product_name`).trim() || `${vendor} gpu`).toLowerCase(),
      util: num(`${dev}/gpu_busy_percent`),
      memUsed: num(`${dev}/mem_info_vram_used`), memTotal: num(`${dev}/mem_info_vram_total`),
      // intel: clock against its max, the nearest to a load it exposes
      mhz: num(`/sys/class/drm/${c}/gt_act_freq_mhz`), mhzMax: num(`/sys/class/drm/${c}/gt_max_freq_mhz`),
      temp: temp === null ? null : Math.round(temp / 1000),
    });
  }
  return out;
}

const gpus = () => { refreshNvidia(); return [...nvidia, ...sysfsGpus()]; };

// --- processes -----------------------------------------------------------------
// the host's, through pid: host, every /proc entry, the busiest kept

let procPrev = new Map();
let procAt = 0;
let procs = null;

function refreshProcs(now) {
  if (now - procAt < PROC_MS) return;
  const secs = procAt ? (now - procAt) / 1000 : 0;
  procAt = now;
  const cur = new Map();
  const list = [];
  for (const pid of readdir('/proc').filter((n) => /^\d+$/.test(n))) {
    const st = read(`/proc/${pid}/stat`);
    const close = st.lastIndexOf(')');
    if (close < 0) continue;
    const f = st.slice(close + 2).split(' ');
    const rss = Number(f[21]) * PAGE;
    // kernel threads: no memory of their own
    if (!rss) continue;
    const ticks = Number(f[11]) + Number(f[12]);
    cur.set(pid, ticks);
    const was = procPrev.get(pid);
    const cpu = secs && was !== undefined ? Math.round((1000 * (ticks - was)) / CLK_TCK / secs) / 10 : 0;
    list.push({ pid: Number(pid), name: st.slice(st.indexOf('(') + 1, close), cpu, mem: rss });
  }
  procPrev = cur;
  list.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  const top = list.slice(0, PROC_TOP);
  // argv0's base, fuller than comm's 15 characters
  for (const p of top) {
    const cmd = read(`/proc/${p.pid}/cmdline`).split('\0').filter(Boolean);
    if (cmd.length) { p.cmd = cmd.join(' ').slice(0, 300); p.name = path.basename(cmd[0]) || p.name; }
  }
  procs = { count: list.length, top };
}

// --- own sampler -----------------------------------------------------------

let hooks = { self: () => ({}), peers: () => new Map() };
// own browsers and peers alike, the sampler idle without any
const listeners = new Set();
let prev = null;
let latest = null;
let timer = null;

function sample() {
  const now = Date.now();
  const cur = { at: now, cpu: cpuTimes(), net: netBytes(), disk: diskBytes() };
  const last = prev;
  prev = cur;
  if (!last || !cur.cpu.length) return null;
  const secs = (now - last.at) / 1000;
  const pct = (a, b) => (b && a.total > b.total ? Math.round(1000 * (1 - (a.idle - b.idle) / (a.total - b.total))) / 10 : 0);
  const rate = (a, b) => (b !== undefined && a >= b ? Math.round((a - b) / secs) : 0);
  const cpus = cur.cpu.map((c, i) => pct(c, last.cpu[i]));
  const [l1, l5, l15] = read('/proc/loadavg').split(' ').map(Number);
  refreshDocker();
  refreshProcs(now);
  return {
    ...hooks.self(), at: now,
    cpu: { total: cpus[0], cores: cpus.slice(1), model: cpuModel(), load: [l1, l5, l15] },
    mem: memInfo(),
    net: Object.entries(cur.net).map(([name, v]) => ({
      name, rx: rate(v.rx, last.net[name]?.rx), tx: rate(v.tx, last.net[name]?.tx),
    })),
    netDay: netDayTotals(),
    io: { r: rate(cur.disk.r, last.disk.r), w: rate(cur.disk.w, last.disk.w) },
    disk: disk(),
    gpus: gpus(),
    uptime: Math.round(Number(read('/proc/uptime').split(' ')[0]) || os.uptime()),
    containers,
    procs,
  };
}

function tick() {
  latest = sample();
  if (!latest) return;
  const text = JSON.stringify(latest);
  for (const fn of listeners) fn(text);
}

function listen(fn) {
  listeners.add(fn);
  if (!timer) { tick(); timer = setInterval(tick, SAMPLE_MS); }
  if (latest) fn(JSON.stringify(latest));
  return () => {
    listeners.delete(fn);
    if (listeners.size || !timer) return;
    clearInterval(timer);
    timer = null;
    prev = null;
    latest = null;
    procPrev = new Map();
    procAt = 0;
    procs = null;
  };
}

// --- peers fanned in ------------------------------------------------------

// host -> {ws, retry}, open only while a browser watches here
const peers = new Map();
// host -> its last sample text, for a browser arriving late
const peerLatest = new Map();
const browsers = new Set();
let reconcileTimer = null;

function toBrowsers(text) {
  for (const b of browsers) if (b.readyState === WebSocket.OPEN) b.send(text);
}

function dialPeer(host, ip) {
  const p = { ws: null, retry: null, ip };
  peers.set(host, p);
  const open = () => {
    const ws = new WebSocket(`ws://${ip}:${FRONTEND_PORT}/api/stats?own`, { handshakeTimeout: 3000 });
    p.ws = ws;
    ws.on('message', (data) => {
      const text = data.toString();
      peerLatest.set(host, text);
      toBrowsers(text);
    });
    // close follows, an unheard error throwing
    ws.on('error', () => {});
    ws.on('close', () => {
      if (peers.get(host) !== p) return;
      p.retry = setTimeout(open, PEER_RETRY_MS);
    });
  };
  open();
}

function dropPeer(host) {
  const p = peers.get(host);
  if (!p) return;
  peers.delete(host);
  peerLatest.delete(host);
  clearTimeout(p.retry);
  p.ws?.terminate();
}

// phosphorus hosts only, redialed on an IP change
function reconcile() {
  const want = hooks.peers();
  for (const host of peers.keys()) if (want.get(host) !== peers.get(host).ip) dropPeer(host);
  for (const [host, ip] of want) if (!peers.has(host)) dialPeer(host, ip);
}

// a browser: own samples and every peer's, a peer: own only
function attach(ws, own) {
  const off = listen((text) => ws.readyState === WebSocket.OPEN && ws.send(text));
  ws.on('close', off);
  if (own) return;
  browsers.add(ws);
  for (const text of peerLatest.values()) ws.send(text);
  if (!reconcileTimer) { reconcile(); reconcileTimer = setInterval(reconcile, SAMPLE_MS); }
  ws.on('close', () => {
    browsers.delete(ws);
    if (browsers.size) return;
    clearInterval(reconcileTimer);
    reconcileTimer = null;
    for (const host of [...peers.keys()]) dropPeer(host);
  });
}

module.exports = { init: (h) => { hooks = { ...hooks, ...h }; }, attach };
