import {
  MODEL_ROLES,
  cssVar,
  deskApps,
  el,
  esc,
  fold,
  humanSize,
  jsonPost,
  modalOpen,
  modelRoles,
  name,
  openMenu,
  pingClass,
  plural,
  selfHost,
  steadyRtt,
} from '../app.js';

// --- status: btop for the whole mesh ----------------------------------------
// one socket to the serving host, every host's samples fanned in there, open
// only while the tab is up

const stHostsEl = document.getElementById('st-hosts');
// samples kept per host, one per dot column
const ST_HIST = 400;
// a host silent this long drawn stale
const ST_STALE_MS = 4000;

// host -> {s, at, hist: {cpu, rx, tx}, card}
const stHosts = new Map();
let stWs = null;
let stRetry = null;
let stFrame = null;
// the last /api/state, for each header's ping, git role and services
let stNet = null;
// the one host shown in full, the rest as tiles
let stOpenHost = null;

const stOpen = () => deskApps.has('status') && !document.hidden;

// opened on the first look and kept for the page's life: samples and history
// arriving while the tab is away, so coming back never a grey wait
function statusWatch(state) {
  if (state && !stNet) statusState(state);
  if (!stOpen()) return;
  if (!stWs) statusConnect();
  statusDraw();
}

// the serving host switched: the stats socket follows it
function statusReconnect() { if (stWs) statusConnect(); }

