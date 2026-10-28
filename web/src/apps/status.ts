import { cssVar, modalOpen } from '../dom.ts';
import { pingClass, steadyRtt } from '../mesh.ts';
import { deskApps, st } from '../state.ts';
import type { ModelHost, State, StatsSample } from '../types.ts';
import { esc, humanSize, plural } from '../util.ts';

// --- status: btop for the whole mesh ----------------------------------------
// one socket to the serving host, every host's samples fanned in there, open
// only while the tab is up

const stHostsEl = document.getElementById('st-hosts')!;
// samples kept per host, one per dot column
const ST_HIST = 400;
// a host silent this long drawn stale
const ST_STALE_MS = 4000;

// a card's elements: the parts drawn into, by box name and a few extras
type Parts = Record<string, any> & { head: HTMLElement; chip: HTMLElement; chipHtml: string; sum: HTMLElement; sumCpu: HTMLCanvasElement; sumNet: HTMLElement; sumRx: HTMLCanvasElement; sumTx: HTMLCanvasElement };
// host -> {s, at, hist: {cpu, rx, tx}, card}
interface StHost { s: StatsSample | null; at: number; hist: Record<string, number[]>; card: { card: HTMLElement; parts: Parts } | null; gpu?: boolean; netMax?: number }
const stHosts = new Map<string, StHost>();
let stWs: WebSocket | null = null;
let stRetry: ReturnType<typeof setTimeout> | null = null;
let stFrame: number | null = null;
// the last /api/state, for each header's ping, git role and services
let stNet: State | null = null;
// the one host shown in full, the rest as tiles
let stOpenHost: string | null = null;

const stOpen = () => deskApps.has('status') && !document.hidden;

// opened on the first look and kept for the page's life: samples and history
// arriving while the tab is away, so coming back never a grey wait
function statusWatch(state?: State | null): void {
  if (state && !stNet) statusState(state);
  if (!stOpen()) return;
  if (!stWs) statusConnect();
  statusDraw();
}

// the serving host switched: the stats socket follows it
function statusReconnect(): void { if (stWs) statusConnect(); }