function statusConnect() {
  clearTimeout(stRetry);
  const old = stWs;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stats`);
  stWs = sock;
  stLast = Date.now();
  old?.close();
  sock.onmessage = (ev) => {
    stLast = Date.now();
    let s;
    try { s = JSON.parse(ev.data); } catch { return; }
    if (!s.host) return;
    const h = stHost(s.host);
    h.s = s;
    h.at = Date.now();
    if (s.cpu) {
      const push = (k, v) => { h.hist[k].push(v); if (h.hist[k].length > ST_HIST) h.hist[k].shift(); };
      push('cpu', s.cpu.total);
      push('rx', s.net.reduce((a, n) => a + n.rx, 0));
      push('tx', s.net.reduce((a, n) => a + n.tx, 0));
      // the gpus' mean load, 0 on a host with none reporting
      const util = (s.gpus || []).filter((g) => g.util !== null);
      if (util.length) h.gpu = true;
      push('gpu', util.length ? util.reduce((a, g) => a + g.util, 0) / util.length : 0);
    }
    statusDraw();
  };
  sock.onclose = () => {
    if (stWs !== sock) return;
    stRetry = setTimeout(statusConnect, stLast && Date.now() - stLast < 5000 ? 300 : 2000);
  };
  sock.onerror = () => sock.close();
}

// a socket gone quiet while watched: dead without a close, so opened again
// rather than left grey; every host samples each second
let stLast = 0;
const ST_QUIET_MS = 5000;
function statusAwake() {
  if (stWs && stOpen() && Date.now() - stLast > ST_QUIET_MS) statusConnect();
}
setInterval(statusAwake, 2000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) statusAwake(); });
window.addEventListener('online', () => { if (stWs) statusConnect(); });

function stHost(name) {
  let h = stHosts.get(name);
  if (!h) { h = { s: null, at: 0, hist: { cpu: [], rx: [], tx: [], gpu: [] }, card: null }; stHosts.set(name, h); }
  return h;
}

// once a frame at most, and only while shown
function statusDraw() {
  if (stFrame || !stOpen()) return;
  stFrame = requestAnimationFrame(() => { stFrame = null; statusRender(); });
}

function statusState(state) {
  stNet = state;
  statusDraw();
}

// ---- glyphs ----------------------------------------------------------------

// low to high: sage, sand, rose
const heat = (t) => (t < 0.5 ? 'st-lo' : t < 0.8 ? 'st-mid' : 'st-hi');

// a glyph's width in the view's font, ■ often from a fallback font,
// measured again once a font lands
const stCh = new Map();
document.fonts.addEventListener('loadingdone', () => stCh.clear());
function chWidth(glyph) {
  if (stCh.has(glyph)) return stCh.get(glyph);
  const probe = document.createElement('span');
  probe.className = 'st-probe';
  probe.textContent = glyph.repeat(20);
  stHostsEl.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 20;
  probe.remove();
  if (w) stCh.set(glyph, w);
  return w || 8;
}
// meter cells fitting in el past `reserve` characters of text
const meterCells = (el, reserve) => Math.max(4, Math.floor((el.clientWidth - reserve * chWidth('0')) / chWidth('■')));

// btop's bar: filled cells by heat, the rest dim
function meter(frac, cells, cls) {
  const n = Math.round(Math.max(0, Math.min(1, frac || 0)) * cells);
  let out = '';
  for (let i = 0; i < n; i++) out += `<span class="${cls || heat(i / cells)}">■</span>`;
  return `${out}<span class="st-empty">${'■'.repeat(cells - n)}</span>`;
}

// btop's braille area graph as dots on a canvas, newest on the right (real
// braille glyphs off a fallback font in most monospace faces)
const HEAT_VAR = { 'st-lo': '--sage', 'st-mid': '--sand', 'st-hi': '--rose' };
const heatVar = (t) => HEAT_VAR[heat(t)];
function dotGraph(canvas, values, max, hue, down, fine = 1) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  // two dot columns and four dot rows to a character cell, fine times more
  const px = chWidth('0') / 2 / fine;
  const cols = Math.floor(w / px);
  const rows = Math.max(1, Math.floor(h / (px * 1.4)));
  const py = h / rows;
  const colors = Array.from({ length: rows }, (_, d) => cssVar(hue(d / Math.max(1, rows - 1))));
  const v = values.slice(-cols);
  const x0 = w - v.length * px;
  v.forEach((val, i) => {
    const level = val > 0 ? Math.max(1, Math.round((Math.min(val, max) / max) * rows)) : 0;
    for (let d = 0; d < level; d++) {
      g.fillStyle = colors[d];
      const y = down ? d * py : h - (d + 1) * py;
      g.fillRect(x0 + i * px + px * 0.2, y + py * 0.2, px * 0.6, py * 0.6);
    }
  });
}

const rate = (n) => `${humanSize(n)}/s`;
const pct = (f) => `${Math.round(f * 100)}%`;

function uptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// relative: the graph's top its own recent peak so a quiet host still moves,
// one hue since height no longer means heat
const cpuTop = (v) => Math.max(5, Math.ceil(Math.max(0, ...v) * 1.15));

// quick to grow, slow to shrink, no jumping graph
function netScale(h) {
  const peak = Math.max(1024, ...h.hist.rx, ...h.hist.tx);
  h.netMax = Math.max(peak, (h.netMax || 0) * 0.98);
  return h.netMax;
}

// ---- cards -----------------------------------------------------------------

// box, title, its drawing
const ST_BOXES = [['cpu', 'cpu', drawCpu], ['mem', 'mem', drawMem], ['disk', 'disk', drawDisk], ['net', 'net', drawNet],
  ['gpu', 'gpu', drawGpu], ['ctr', 'containers', drawCtr], ['proc', 'processes', drawProc]];

// a tile of the headline numbers, clicked open to the full btop grid
function stCard(name) {
  const card = document.createElement('section');
  card.className = 'st-card';
  card.dataset.host = name;
  card.innerHTML = '<div class="st-card-head"></div><div class="st-sum"><canvas class="st-graph st-sum-cpu"></canvas>'
    + '<div class="st-sum-rows"></div><div class="st-row st-sum-netrow"><span class="st-key">net</span><span></span>'
    + '<div class="st-sum-net"><canvas class="st-graph"></canvas><canvas class="st-graph"></canvas></div></div></div><div class="st-grid"></div>';
  const grid = card.querySelector('.st-grid');
  const parts = { head: card.querySelector('.st-card-head') };
  const [cpuGraph, rows, netRow] = card.querySelector('.st-sum').children;
  parts.sum = rows;
  parts.sumCpu = cpuGraph;
  parts.sumNet = netRow.children[1];
  [parts.sumRx, parts.sumTx] = netRow.lastElementChild.children;
  card.tabIndex = 0;
  card.addEventListener('click', () => stToggle(name));
  for (const [k, t] of ST_BOXES) {
    const b = document.createElement('div');
    b.className = `st-box st-${k}`;
    b.innerHTML = `<div class="st-head">${t}</div><div class="st-body"></div>`;
    grid.appendChild(b);
    parts[k] = b.querySelector('.st-body');
    parts[`${k}Head`] = b.querySelector('.st-head');
    parts[`${k}Box`] = b;
  }
  return { card, parts };
}

const usedOf = (a, b) => `${pct(a / b).padStart(4)} <span class="st-dim">${humanSize(a)}/${humanSize(b)}</span>`;
const dotJoin = (bits) => bits.filter(Boolean).join('<span class="st-dim"> · </span>');
const hostServices = (name) => (stNet?.routes || []).filter((r) => r.host === name && r.type !== 'game');

// ---- model -----------------------------------------------------------------
// the mesh's models as the status tab shows them: nothing at all until some
// host has [model] host = true, and then only on the hosts that do

const stModel = () => stNet?.model || null;
const stModels = () => stModel()?.models || [];
const modelOf = (host) => stModels().find((x) => x.host === host) || null;
const rolesOf = (m) => (m && stModel() ? modelRoles(m, stModel()) : []);
const roleMark = (m) => (rolesOf(m).length ? rolesOf(m).join(' + ') : 'model');

// loaded, loading, downloading with its share done, else not loaded
function modelPhase(m) {
  if (m.ready) return ['st-lo', 'loaded'];
  if (m.download && m.download.total) return ['st-mid', `downloading ${pct(m.download.done / m.download.total)}`];
  if (m.loading) return ['st-mid', 'loading'];
  return ['st-hi', 'not loaded'];
}

// open: every detail, a tile: name, platform, uptime and ping only
function headLine(name, h, open) {
  const s = h.s || {};
  const dev = (stNet?.tailnet || []).find((d) => d.name === name) || {};
  const git = (stNet?.gitHosts || []).find((g) => g.host === name);
  const svc = hostServices(name);
  const rtt = steadyRtt(name);
  return dotJoin([
    `<span class="st-name${name === selfHost ? ' self' : ''}">${esc(name)}</span>`,
    esc(s.platform || dev.os || '?'),
    open && (s.version || dev.version) && `v${esc(s.version || dev.version)}`,
    open && s.uptime && `up ${uptime(s.uptime)}`,
    typeof rtt === 'number' && `<span class="mesh-stat-ping ${pingClass(rtt)}">${rtt}ms</span>`,
    open && git?.role && `<span class="st-git">git ${esc(git.role)}</span>`,
    // a host running llama-server, marked with its role on its tile as well
    modelOf(name) && `<span class="st-model-mark">${roleMark(modelOf(name))}</span>`,
    open && svc.length && plural(svc.length, 'service'),
    // a tile's whole head the click, only an open card showing its fold
    open && '<span class="st-dim">▴</span>',
  ]);
}

// key, then a value wrapped under itself rather than cut
const wrapRow = (k, v) => `<div class="st-row st-wrap"><span class="st-key">${k}</span>${v}</div>`;

// key, bar to the row's width, a right hand value
const SUM_VAL = 18;
const sumRow = (k, frac, cells, val, cls) => `<div class="st-row"><span class="st-key">${esc(k)}</span>`
  + `${meter(frac, cells, cls)} ${val}</div>`;

function drawSum(p, h) {
  const { cpu, mem, disk, gpus } = h.s;
  const rx = h.hist.rx.at(-1) || 0;
  const tx = h.hist.tx.at(-1) || 0;
  dotGraph(p.sumCpu, h.hist.cpu, cpuTop(h.hist.cpu), () => '--sage');
  const max = netScale(h);
  dotGraph(p.sumRx, h.hist.rx, max, () => '--accent');
  dotGraph(p.sumTx, h.hist.tx, max, () => '--teal', true);
  const cells = meterCells(p.sum, 8 + SUM_VAL);
  const load = gpus.filter((g) => g.util !== null);
  const gpuLoad = load.reduce((a, g) => a + g.util, 0) / Math.max(1, load.length) / 100;
  p.sum.innerHTML = [
    sumRow('cpu', cpu.total / 100, cells, `${pct(cpu.total / 100).padStart(4)} <span class="st-dim">load ${cpu.load[0].toFixed(2)}</span>`),
    sumRow('mem', mem.used / mem.total, cells, usedOf(mem.used, mem.total)),
    sumRow('disk', disk.used / disk.total, cells, usedOf(disk.used, disk.total)),
    load.length && sumRow('gpu', gpuLoad, cells, `${pct(gpuLoad).padStart(4)} <span class="st-dim">${plural(gpus.length, 'gpu')}</span>`),
  ].filter(Boolean).join('');
  p.sumNet.innerHTML = `<span class="st-rx">▼ ${rate(rx).padEnd(9)}</span> <span class="st-tx">▲ ${rate(tx).padEnd(9)}</span>`;
}

// ---- mesh summary ----------------------------------------------------------

const stTopEl = document.getElementById('st-top');
const stMeshEl = document.getElementById('st-mesh');
// bars over the cpu graph, counts over the net graph
const [stMeshA, stMeshB] = stMeshEl.querySelector('.st-mesh-grid').children;
const [stMeshBars, stMeshCpu] = stMeshA.children;
const stMeshText = stMeshB.firstElementChild;
const [stMeshRx, stMeshTx] = stMeshB.lastElementChild.children;
const stMeshHist = { max: 0 };

// every live host's history summed, newest aligned, each weighted by weight(h)
function sumHist(live, k, weight = () => 1) {
  const len = Math.max(0, ...live.map((h) => h.hist[k].length));
  return Array.from({ length: len }, (_, i) => live.reduce((a, h) => a + (h.hist[k][h.hist[k].length - len + i] || 0) * weight(h), 0));
}

function drawMeshSum(names) {
  const live = names.map((n) => stHosts.get(n)).filter((h) => h?.s?.cpu && Date.now() - h.at <= ST_STALE_MS);
  drawModelSum();
  stMeshEl.hidden = !live.length;
  if (!live.length) return;
  const sum = (f) => live.reduce((a, h) => a + (f(h.s) || 0), 0);
  const cores = sum((s) => s.cpu.cores.length);
  const cpu = sum((s) => s.cpu.total * s.cpu.cores.length) / Math.max(1, cores) / 100;
  const memU = sum((s) => s.mem.used);
  const memT = sum((s) => s.mem.total);
  const diskU = sum((s) => s.disk.used);
  const diskT = sum((s) => s.disk.total);
  const rx = live.reduce((a, h) => a + (h.hist.rx.at(-1) || 0), 0);
  const tx = live.reduce((a, h) => a + (h.hist.tx.at(-1) || 0), 0);
  const gpus = live.flatMap((h) => h.s.gpus);
  const swapU = sum((s) => s.mem.swapUsed);
  const swapT = sum((s) => s.mem.swapTotal);
  const loaded = gpus.filter((g) => g.util !== null);
  const gpuLoad = loaded.reduce((a, g) => a + g.util, 0) / Math.max(1, loaded.length) / 100;
  const vramU = gpus.reduce((a, g) => a + (g.memUsed || 0), 0);
  const vramT = gpus.reduce((a, g) => a + (g.memTotal || 0), 0);
  const ioR = sum((s) => s.io?.r);
  const ioW = sum((s) => s.io?.w);
  const load = sum((s) => s.cpu.load[0]);
  const ctr = sum((s) => s.containers?.length);
  const git = (stNet?.gitHosts || []).filter((g) => g.reachable);
  const master = git.find((g) => g.role === 'master');
  const svc = (stNet?.routes || []).filter((r) => r.type !== 'game').length;
  const off = names.length - live.length;
  const rows = [
    ['cpu', cpu, `${pct(cpu).padStart(4)} <span class="st-dim">${cores} cores</span>`],
    ['mem', memU / memT, usedOf(memU, memT)],
    swapT && ['swap', swapU / swapT, usedOf(swapU, swapT)],
    ['disk', diskU / diskT, usedOf(diskU, diskT)],
    loaded.length && ['gpu', gpuLoad, `${pct(gpuLoad).padStart(4)} <span class="st-dim">${plural(gpus.length, 'gpu')}</span>`],
    vramT && ['vram', vramU / vramT, usedOf(vramU, vramT)],
  ].filter(Boolean);
  const text = (k, v) => `<div class="st-row"><span class="st-key">${k}</span>${v}</div>`;
  const n = meterCells(stMeshBars, 8 + SUM_VAL);
  stMeshBars.innerHTML = rows.map(([k, f, v, cls]) => sumRow(k, f, n, v, cls)).join('');
  const rxs = sumHist(live, 'rx');
  const txs = sumHist(live, 'tx');
  stMeshHist.max = Math.max(1024, ...rxs, ...txs, stMeshHist.max * 0.98);
  const cpus = sumHist(live, 'cpu', (h) => h.s.cpu.cores.length / Math.max(1, cores));
  dotGraph(stMeshCpu, cpus, cpuTop(cpus), () => '--sage');
  dotGraph(stMeshRx, rxs, stMeshHist.max, () => '--accent');
  dotGraph(stMeshTx, txs, stMeshHist.max, () => '--teal', true);
  stMeshText.innerHTML = [
    text('hosts', `<span class="st-lo">${live.length} up</span>${off ? `<span class="st-dim"> · ${off} stale or waiting</span>` : ''}`),
    text('net', `<span class="st-rx">▼ ${rate(rx)}</span>  <span class="st-tx">▲ ${rate(tx)}</span>`),
    text('24h', `<span class="st-rx">▼ ${humanSize(sum((s) => s.netDay.rx))}</span>  <span class="st-tx">▲ ${humanSize(sum((s) => s.netDay.tx))}</span>`),
    text('io', `<span class="st-rx">▼ ${rate(ioR)}</span>  <span class="st-tx">▲ ${rate(ioW)}</span>`),
    text('load', `${load.toFixed(2)} <span class="st-dim">1m, all hosts</span>`),
    text('run', dotJoin([plural(svc, 'service'), plural(ctr, 'container')])),
    git.length && text('git', dotJoin([master ? `master ${esc(master.host)}` : '<span class="st-hi">no master</span>',
      git.length > 1 && `${git.filter((g) => g.role !== 'master' && g.eligible).length}/${git.length - 1} in sync`])),
  ].filter(Boolean).join('');
}

// ---- context ---------------------------------------------------------------
// the last ask against the model's context window, as claude code's /context
// draws it: a cell a hundredth of the window, each part its own hue

const CTX_CELLS = 100;
const CTX_PARTS = [['system', 'system prompt'], ['chat', 'chat'], ['ask', 'prompt'], ['reply', 'reply']];

const kTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));
const tenth = (f) => `${(f * 100).toFixed(1)}%`;

// the window's hundred cells, each part's share
function ctxCells(m) {
  const use = m.use || {};
  const parts = CTX_PARTS.map(([k, label]) => [k, label, Math.min(use[k] || 0, m.ctx)]);
  const used = Math.min(m.ctx, parts.reduce((a, [, , n]) => a + n, 0));
  const per = m.ctx / CTX_CELLS;
  // whole cells first, a part's remainder as half a cell
  const cells = [];
  for (const [k, , n] of parts) {
    for (let i = 0; i < Math.floor(n / per); i++) cells.push(`<i class="ctx-${k} full"></i>`);
    if (n % per) cells.push(`<i class="ctx-${k} half"></i>`);
  }
  cells.length = Math.min(cells.length, CTX_CELLS);
  while (cells.length < CTX_CELLS) cells.push('<i></i>');
  return { cells: cells.join(''), parts, used };
}

// one model's window as its last ask left it, nothing while it isn't loaded;
// beside the chat: the grid over its legend, the cpu and gpu to their right
function contextHtml(m) {
  if (!(m && m.ready && m.ctx)) return '';
  const { cells, parts, used } = ctxCells(m);

  const line = (cls, label, n) => `<div class="st-row"><i class="${cls}"></i> ${label.padEnd(14)}`
    + `<span class="st-dim">${kTok(n).padStart(5)} tokens (${tenth(n / m.ctx)})</span></div>`;
  const legend = [
    `<div class="st-row">${kTok(used)}/${kTok(m.ctx)} tokens (${pct(used / m.ctx)})</div>`,
    ...parts.map(([k, label, n]) => line(`ctx-${k} full`, label, n)),
    line('', 'free', m.ctx - used),
  ].join('');
  return `<div class="st-ctx"><div class="st-ctx-grid">${cells}</div><div class="st-ctx-legend">${legend}</div></div>`;
}

// the model host's cpu and, where one reports load, gpu, as the status tab's boxes
// (the chat tab's card only)
const loadKinds = (host) => ['cpu', ...(stHosts.get(host)?.gpu ? ['gpu'] : [])];
// the status tab's cpu graph for both, 0 to 100% by heat, a spin up a climb
function drawLoads(el) {
  for (const c of el.querySelectorAll('canvas[data-k]')) {
    const h = stHosts.get(c.dataset.host);
    const v = h?.hist[c.dataset.k] || [];
    // the corner card's small graphs at triple resolution
    const mini = c.closest('.st-mini');
    dotGraph(c, v, 100, heatVar, false, mini ? 3 : 1);
    const gpus = h?.s?.gpus || [];
    const vramU = gpus.reduce((a, g) => a + (g.memUsed || 0), 0);
    const vramT = gpus.reduce((a, g) => a + (g.memTotal || 0), 0);
    // the corner card's: the percentage alone
    const extra = mini ? '' : c.dataset.k === 'cpu' ? h?.s?.cpu && `<span class="st-dim"> load </span>${h.s.cpu.load[0].toFixed(2)}`
      : vramT && `<span class="st-dim"> vram </span>${humanSize(vramU)}/${humanSize(vramT)}`;
    c.nextElementSibling.innerHTML = v.length
      ? `<span class="${heat(v.at(-1) / 100)}">${v.at(-1).toFixed(1)}%</span>${extra || ''}` : '<span class="st-dim">waiting for stats</span>';
  }
}

// ---- model summary ---------------------------------------------------------
// the chimp and the orangutan, each its state, host, file and speed over its own
// context window, one block when one model holds both roles

const stModelEl = document.getElementById('st-model');
const stModelRoles = stModelEl.querySelector('.st-model-roles');
let stModelHtml = '';

function drawModelSum() {
  const blocks = [];
  for (const role of roleOrder()) {
    // off the mesh: its id alone
    const ext = stModel()?.roles?.[role]?.host === '' ? stModel().roles[role].model : '';
    const m = ext || stModels().find((x) => rolesOf(x).includes(role));
    if (!m) continue;
    const same = blocks.find((b) => b.m === m);
    if (same) same.roles.push(role);
    else blocks.push({ m, roles: [role] });
  }
  // up even empty, the place a role's model is picked
  stModelEl.hidden = false;
  drawModelPick();
  const corner = stModelEl.classList.contains('mini');
  const html = !blocks.length ? '<div class="st-dim">no model answering</div>' : blocks.map(({ m, roles }) => {
    const who = roles.join(' + ');
    if (typeof m === 'string') return `<div class="st-model-role">${wrapRow(who, dotJoin(['<span class="st-lo">api</span>', esc(m)]))}</div>`;
    const [cls, phase] = modelPhase(m);
    return `<div class="st-model-role">${wrapRow(who, dotJoin([`<span class="${cls}">${esc(phase)}</span>`,
      esc(m.host), m.ready && m.use?.tps && `${m.use.tps} tok/s`]))}`
      + (corner ? miniHtml(m) : `${m.file ? wrapRow('file', `<span class="st-dim">${esc(m.file)}</span>`) : ''}${contextHtml(m)}`)
      + (m.ready ? `<button type="button" class="st-clear" data-role="${roles[0]}" title="erase ${esc(m.host)}'s context windows">clear context</button>` : '') + '</div>';
  }).join('');
  // unchanged, untouched: no reflow a tick
  if (html !== stModelHtml) { stModelHtml = html; stModelRoles.innerHTML = html; }
  drawLoads(stModelRoles);
}

// the corner's card, the chat tab's shrunk: the grid beside small load graphs,
// its legend one line under them
function miniHtml(m) {
  if (!(m.ready && m.ctx)) return '';
  const { cells, parts, used } = ctxCells(m);
  const loads = loadKinds(m.host).map((k) => `<div class="st-mini-k"><span class="st-dim">${k}</span>`
    + `<canvas class="st-graph" data-host="${esc(m.host)}" data-k="${k}"></canvas><div class="st-row"></div></div>`).join('');
  // counts by colour alone, the names on hover
  const legend = [
    `<span>${kTok(used)}/${kTok(m.ctx)} <span class="st-dim">${pct(used / m.ctx)}</span></span>`,
    ...parts.map(([k, label, n]) => `<span title="${label}"><i class="ctx-${k} full"></i>${kTok(n)}</span>`),
    `<span title="free"><i></i>${kTok(m.ctx - used)}</span>`,
  ].join(' ');
  return `<div class="st-ctx st-mini"><div class="st-ctx-grid">${cells}</div><div class="st-mini-load">${loads}</div>`
    + `<div class="st-mini-key">${legend}</div></div>`;
}

// ---- model picker ------------------------------------------------------------
// each role's model and the providers' api keys, in the full card only; a key
// goes to this host and on over the tailnet, never shown here again

const stModelPick = stModelEl.querySelector('.st-model-pick');
const CATALOG_MS = 5 * 60 * 1000;
const CATALOG_RETRY_MS = 30000;
let catalog = null;
let catalogAt = 0;
let catalogBusy = false;
let catalogKeys = '';
let pickSig = '';
let pickError = '';

// every provider opencode knows, the models of those it can use
async function loadCatalog(force) {
  if (catalogBusy || (!force && Date.now() - catalogAt < CATALOG_MS)) return;
  catalogBusy = true;
  try {
    const r = await fetch('/api/model/catalog');
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `status ${r.status}`);
    catalog = body;
    catalogAt = Date.now();
    if (pickError.startsWith('no catalog')) pickError = '';
  } catch (err) {
    pickError = `no catalog: ${err.message}`;
    catalogAt = Date.now() - CATALOG_MS + CATALOG_RETRY_MS;
  }
  catalogBusy = false;
  drawModelPick();
}

// every model a role can take, by provider, the mesh's own first; a role's
// choice kept listed though its provider's key is gone
function modelGroups(model) {
  const groups = [{ id: 'phosphorus', name: 'mesh', models: stModels().map((m) => ({ id: `phosphorus/${m.host}`, name: m.file ? `${m.host} · ${m.file}` : m.host })) }];
  for (const p of catalog || []) {
    if (p.id !== 'phosphorus' && p.models.length) groups.push({ id: p.id, name: p.id, models: p.models.map((m) => ({ id: `${p.id}/${m.id}`, name: m.name.toLowerCase() })) });
  }
  for (const r of MODEL_ROLES) {
    const id = model.roles?.[r]?.chosen;
    if (!id || groups.some((g) => g.models.some((m) => m.id === id))) continue;
    const p = id.slice(0, id.indexOf('/'));
    const g = groups.find((x) => x.id === p) || groups[groups.push({ id: p, name: p, models: [] }) - 1];
    g.models.push({ id, name: id.slice(p.length + 1) });
  }
  return groups.filter((g) => g.models.length);
}

// a long model name cut short, whole on hover, so no pick widens the card
const MODEL_LABEL_MAX = 28;
const clipLabel = (t) => (t.length > MODEL_LABEL_MAX ? `${t.slice(0, MODEL_LABEL_MAX - 1)}…` : t);
const option = (value, label, on) => `<option value="${esc(value)}"${label.length > MODEL_LABEL_MAX ? ` title="${esc(label)}"` : ''}${on ? ' selected' : ''}>${esc(clipLabel(label))}</option>`;
const roleOrder = () => MODEL_ROLES;

// the keys' list folded away until asked for
let keysOpen = false;

function drawModelPick() {
  const model = stModel();
  stModelPick.hidden = stModelEl.classList.contains('mini') || !model;
  if (stModelPick.hidden) return;
  // a key set or cleared anywhere: the providers' models listed again
  const keySig = JSON.stringify(model.keys || []);
  loadCatalog(keySig !== catalogKeys);
  catalogKeys = keySig;
  // never redrawn under a typing hand
  if (stModelPick.contains(document.activeElement)) return;
  const groups = modelGroups(model);
  const providers = (catalog || []).filter((p) => p.id !== 'phosphorus');
  const keys = model.keys || [];
  const order = roleOrder();
  const sig = JSON.stringify([model.roles, keys, groups, providers.map((p) => p.id), pickError, keysOpen, order]);
  if (sig === pickSig) return;
  pickSig = sig;
  const roles = order.map((r) => {
    const x = model.roles?.[r] || {};
    const fallback = `mesh default${x.chosen ? '' : x.model ? `: ${x.model}` : ', none loaded'}`;
    return `<div class="st-pick-row"><span class="st-key">${r}</span><select class="st-pick-in" data-role="${r}" aria-label="${r} model">`
      + option('', fallback, !x.chosen)
      + groups.map((g) => `<optgroup label="${esc(g.name)}">${g.models.map((m) => option(m.id, m.name, m.id === x.chosen)).join('')}</optgroup>`).join('')
      + '</select></div>'
      + (x.ready || !x.why ? '' : `<div class="st-pick-row st-pick-why">${esc(x.why)}</div>`);
  }).join('');
  const fold = `<div class="st-pick-row"><span class="st-key">keys</span><button type="button" class="st-pick-fold" data-fold aria-expanded="${keysOpen}">`
    + `${keys.length ? `${keys.length} set` : 'none set'} <span class="st-dim">${keysOpen ? '▾' : '▸'}</span></button></div>`;
  // a plain field drawn masked: no password manager offering to fill or save it
  const open = !keysOpen ? '' : '<div class="st-pick-keys">'
    + keys.map((p) => `<div class="st-pick-row"><span class="st-pick-key">${esc(p)}</span>`
      + `<button type="button" class="st-pick-btn" data-clear="${esc(p)}" title="forget ${esc(p)}'s key">clear</button></div>`).join('')
    + '<div class="st-pick-row"><select class="st-pick-in st-pick-provider" aria-label="provider">'
    + `<option value="" disabled selected>provider</option>${providers.map((p) => option(p.id, p.id)).join('')}</select>`
    + '<input class="st-pick-in st-pick-secret" type="text" name="phosphorus-provider-key" placeholder="api key" autocomplete="off" '
    + 'autocorrect="off" autocapitalize="off" spellcheck="false" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other" aria-label="api key">'
    + '<button type="button" class="st-pick-btn" data-save>save</button></div></div>';
  stModelPick.innerHTML = roles + fold + open + (pickError ? `<div class="st-pick-row st-pick-err">${esc(pickError)}</div>` : '');
}

// shown at once on success, the next poll bringing the mesh's own
async function pickPost(url, body, shown) {
  try {
    const r = await fetch(url, jsonPost(body));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `status ${r.status}`);
    pickError = '';
    if (stModel()) shown(stModel());
    return true;
  } catch (err) {
    pickError = err.message;
    return false;
  } finally {
    pickSig = '';
    drawModelPick();
  }
}

function saveKey() {
  const provider = stModelPick.querySelector('.st-pick-provider');
  const secret = stModelPick.querySelector('.st-pick-secret');
  if (!provider.value || !secret.value.trim()) { pickError = 'a provider and its key'; pickSig = ''; drawModelPick(); return; }
  const body = { provider: provider.value, key: secret.value.trim() };
  secret.value = '';
  document.activeElement?.blur();
  pickPost('/api/model/key', body, (m) => { m.keys = [...new Set([...(m.keys || []), body.provider])].sort(); })
    .then((ok) => { if (ok) loadCatalog(true); });
}

// a role's model set once picked
stModelPick.addEventListener('change', (e) => {
  const role = e.target.dataset?.role;
  const model = e.target.value;
  if (role) pickPost('/api/model/role', { role, model }, (m) => { if (m.roles?.[role]) m.roles[role].chosen = model; });
});
stModelPick.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('st-pick-secret')) saveKey();
});
stModelPick.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const p = b.dataset.clear;
  if (p) pickPost('/api/model/key', { provider: p, key: '' }, (m) => { m.keys = (m.keys || []).filter((k) => k !== p); }).then((ok) => { if (ok) loadCatalog(true); });
  else if ('save' in b.dataset) saveKey();
  else if ('fold' in b.dataset) {
    keysOpen = !keysOpen;
    pickSig = '';
    b.blur();
    drawModelPick();
    if (keysOpen) stModelPick.querySelector('.st-pick-provider')?.focus();
  }
});
stModelPick.addEventListener('focusout', () => setTimeout(() => { if (!stModelPick.contains(document.activeElement)) drawModelPick(); }));

// tile widths in rem: the narrowest still legible, the widest before another column
const ST_TILE_MIN = 15;
const ST_TILE_MAX = 21;
// px, the tiles' cpu graph, shrunk toward the min only to spare a scroll, never grown past the max
const ST_GRAPH_MIN = 12;
const ST_GRAPH_MAX = 160;

// columns enough that every tile fits the view unscrolled, spare height left empty
let stFit = '';
function fitTiles(names) {
  const view = stHostsEl.parentElement;
  const tile = stHostsEl.querySelector('.st-card:not(.open):not(.waiting)');
  if (!tile) return;
  // a host open: the page scrolling anyway, the rest kept compact
  if (stOpenHost) {
    stFit = '';
    stHostsEl.style.setProperty('--st-sum-graph', `${ST_GRAPH_MAX}px`);
    return;
  }
  const css = getComputedStyle(stHostsEl);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const colGap = parseFloat(css.columnGap) || 0;
  const rowGap = parseFloat(css.rowGap) || 0;
  const vs = getComputedStyle(view);
  const avail = view.clientHeight - parseFloat(vs.paddingTop) - parseFloat(vs.paddingBottom)
    - (stMeshEl.hidden && stModelEl.hidden ? 0 : stTopEl.offsetHeight + parseFloat(getComputedStyle(stTopEl).marginBottom));
  const width = stHostsEl.clientWidth;
  const graph = tile.querySelector('.st-sum-cpu');
  const base = tile.offsetHeight - graph.offsetHeight;
  const fits = (w) => Math.max(1, Math.floor((width + colGap) / (w * rem + colGap)));
  const rowsFit = Math.max(1, Math.floor((avail + rowGap) / (base + ST_GRAPH_MIN + rowGap)));
  const most = Math.min(names.length, fits(ST_TILE_MIN), Math.max(fits(ST_TILE_MAX), Math.ceil(names.length / rowsFit)));
  const rows = Math.ceil(names.length / most);
  // rows evened out: 4 hosts as 2 by 2, never 3 and a lone 1
  const cols = Math.ceil(names.length / rows);
  // the rows not fitting even at their smallest (a phone): scrolling anyway, so no shrinking
  const h = rows * (base + ST_GRAPH_MIN + rowGap) - rowGap > avail ? ST_GRAPH_MAX / 2
    : Math.round(Math.max(ST_GRAPH_MIN, Math.min(ST_GRAPH_MAX, (avail - rowGap * (rows - 1)) / rows - base)));
  const fit = `${cols}/${h}`;
  if (fit === stFit) return;
  stFit = fit;
  stHostsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  stHostsEl.style.setProperty('--st-sum-graph', `${h}px`);
  statusDraw();
}

function drawCpu(p, h) {
  const { cpu } = h.s;
  p.cpuHead.innerHTML = `cpu <span class="st-dim">${esc(cpu.model.replace(/\s+/g, ' ').toLowerCase())}</span>`;
  if (!p.cpuGraph) {
    p.cpu.innerHTML = '<div class="st-cpu-left"><canvas class="st-graph st-graph-cpu"></canvas><div class="st-row"></div></div><div class="st-cores"></div>';
    [p.cpuGraph, p.cpuLine] = p.cpu.firstElementChild.children;
    p.cores = p.cpu.lastElementChild;
  }
  dotGraph(p.cpuGraph, h.hist.cpu, 100, heatVar);
  p.cpuLine.innerHTML = `<span class="${heat(cpu.total / 100)}">${cpu.total.toFixed(1)}%</span>`
    + `<span class="st-dim"> load </span>${cpu.load.map((l) => l.toFixed(2)).join(' ')}`;
  p.cores.innerHTML = cpu.cores.map((c, i) => `<div><span class="st-dim">${String(i).padStart(2)}</span> `
    + `${meter(c / 100, 4)} ${String(Math.round(c)).padStart(3)}%</div>`).join('');
}

// label, value, bar to the box's width, percent
const barRow = (k, text, frac, cells, cls) => `<div class="st-row"><span class="st-key">${esc(k)}</span>`
  + `${text.padStart(6)} ${meter(frac, cells, cls)} ${pct(frac).padStart(4)}</div>`;

function barRows(el, rows) {
  const cells = meterCells(el, 20);
  el.innerHTML = rows.map(([k, v, of, cls]) => barRow(k, humanSize(v), v / of, cells, cls)).join('');
}

function drawMem(p, h) {
  const m = h.s.mem;
  p.memHead.innerHTML = `mem <span class="st-dim">${humanSize(m.total)}</span>`;
  barRows(p.mem, [
    ['used', m.used, m.total], ['avail', m.avail, m.total, 'st-lo'], ['cached', m.cached, m.total, 'st-cache'],
    m.swapTotal && ['swap', m.swapUsed, m.swapTotal],
  ].filter(Boolean));
}

// the host's own disks, summed, docker's never among them
function drawDisk(p, h) {
  const { disk, io } = h.s;
  const n = disk.count > 1 ? ` · ${disk.count} filesystems` : '';
  p.diskHead.innerHTML = `disk <span class="st-dim">${humanSize(disk.total)} capacity${n}</span>`;
  barRows(p.disk, [['used', disk.used, disk.total], ['free', disk.total - disk.used, disk.total, 'st-lo']]);
  p.disk.insertAdjacentHTML('beforeend', `<div class="st-row"><span class="st-key">io</span>`
    + `<span class="st-rx">r ${rate(io.r)}</span>  <span class="st-tx">w ${rate(io.w)}</span></div>`);
}

function drawNet(p, h) {
  const rx = h.hist.rx.at(-1) || 0;
  const tx = h.hist.tx.at(-1) || 0;
  const busy = h.s.net.filter((n) => n.rx || n.tx);
  p.netHead.innerHTML = `net <span class="st-dim">${esc((busy.length ? busy : h.s.net).map((n) => n.name).join(' '))}</span>`;
  if (!p.rxGraph) {
    p.net.innerHTML = '<canvas class="st-graph"></canvas><div class="st-row"></div><canvas class="st-graph"></canvas><div class="st-row"></div>';
    [p.rxGraph, p.rates, p.txGraph, p.day] = p.net.children;
  }
  const max = netScale(h);
  dotGraph(p.rxGraph, h.hist.rx, max, () => '--accent');
  dotGraph(p.txGraph, h.hist.tx, max, () => '--teal', true);
  p.rates.innerHTML = `<span class="st-rx">▼ ${rate(rx)}</span>  <span class="st-tx">▲ ${rate(tx)}</span>`
    + `<span class="st-dim">  top ${rate(max)}</span>`;
  // a day, or as much of one as has been counted
  const d = h.s.netDay;
  const ms = h.s.at - d.since;
  const span = ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : `${Math.min(24, Math.round(ms / 3600000))}h`;
  p.day.innerHTML = `<span class="st-key">${span}</span><span class="st-rx">▼ ${humanSize(d.rx)}</span>`
    + `  <span class="st-tx">▲ ${humanSize(d.tx)}</span>`;
}

function drawGpu(p, h) {
  const list = h.s.gpus;
  p.gpuHead.innerHTML = `gpu <span class="st-dim">${esc(list.map((g) => g.name).join(', '))}</span>`;
  const cells = meterCells(p.gpu, 20);
  p.gpu.innerHTML = list.map((g) => {
    const rows = [];
    if (list.length > 1) rows.push(`<div class="st-row st-dim">${esc(g.name)}</div>`);
    if (g.util !== null) rows.push(barRow('load', `${g.util}%`, g.util / 100, cells));
    else if (g.mhz && g.mhzMax) rows.push(barRow('clock', `${g.mhz}mhz`, g.mhz / g.mhzMax, cells));
    if (g.memTotal) rows.push(barRow('vram', humanSize(g.memUsed), g.memUsed / g.memTotal, cells));
    if (g.temp !== null) {
      rows.push(`<div class="st-row"><span class="st-key">temp</span><span class="${heat((g.temp - 40) / 50)}">${g.temp}°c</span></div>`);
    }
    return rows.join('') || '<div class="st-dim">no readings</div>';
  }).join('');
}

function drawCtr(p, h) {
  const list = h.s.containers;
  // natively phosphorus's own processes by role, else its containers
  const vm = !h.s.native && h.s.platform && h.s.platform !== 'linux' ? ' · docker vm' : '';
  p.ctrHead.innerHTML = `${h.s.native ? 'phosphorus' : 'containers'} <span class="st-dim">${list ? list.length : ''}${vm}</span>`;
  if (!list) { p.ctr.innerHTML = '<div class="st-dim">no docker access</div>'; return; }
  p.ctr.innerHTML = '<div class="st-ctr-row st-dim"><span>name</span><span>cpu</span><span>mem</span><span>pids</span></div>'
    + list.map((c) => `<div class="st-ctr-row"><span class="st-ctr-name">${esc(c.name)}</span>`
      + `<span class="${heat(c.cpu / 100)}">${c.cpu.toFixed(1)}%</span><span>${humanSize(c.mem)}</span>`
      + `<span class="st-dim">${c.pids}</span></div>`).join('');
}

function drawProc(p, h) {
  const pr = h.s.procs;
  const vm = !h.s.native && h.s.platform && h.s.platform !== 'linux' ? ' · docker vm' : '';
  p.procHead.innerHTML = `processes <span class="st-dim">${pr ? pr.count : ''}${vm}</span>`;
  if (!pr) { p.proc.innerHTML = '<div class="st-dim">no process list</div>'; return; }
  p.proc.innerHTML = '<div class="st-proc-row st-dim"><span>name</span><span>pid</span><span>cpu</span><span>mem</span></div>'
    + pr.top.map((x) => `<div class="st-proc-row"${x.cmd ? ` title="${esc(x.cmd)}"` : ''}>`
      + `<span class="st-ctr-name">${esc(x.name)}${x.role ? ` <span class="st-dim">${esc(x.role)}</span>` : ''}</span><span class="st-dim">${x.pid}</span>`
      + `<span class="${heat(x.cpu / 100)}">${x.cpu.toFixed(1)}%</span><span>${humanSize(x.mem)}</span></div>`).join('');
}

// self first, then by name, hosts gone from the mesh dropped
function statusRender() {
  const live = stNet ? stNet.tailnet.filter((d) => d.phosphorus).map((d) => d.name) : [...stHosts.keys()];
  const names = [...new Set(live)].sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b));
  for (const [name, h] of stHosts) if (!names.includes(name)) { h.card?.card.remove(); stHosts.delete(name); }
  if (!names.includes(stOpenHost)) stOpenHost = null;
  if (names.length) stHostsEl.querySelector('.st-wait')?.remove();
  drawMeshSum(names);
  let prev = null;
  for (const name of names) {
    const h = stHost(name);
    h.card ||= stCard(name);
    const { card, parts } = h.card;
    if (card.parentNode !== stHostsEl || card.previousElementSibling !== prev) {
      if (prev) prev.after(card); else stHostsEl.prepend(card);
    }
    prev = card;
    const open = name === stOpenHost;
    card.classList.toggle('open', open);
    parts.head.innerHTML = headLine(name, h, open);
    card.classList.toggle('stale', !!h.s?.cpu && Date.now() - h.at > ST_STALE_MS);
    card.classList.toggle('waiting', !h.s?.cpu);
    if (!h.s?.cpu) {
      card.dataset.note = 'waiting for stats';
      continue;
    }
    if (!open) { drawSum(parts, h); continue; }
    // no gpu, no gpu box
    for (const [k, , draw] of ST_BOXES) {
      const box = parts[`${k}Box`];
      box.hidden = k === 'gpu' && !h.s.gpus.length;
      if (!box.hidden) draw(parts, h);
    }
  }
  stHostsEl.classList.toggle('has-open', !!stOpenHost);
  fitTiles(names);
}

// one host open at a time, the opened or closed one keeping the arrow keys' pick
function stToggle(name) {
  stOpenHost = stOpenHost === name ? null : name;
  statusRender();
  const card = stHosts.get(name)?.card?.card;
  card?.focus({ preventScroll: true });
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.shiftKey && stOpenHost && stOpen() && !modalOpen() && !openMenu()) stToggle(stOpenHost);
});

// a quiet peer's stale mark, with no message to trigger it
setInterval(() => { if (stWs) statusDraw(); }, 2000);
window.addEventListener('resize', statusDraw);
document.addEventListener('visibilitychange', statusWatch);


export { statusDraw, statusReconnect, statusState, statusWatch };