function statusConnect() {
  clearTimeout(stRetry!);
  const old = stWs;
  const sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/stats`);
  stWs = sock;
  stLast = Date.now();
  old?.close();
  sock.onmessage = (ev) => {
    stLast = Date.now();
    let s: StatsSample;
    try { s = JSON.parse(ev.data); } catch { return; }
    if (!s.host) return;
    const h = stHost(s.host);
    h.s = s;
    h.at = Date.now();
    if (s.cpu) {
      const push = (k: string, v: number) => { h.hist[k]!.push(v); if (h.hist[k]!.length > ST_HIST) h.hist[k]!.shift(); };
      push('cpu', s.cpu.total);
      push('rx', s.net.reduce((a, n) => a + n.rx, 0));
      push('tx', s.net.reduce((a, n) => a + n.tx, 0));
      // the gpus' mean load, 0 on a host with none reporting
      const util = (s.gpus || []).filter((g) => g.util !== null);
      if (util.length) h.gpu = true;
      push('gpu', util.length ? util.reduce((a, g) => a + g.util!, 0) / util.length : 0);
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

function stHost(name: string): StHost {
  let h = stHosts.get(name);
  if (!h) { h = { s: null, at: 0, hist: { cpu: [], rx: [], tx: [], gpu: [] }, card: null }; stHosts.set(name, h); }
  return h;
}

// once a frame at most, and only while shown
function statusDraw(): void {
  if (stFrame || !stOpen()) return;
  stFrame = requestAnimationFrame(() => { stFrame = null; statusRender(); });
}

function statusState(state: State): void {
  stNet = state;
  statusDraw();
}

// ---- glyphs ----------------------------------------------------------------

// low to high: sage, sand, rose
const heat = (t: number) => (t < 0.5 ? 'st-lo' : t < 0.8 ? 'st-mid' : 'st-hi');

// a glyph's width in the view's font, ■ often from a fallback font,
// measured again once a font lands
const stCh = new Map<string, number>();
document.fonts.addEventListener('loadingdone', () => stCh.clear());
function chWidth(glyph: string): number {
  if (stCh.has(glyph)) return stCh.get(glyph)!;
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
const meterCells = (el: HTMLElement, reserve: number) => Math.max(4, Math.floor((el.clientWidth - reserve * chWidth('0')) / chWidth('■')));

// btop's bar: filled cells by heat, the rest dim
function meter(frac: number, cells: number, cls?: string): string {
  const n = Math.round(Math.max(0, Math.min(1, frac || 0)) * cells);
  let out = '';
  for (let i = 0; i < n; i++) out += `<span class="${cls || heat(i / cells)}">■</span>`;
  return `${out}<span class="st-empty">${'■'.repeat(cells - n)}</span>`;
}

// btop's braille area graph as dots on a canvas, newest on the right (real
// braille glyphs off a fallback font in most monospace faces)
const HEAT_VAR: Record<string, string> = { 'st-lo': '--sage', 'st-mid': '--sand', 'st-hi': '--rose' };
const heatVar = (t: number) => HEAT_VAR[heat(t)]!;
function dotGraph(canvas: HTMLCanvasElement, values: number[], max: number, hue: (t: number) => string, down?: boolean, fine = 1) {
  const dpr = devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d')!;
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
      g.fillStyle = colors[d]!;
      const y = down ? d * py : h - (d + 1) * py;
      g.fillRect(x0 + i * px + px * 0.2, y + py * 0.2, px * 0.6, py * 0.6);
    }
  });
}

const rate = (n: number) => `${humanSize(n)}/s`;
const pct = (f: number) => `${Math.round(f * 100)}%`;

function uptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

// relative: the graph's top its own recent peak so a quiet host still moves,
// one hue since height no longer means heat
const cpuTop = (v: number[]) => Math.max(5, Math.ceil(Math.max(0, ...v) * 1.15));

// quick to grow, slow to shrink, no jumping graph
function netScale(h: StHost): number {
  const peak = Math.max(1024, ...h.hist.rx!, ...h.hist.tx!);
  h.netMax = Math.max(peak, (h.netMax || 0) * 0.98);
  return h.netMax;
}

// ---- cards -----------------------------------------------------------------

// box, title, its drawing
const ST_BOXES: [string, string, (p: Parts, h: StHost) => void][] = [['cpu', 'cpu', drawCpu], ['mem', 'mem', drawMem], ['disk', 'disk', drawDisk], ['net', 'net', drawNet],
  ['gpu', 'gpu', drawGpu], ['ctr', 'phosphorus', drawCtr], ['proc', 'processes', drawProc]];

// a tile of the headline numbers, clicked open to the full btop grid
function stCard(name: string): { card: HTMLElement; parts: Parts } {
  const card = document.createElement('section');
  card.className = 'st-card';
  card.dataset.host = name;
  card.innerHTML = '<div class="st-card-head"></div><div class="st-sum"><canvas class="st-graph st-sum-cpu"></canvas>'
    + '<div class="st-sum-rows"></div><div class="st-row st-sum-netrow"><span class="st-key">net</span><span></span>'
    + '<div class="st-sum-net"><canvas class="st-graph"></canvas><canvas class="st-graph"></canvas></div></div></div><div class="st-chip" hidden></div><div class="st-grid"></div>';
  const grid = card.querySelector('.st-grid')!;
  const parts = { head: card.querySelector('.st-card-head') as HTMLElement, chip: card.querySelector('.st-chip') as HTMLElement, chipHtml: '' } as Parts;
  const [cpuGraph, rows, netRow] = card.querySelector('.st-sum')!.children as unknown as [HTMLCanvasElement, HTMLElement, HTMLElement];
  parts.sum = rows;
  parts.sumCpu = cpuGraph;
  parts.sumNet = netRow.children[1] as HTMLElement;
  [parts.sumRx, parts.sumTx] = netRow.lastElementChild!.children as unknown as [HTMLCanvasElement, HTMLCanvasElement];
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

const usedOf = (a: number, b: number) => `${pct(a / b).padStart(4)} <span class="st-dim">${humanSize(a)}/${humanSize(b)}</span>`;
const dotJoin = (bits: (string | false | number | undefined | null)[]) => bits.filter(Boolean).join('<span class="st-dim"> · </span>');
const hostServices = (name: string) => (stNet?.routes || []).filter((r) => r.host === name && r.type !== 'game');

// ---- model -----------------------------------------------------------------
// the mesh's models as the status tab shows them: nothing at all until some
// host has [model] host = true, and then only on the hosts that do

const stModel = () => stNet?.model || null;
const stModels = () => stModel()?.models || [];
const modelOf = (host: string) => stModels().find((x) => x.host === host) || null;

// loaded, loading, downloading with its share done, else not loaded
function modelPhase(m: ModelHost): [string, string] {
  if (m.ready) return ['st-lo', 'loaded'];
  if (m.download && m.download.total) return ['st-mid', `downloading ${pct(m.download.done / m.download.total)}`];
  if (m.loading) return ['st-mid', 'loading'];
  return ['st-hi', 'not loaded'];
}

// open: every detail, a tile: name, platform, uptime and ping only
function headLine(name: string, h: StHost, open: boolean): string {
  const s: Partial<StatsSample> = h.s || {};
  const dev = (stNet?.tailnet || []).find((d) => d.name === name) || {} as { os?: string; version?: string };
  const git = (stNet?.gitHosts || []).find((g) => g.host === name);
  const svc = hostServices(name);
  const rtt = steadyRtt(name);
  return dotJoin([
    `<span class="st-name${name === st.selfHost ? ' self' : ''}">${esc(name)}</span>`,
    esc(s.platform || dev.os || '?'),
    open && (s.version || dev.version) && `v${esc(s.version || dev.version)}`,
    open && s.uptime && `up ${uptime(s.uptime)}`,
    typeof rtt === 'number' && `<span class="mesh-stat-ping ${pingClass(rtt)}">${rtt}ms</span>`,
    open && git?.role && `<span class="st-git">git ${esc(git.role)}</span>`,
    modelOf(name) && '<span class="st-model-mark">model</span>',
    open && svc.length && plural(svc.length, 'service'),
    // a tile's whole head the click, only an open card showing its fold
    open && '<span class="st-dim">▴</span>',
  ]);
}

// key, then a value wrapped under itself rather than cut
const wrapRow = (k: string, v: string) => `<div class="st-row st-wrap"><span class="st-key">${k}</span>${v}</div>`;

// key, bar to the row's width, a right hand value
const SUM_VAL = 18;
const sumRow = (k: string, frac: number, cells: number, val: string, cls?: string) => `<div class="st-row"><span class="st-key">${esc(k)}</span>`
  + `${meter(frac, cells, cls)} ${val}</div>`;

function drawSum(p: Parts, h: StHost) {
  const { cpu, mem, disk, gpus } = h.s!;
  const rx = h.hist.rx!.at(-1) || 0;
  const tx = h.hist.tx!.at(-1) || 0;
  dotGraph(p.sumCpu, h.hist.cpu!, cpuTop(h.hist.cpu!), () => '--sage');
  const max = netScale(h);
  dotGraph(p.sumRx, h.hist.rx!, max, () => '--accent');
  dotGraph(p.sumTx, h.hist.tx!, max, () => '--teal', true);
  const cells = meterCells(p.sum, 8 + SUM_VAL);
  const load = gpus.filter((g) => g.util !== null);
  const gpuLoad = load.reduce((a, g) => a + g.util!, 0) / Math.max(1, load.length) / 100;
  p.sum.innerHTML = [
    sumRow('cpu', cpu.total / 100, cells, `${pct(cpu.total / 100).padStart(4)} <span class="st-dim">load ${cpu.load[0]!.toFixed(2)}</span>`),
    sumRow('mem', mem.used / mem.total, cells, usedOf(mem.used, mem.total)),
    sumRow('disk', disk.used / disk.total, cells, usedOf(disk.used, disk.total)),
    load.length && sumRow('gpu', gpuLoad, cells, `${pct(gpuLoad).padStart(4)} <span class="st-dim">${plural(gpus.length, 'gpu')}</span>`),
  ].filter(Boolean).join('');
  p.sumNet.innerHTML = `<span class="st-rx">▼ ${rate(rx).padEnd(9)}</span> <span class="st-tx">▲ ${rate(tx).padEnd(9)}</span>`;
}

// ---- mesh summary ----------------------------------------------------------

const stTopEl = document.getElementById('st-top')!;
const stMeshEl = document.getElementById('st-mesh')!;
// bars over the cpu graph, counts over the net graph
const [stMeshA, stMeshB] = stMeshEl.querySelector('.st-mesh-grid')!.children as unknown as [HTMLElement, HTMLElement];
const [stMeshBars, stMeshCpu] = stMeshA.children as unknown as [HTMLElement, HTMLCanvasElement];
const stMeshText = stMeshB.firstElementChild as HTMLElement;
const [stMeshRx, stMeshTx] = stMeshB.lastElementChild!.children as unknown as [HTMLCanvasElement, HTMLCanvasElement];
const stMeshHist = { max: 0 };

// every live host's history summed, newest aligned, each weighted by weight(h)
function sumHist(live: StHost[], k: string, weight: (h: StHost) => number = () => 1): number[] {
  const len = Math.max(0, ...live.map((h) => h.hist[k]!.length));
  return Array.from({ length: len }, (_, i) => live.reduce((a, h) => a + (h.hist[k]![h.hist[k]!.length - len + i] || 0) * weight(h), 0));
}

function drawMeshSum(names: string[]) {
  const live = names.map((n) => stHosts.get(n)).filter((h): h is StHost => !!h?.s?.cpu && Date.now() - h.at <= ST_STALE_MS);
  stMeshEl.hidden = !live.length;
  if (!live.length) return;
  const sum = (f: (s: StatsSample) => number | undefined) => live.reduce((a, h) => a + (f(h.s!) || 0), 0);
  const cores = sum((s) => s.cpu.cores.length);
  const cpu = sum((s) => s.cpu.total * s.cpu.cores.length) / Math.max(1, cores) / 100;
  const memU = sum((s) => s.mem.used);
  const memT = sum((s) => s.mem.total);
  const diskU = sum((s) => s.disk.used);
  const diskT = sum((s) => s.disk.total);
  const rx = live.reduce((a, h) => a + (h.hist.rx!.at(-1) || 0), 0);
  const tx = live.reduce((a, h) => a + (h.hist.tx!.at(-1) || 0), 0);
  const gpus = live.flatMap((h) => h.s!.gpus);
  const swapU = sum((s) => s.mem.swapUsed);
  const swapT = sum((s) => s.mem.swapTotal);
  const loaded = gpus.filter((g) => g.util !== null);
  const gpuLoad = loaded.reduce((a, g) => a + g.util!, 0) / Math.max(1, loaded.length) / 100;
  const vramU = gpus.reduce((a, g) => a + (g.memUsed || 0), 0);
  const vramT = gpus.reduce((a, g) => a + (g.memTotal || 0), 0);
  const ioR = sum((s) => s.io?.r);
  const ioW = sum((s) => s.io?.w);
  const load = sum((s) => s.cpu.load[0]);
  const ctr = sum((s) => s.parts?.length);
  const git = (stNet?.gitHosts || []).filter((g) => g.reachable);
  const master = git.find((g) => g.role === 'master');
  const svc = (stNet?.routes || []).filter((r) => r.type !== 'game').length;
  const off = names.length - live.length;
  const rows = ([
    ['cpu', cpu, `${pct(cpu).padStart(4)} <span class="st-dim">${cores} cores</span>`],
    ['mem', memU / memT, usedOf(memU, memT)],
    swapT && ['swap', swapU / swapT, usedOf(swapU, swapT)],
    ['disk', diskU / diskT, usedOf(diskU, diskT)],
    loaded.length && ['gpu', gpuLoad, `${pct(gpuLoad).padStart(4)} <span class="st-dim">${plural(gpus.length, 'gpu')}</span>`],
    vramT && ['vram', vramU / vramT, usedOf(vramU, vramT)],
  ] as (false | 0 | [string, number, string, string?])[]).filter(Boolean) as [string, number, string, string?][];
  const text = (k: string, v: string) => `<div class="st-row"><span class="st-key">${k}</span>${v}</div>`;
  const n = meterCells(stMeshBars, 8 + SUM_VAL);
  stMeshBars.innerHTML = rows.map(([k, f, v, cls]) => sumRow(k, f, n, v, cls)).join('');
  const rxs = sumHist(live, 'rx');
  const txs = sumHist(live, 'tx');
  stMeshHist.max = Math.max(1024, ...rxs, ...txs, stMeshHist.max * 0.98);
  const cpus = sumHist(live, 'cpu', (h) => h.s!.cpu.cores.length / Math.max(1, cores));
  dotGraph(stMeshCpu, cpus, cpuTop(cpus), () => '--sage');
  dotGraph(stMeshRx, rxs, stMeshHist.max, () => '--accent');
  dotGraph(stMeshTx, txs, stMeshHist.max, () => '--teal', true);
  stMeshText.innerHTML = [
    text('hosts', `<span class="st-lo">${live.length} up</span>${off ? `<span class="st-dim"> · ${off} stale or waiting</span>` : ''}`),
    text('net', `<span class="st-rx">▼ ${rate(rx)}</span>  <span class="st-tx">▲ ${rate(tx)}</span>`),
    text('24h', `<span class="st-rx">▼ ${humanSize(sum((s) => s.netDay.rx))}</span>  <span class="st-tx">▲ ${humanSize(sum((s) => s.netDay.tx))}</span>`),
    text('io', `<span class="st-rx">▼ ${rate(ioR)}</span>  <span class="st-tx">▲ ${rate(ioW)}</span>`),
    text('load', `${load.toFixed(2)} <span class="st-dim">1m, all hosts</span>`),
    text('run', dotJoin([plural(svc, 'service'), plural(ctr, 'process', 'processes')])),
    git.length && text('git', dotJoin([master ? `master ${esc(master.host)}` : '<span class="st-hi">no master</span>',
      git.length > 1 && `${git.filter((g) => g.role !== 'master' && g.eligible).length}/${git.length - 1} in sync`])),
  ].filter(Boolean).join('');
}

// ---- context ---------------------------------------------------------------
// the last ask against the model's context window, as claude code's /context
// draws it: a cell a hundredth of the window, each part its own hue

const CTX_CELLS = 100;
const CTX_PARTS: [string, string][] = [['system', 'system prompt'], ['chat', 'chat'], ['ask', 'prompt'], ['reply', 'reply']];

const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(Math.round(n)));
const tenth = (f: number) => `${(f * 100).toFixed(1)}%`;

// the window's hundred cells, each part's share
function ctxCells(m: ModelHost) {
  const use: Record<string, number | undefined> = m.use || {};
  const parts = CTX_PARTS.map(([k, label]): [string, string, number] => [k, label, Math.min(use[k] || 0, m.ctx!)]);
  const used = Math.min(m.ctx!, parts.reduce((a, [, , n]) => a + n, 0));
  const per = m.ctx! / CTX_CELLS;
  // whole cells first, a part's remainder as half a cell
  const cells: string[] = [];
  for (const [k, , n] of parts) {
    for (let i = 0; i < Math.floor(n / per); i++) cells.push(`<i class="ctx-${k} full"></i>`);
    if (n % per) cells.push(`<i class="ctx-${k} half"></i>`);
  }
  cells.length = Math.min(cells.length, CTX_CELLS);
  while (cells.length < CTX_CELLS) cells.push('<i></i>');
  return { cells: cells.join(''), parts, used };
}

// a model host's chip on its tile: phase and speed, its file, the context
// window as its last ask left it, the agents asking it
function chipHtml(m: ModelHost): string {
  const [cls, phase] = modelPhase(m);
  const head = dotJoin([`<span class="${cls}">${esc(phase)}</span>`, m.ready && m.use?.tps && `<b>${m.use.tps}</b> <span class="st-dim">tok/s</span>`]);
  const agents = m.agents?.length ? m.agents.map((a) => `<span class="st-chip-a">${esc(a)}</span>`).join('') : '<span class="st-dim">no agents</span>';
  let ctx = '';
  if (m.ready && m.ctx) {
    const { cells, parts, used } = ctxCells(m);
    // counts by colour alone, the names on hover
    const legend = [
      `<span>${kTok(used)}/${kTok(m.ctx)} <span class="st-dim">${pct(used / m.ctx)}</span></span>`,
      ...parts.map(([k, label, n]) => `<span title="${label}"><i class="ctx-${k} full"></i>${kTok(n)}</span>`),
      `<span title="free"><i></i>${kTok(m.ctx - used)}</span>`,
    ].join(' ');
    ctx = `<div class="st-ctx st-chip-ctx"><div class="st-ctx-grid">${cells}</div><div class="st-chip-key">${legend}</div></div>`;
  }
  const file = m.file ? `<div class="st-chip-file st-dim" title="${esc(m.file)}">${esc(String(m.file).replace(/\\/g, '/').split('/').pop())}</div>` : '';
  const clear = m.ready ? `<button type="button" class="st-clear" data-host="${esc(m.host)}" title="erase ${esc(m.host)}'s context windows">clear context</button>` : '';
  return `<div class="st-chip-head"><span class="st-chip-t">model</span>${head}</div>${file}${ctx}<div class="st-chip-foot"><div class="st-chip-agents">${agents}</div>${clear}</div>`;
}

// the chip drawn only when its html changed, no reflow a tick
function drawChip(p: Parts, m: ModelHost | null) {
  p.chip.hidden = !m;
  const html = m ? chipHtml(m) : '';
  if (html !== p.chipHtml) { p.chipHtml = html; p.chip.innerHTML = html; }
}

// tile widths in rem: the narrowest still legible, the widest before another column
const ST_TILE_MIN = 15;
const ST_TILE_MAX = 21;
// px, the tiles' cpu graph, shrunk toward the min only to spare a scroll, never grown past the max
const ST_GRAPH_MIN = 12;
const ST_GRAPH_MAX = 160;

// columns enough that every tile fits the view unscrolled, spare height left empty
let stFit = '';
function fitTiles(names: string[]) {
  const view = stHostsEl.parentElement!;
  const tile = (stHostsEl.querySelector('.st-card:not(.open):not(.waiting):not(.has-model)') || stHostsEl.querySelector('.st-card:not(.open):not(.waiting)')) as HTMLElement | null;
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
    - (stMeshEl.hidden ? 0 : stTopEl.offsetHeight + parseFloat(getComputedStyle(stTopEl).marginBottom));
  const width = stHostsEl.clientWidth;
  const graph = tile.querySelector('.st-sum-cpu') as HTMLElement;
  const base = tile.offsetHeight - graph.offsetHeight;
  const fits = (w: number) => Math.max(1, Math.floor((width + colGap) / (w * rem + colGap)));
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
  // a model host's tile twice as wide where three columns or more fit
  stHostsEl.classList.toggle('wide-chips', cols >= 3);
  stHostsEl.style.setProperty('--st-sum-graph', `${h}px`);
  statusDraw();
}

function drawCpu(p: Parts, h: StHost) {
  const { cpu } = h.s!;
  p.cpuHead.innerHTML = `cpu <span class="st-dim">${esc(cpu.model.replace(/\s+/g, ' ').toLowerCase())}</span>`;
  if (!p.cpuGraph) {
    p.cpu.innerHTML = '<div class="st-cpu-left"><canvas class="st-graph st-graph-cpu"></canvas><div class="st-row"></div></div><div class="st-cores"></div>';
    [p.cpuGraph, p.cpuLine] = p.cpu.firstElementChild.children;
    p.cores = p.cpu.lastElementChild;
  }
  dotGraph(p.cpuGraph, h.hist.cpu!, 100, heatVar);
  p.cpuLine.innerHTML = `<span class="${heat(cpu.total / 100)}">${cpu.total.toFixed(1)}%</span>`
    + `<span class="st-dim"> load </span>${cpu.load.map((l) => l.toFixed(2)).join(' ')}`;
  p.cores.innerHTML = cpu.cores.map((c, i) => `<div><span class="st-dim">${String(i).padStart(2)}</span> `
    + `${meter(c / 100, 4)} ${String(Math.round(c)).padStart(3)}%</div>`).join('');
}

// label, value, bar to the box's width, percent
const barRow = (k: string, text: string, frac: number, cells: number, cls?: string) => `<div class="st-row"><span class="st-key">${esc(k)}</span>`
  + `${text.padStart(6)} ${meter(frac, cells, cls)} ${pct(frac).padStart(4)}</div>`;

function barRows(el: HTMLElement, rows: [string, number, number, string?][]) {
  const cells = meterCells(el, 20);
  el.innerHTML = rows.map(([k, v, of, cls]) => barRow(k, humanSize(v), v / of, cells, cls)).join('');
}

function drawMem(p: Parts, h: StHost) {
  const m = h.s!.mem;
  p.memHead.innerHTML = `mem <span class="st-dim">${humanSize(m.total)}</span>`;
  barRows(p.mem, ([
    ['used', m.used, m.total], ['avail', m.avail, m.total, 'st-lo'], ['cached', m.cached, m.total, 'st-cache'],
    m.swapTotal && ['swap', m.swapUsed, m.swapTotal],
  ] as (0 | false | [string, number, number, string?])[]).filter(Boolean) as [string, number, number, string?][]);
}

// the host's own disks, summed
function drawDisk(p: Parts, h: StHost) {
  const { disk, io } = h.s!;
  const n = disk.count > 1 ? ` · ${disk.count} filesystems` : '';
  p.diskHead.innerHTML = `disk <span class="st-dim">${humanSize(disk.total)} capacity${n}</span>`;
  barRows(p.disk, [['used', disk.used, disk.total], ['free', disk.total - disk.used, disk.total, 'st-lo']]);
  p.disk.insertAdjacentHTML('beforeend', `<div class="st-row"><span class="st-key">io</span>`
    + `<span class="st-rx">r ${rate(io.r)}</span>  <span class="st-tx">w ${rate(io.w)}</span></div>`);
}

function drawNet(p: Parts, h: StHost) {
  const rx = h.hist.rx!.at(-1) || 0;
  const tx = h.hist.tx!.at(-1) || 0;
  const busy = h.s!.net.filter((n) => n.rx || n.tx);
  p.netHead.innerHTML = `net <span class="st-dim">${esc((busy.length ? busy : h.s!.net).map((n) => n.name).join(' '))}</span>`;
  if (!p.rxGraph) {
    p.net.innerHTML = '<canvas class="st-graph"></canvas><div class="st-row"></div><canvas class="st-graph"></canvas><div class="st-row"></div>';
    [p.rxGraph, p.rates, p.txGraph, p.day] = p.net.children;
  }
  const max = netScale(h);
  dotGraph(p.rxGraph, h.hist.rx!, max, () => '--accent');
  dotGraph(p.txGraph, h.hist.tx!, max, () => '--teal', true);
  p.rates.innerHTML = `<span class="st-rx">▼ ${rate(rx)}</span>  <span class="st-tx">▲ ${rate(tx)}</span>`
    + `<span class="st-dim">  top ${rate(max)}</span>`;
  // a day, or as much of one as has been counted
  const d = h.s!.netDay;
  const ms = h.s!.at - d.since;
  const span = ms < 3600000 ? `${Math.max(1, Math.round(ms / 60000))}m` : `${Math.min(24, Math.round(ms / 3600000))}h`;
  p.day.innerHTML = `<span class="st-key">${span}</span><span class="st-rx">▼ ${humanSize(d.rx)}</span>`
    + `  <span class="st-tx">▲ ${humanSize(d.tx)}</span>`;
}

function drawGpu(p: Parts, h: StHost) {
  const list = h.s!.gpus;
  p.gpuHead.innerHTML = `gpu <span class="st-dim">${esc(list.map((g) => g.name).join(', '))}</span>`;
  const cells = meterCells(p.gpu, 20);
  p.gpu.innerHTML = list.map((g) => {
    const rows: string[] = [];
    if (list.length > 1) rows.push(`<div class="st-row st-dim">${esc(g.name)}</div>`);
    if (g.util !== null) rows.push(barRow('load', `${g.util}%`, g.util / 100, cells));
    else if (g.mhz && g.mhzMax) rows.push(barRow('clock', `${g.mhz}mhz`, g.mhz / g.mhzMax, cells));
    if (g.memTotal) rows.push(barRow('vram', humanSize(g.memUsed), g.memUsed! / g.memTotal, cells));
    if (g.temp !== null) {
      rows.push(`<div class="st-row"><span class="st-key">temp</span><span class="${heat((g.temp - 40) / 50)}">${g.temp}°c</span></div>`);
    }
    return rows.join('') || '<div class="st-dim">no readings</div>';
  }).join('');
}

function drawCtr(p: Parts, h: StHost) {
  // phosphorus's own processes, by role
  const list = h.s!.parts;
  p.ctrHead.innerHTML = `phosphorus <span class="st-dim">${list ? list.length : ''}</span>`;
  if (!list) { p.ctr.innerHTML = '<div class="st-dim">no process list</div>'; return; }
  p.ctr.innerHTML = '<div class="st-ctr-row st-dim"><span>name</span><span>cpu</span><span>mem</span><span>pids</span></div>'
    + list.map((c) => `<div class="st-ctr-row"><span class="st-ctr-name">${esc(c.name)}</span>`
      + `<span class="${heat(c.cpu / 100)}">${c.cpu.toFixed(1)}%</span><span>${humanSize(c.mem)}</span>`
      + `<span class="st-dim">${c.pids}</span></div>`).join('');
}

function drawProc(p: Parts, h: StHost) {
  const pr = h.s!.procs;
  p.procHead.innerHTML = `processes <span class="st-dim">${pr ? pr.count : ''}</span>`;
  if (!pr) { p.proc.innerHTML = '<div class="st-dim">no process list</div>'; return; }
  p.proc.innerHTML = '<div class="st-proc-row st-dim"><span>name</span><span>pid</span><span>cpu</span><span>mem</span></div>'
    + pr.top.map((x) => `<div class="st-proc-row"${x.cmd ? ` title="${esc(x.cmd)}"` : ''}>`
      + `<span class="st-ctr-name">${esc(x.name)}${x.role ? ` <span class="st-dim">${esc(x.role)}</span>` : ''}</span><span class="st-dim">${x.pid}</span>`
      + `<span class="${heat(x.cpu / 100)}">${x.cpu.toFixed(1)}%</span><span>${humanSize(x.mem)}</span></div>`).join('');
}

// self first, then by name, hosts gone from the mesh dropped
function statusRender() {
  const live = stNet ? stNet.tailnet.filter((d) => d.phosphorus).map((d) => d.name) : [...stHosts.keys()];
  const names = [...new Set(live)].sort((a, b) => Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b));
  for (const [name, h] of stHosts) if (!names.includes(name)) { h.card?.card.remove(); stHosts.delete(name); }
  if (!names.includes(stOpenHost!)) stOpenHost = null;
  if (names.length) stHostsEl.querySelector('.st-wait')?.remove();
  drawMeshSum(names);
  let prev: HTMLElement | null = null;
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
    const model = modelOf(name);
    card.classList.toggle('has-model', !!model);
    drawChip(parts, model);
    card.classList.toggle('stale', !!h.s?.cpu && Date.now() - h.at > ST_STALE_MS);
    card.classList.toggle('waiting', !h.s?.cpu);
    if (!h.s?.cpu) {
      card.dataset.note = 'waiting for stats';
      continue;
    }
    if (!open) { drawSum(parts, h); continue; }
    // no gpu, no gpu box
    for (const [k, , draw] of ST_BOXES) {
      const box = parts[`${k}Box`] as HTMLElement;
      box.hidden = k === 'gpu' && !h.s.gpus.length;
      if (!box.hidden) draw(parts, h);
    }
  }
  stHostsEl.classList.toggle('has-open', !!stOpenHost);
  fitTiles(names);
}

// one host open at a time, the opened or closed one keeping the arrow keys' pick
function stToggle(name: string) {
  stOpenHost = stOpenHost === name ? null : name;
  statusRender();
  const card = stHosts.get(name)?.card?.card;
  card?.focus({ preventScroll: true });
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.shiftKey && stOpenHost && stOpen() && !modalOpen()) stToggle(stOpenHost);
});

// a quiet peer's stale mark, with no message to trigger it
setInterval(() => { if (stWs) statusDraw(); }, 2000);
window.addEventListener('resize', statusDraw);
// as app.js registered it: the event itself handed to statusWatch, which takes it for a state
// until the next push sets a real one (kept as it was; a candidate fix, not this refactor's)
document.addEventListener('visibilitychange', statusWatch as unknown as EventListener);

export { statusDraw, statusReconnect, statusState, statusWatch };
