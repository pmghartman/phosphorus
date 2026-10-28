// the mesh: its routes and serving host, the status diagram and its stats table, the git
// rows, pings from this browser, and the tray popup holding it all
import { appCall } from '../../apps/index.ts';
import { databaseIcon, DK_GLYPHS, dkGlyph, el, pageAsk, svgEl } from '../../lib/dom.ts';
import { noteAdd } from '../notes.ts';
import { dk, st } from '../../lib/state.ts';
import { connectState } from '../../lib/sync.ts';
import { dkAnchor, dkChips, dkPopsClose, type Pop } from '../../desktop/taskbar.ts';
import type { GitHost, Route, State, TailnetDevice } from '@phosphorus/wire';
import { ago, esc } from '../../lib/util.ts';

// --- self / routes ------------------------------------------------------

export function serviceUrl(route: Route): string {
  const base = route.base_path ? `${route.base_path.replace(/^\/+|\/+$/g, '')}/` : '';
  if (route.mode === 'subdomain' && st.meshDomain) return `https://${route.name}.${st.meshDomain}/${base}`;
  return `/${route.host}/${route.name}/${base}`;
}

export const serviceKey = (route: { host: string; name: string }) => `${route.host}::${route.name}`;

// a service opened from here whose tab is still open
export interface Connection { win: { closed: boolean }; host: string; name: string }
// key -> { win, host, name } for each service opened from here whose tab is
// still open, driving the touched/purple path and the packet pulse
export const activeConnections = new Map<string, Connection>();

// a closed tab's line dropped from the graph, checked every second
export function pruneConnections(): void {
  if (!activeConnections.size) return;
  let changed = false;
  for (const [key, conn] of activeConnections) {
    if (conn.win.closed) { activeConnections.delete(key); changed = true; }
  }
  if (changed) drawMesh();
}

// a host's OS, from /api/state's tailnet (tailscale itself sees every
// host as linux)
export const hostPlatform = new Map<string, string>();

// round-trip ms from this browser to that host, timed here, null until
// measured or when it didn't answer
const hostRtt = new Map<string, number | null>();

// host -> last 20 samples, oldest first, for the stats table sparkline
const rttHistory = new Map<string, number[]>();
const RTT_HISTORY_LEN = 20;
const RTT_SAMPLE_MS = 2000;
// the table's number: the median of the last few samples
const RTT_SHOWN_OF = 5;

// forgejo's service name, its own app rather than a service icon
export const GIT_SERVICE = 'git';

// --- mesh status diagram --------------------------------------------------
const meshSvg = document.getElementById('mesh-svg') as unknown as SVGSVGElement;
const meshCount = document.getElementById('mesh-count')!;
export const meshPanel = document.getElementById('mesh-panel')!;
const meshGraphWrap = document.getElementById('mesh-graph-wrap')!;
const meshStats = document.getElementById('mesh-stats')!;
const meshStatsRows = document.getElementById('mesh-stats-rows')!;
const meshHeader = document.querySelector('.mesh-header') as HTMLElement;
const stash = document.getElementById('dk-stash')!;

// the stats table's unclipped height, cached whenever renderMeshStats() runs,
// reserved by meshLayoutParams() when expanded
let lastStatsHeight = 0;

// stats table DOM rebuilt only on real data changes, never per
// expand/collapse frame
let meshStatsDirty = true;

interface Dims { width: number; height: number; widthPx: number; legendPx: number }

// expanded: fewer logical units per pixel width, a real zoom, the popup's
// height whatever the stats table leaves
function meshLayoutParams(expanded: boolean): Dims {
  const width = expanded ? 200 : 232;
  const box = meshPanel.closest('.dk-mesh-pop');
  const bodyH = (box?.clientHeight || 240) - meshHeader.clientHeight - (expanded ? lastStatsHeight : 0);
  const widthPx = meshGraphWrap.clientWidth || width;
  // the legend expanded only, hidden, not gone, so still measured
  const legend = meshGraphWrap.querySelector('.mesh-legend') as HTMLElement;
  const legendOn = expanded && meshPanel.classList.contains('legend-on');
  return { width, height: width * (Math.max(60, bodyH) / widthPx), widthPx, legendPx: legendOn ? legend.offsetTop + legend.offsetHeight : 0 };
}

// host row to the non-phosphorus devices, a frame fraction, LIFT the
// expanded host row's rise
const OTHERS_AXIS = 0.34;
const LIFT = 0.1;

// both ends of the tween, measured once per animation or static draw,
// no per-frame read forcing a reflow
let meshDims: { collapsed: Dims; expanded: Dims } | null = null;
function meshDimsNow() {
  if (!meshDims || !meshAnimFrame) meshDims = { collapsed: meshLayoutParams(false), expanded: meshLayoutParams(true) };
  return meshDims;
}

// meshT: 0 = base (hub | hosts | others columns, 25% height), 1 = expanded
// (hub-on-top rows, 50% height), lerped by drawMesh() each frame
let meshT = 0;
let meshAnimFrame: number | null = null;

function animateMeshT(target: number) {
  if (meshAnimFrame) cancelAnimationFrame(meshAnimFrame);
  meshDims = null;
  // quick, and fastest at the start, so the click answers at once
  const duration = 200;
  const start = performance.now();
  const from = meshT;
  const easeOutCubic = (p: number) => 1 - (1 - p) ** 3;
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / duration);
    meshT = from + (target - from) * easeOutCubic(p);
    drawMesh();
    meshAnimFrame = p < 1 ? requestAnimationFrame(step) : null;
  };
  meshAnimFrame = requestAnimationFrame(step);
}

// always expanded, its table always up
meshPanel.classList.add('expanded');
meshT = 1;

// the nodes and git rows folded under their heads, the legend behind a ?; kept per browser
const MESH_UI_KEY = 'phosphorus-mesh-ui';
const meshUi: { legend?: boolean; nodes?: boolean; git?: boolean; size?: { w: number; h: number }; [k: string]: unknown } = (() => { try { return JSON.parse(localStorage.getItem(MESH_UI_KEY)!) || {}; } catch { return {}; } })();
const saveMeshUi = () => { try { localStorage.setItem(MESH_UI_KEY, JSON.stringify(meshUi)); } catch {} };
const meshLegendBtn = document.getElementById('mesh-legend-btn')!;
function paintMeshUi() {
  meshPanel.classList.toggle('legend-on', !!meshUi.legend);
  meshLegendBtn.setAttribute('aria-pressed', String(!!meshUi.legend));
  for (const b of meshPanel.querySelectorAll<HTMLElement>('.mesh-fold')) {
    const open = !!meshUi[b.dataset.fold!];
    b.setAttribute('aria-expanded', String(open));
    b.parentElement!.classList.toggle(`fold-${b.dataset.fold}`, !open);
  }
}
paintMeshUi();
meshLegendBtn.addEventListener('click', () => {
  meshUi.legend = !meshUi.legend;
  saveMeshUi();
  paintMeshUi();
  meshDims = null;
  if (!meshAnimFrame) drawMesh();
});
for (const b of meshPanel.querySelectorAll<HTMLElement>('.mesh-fold')) {
  b.addEventListener('click', () => {
    meshUi[b.dataset.fold!] = !meshUi[b.dataset.fold!];
    saveMeshUi();
    paintMeshUi();
    meshStatsDirty = true;
    if (!meshAnimFrame) drawMesh();
  });
}

window.addEventListener('resize', () => {
  if (!meshAnimFrame) drawMesh();
});

// --- serving host -----------------------------------------------------------
// the host serving this page, held by the ingress's phosphorus-host cookie

export const phosphorusHosts = () => meshTailnet.filter((d) => d.phosphorus).map((d) => d.name).sort();

// {to, from, at} of a switch awaiting the new host's first answer
let hostSwitch: { to: string; from: string; at: number } | null = null;
// grace for a late poll from the old host
const HOST_SWITCH_MS = 4000;
// the host a switch is waiting on, if one is
export const hostSwitchNow = () => hostSwitch;

// drawn at once as the new self, confirmed or undone by the state
function redrawHost(host: string) {
  st.selfHost = host;
  meshSig = '';
  renderMesh(meshRoutes, meshTailnet);
  dkChips();
}

export async function switchHost(host: string): Promise<void> {
  if (!host || host === (hostSwitch?.to || st.selfHost)) return;
  const from = hostSwitch?.from || st.selfHost;
  hostSwitch = { to: host, from, at: Date.now() };
  redrawHost(host);
  const r = await fetch(`/api/host?host=${encodeURIComponent(host)}`, { method: 'POST' }).catch(() => null);
  if (hostSwitch?.to !== host) return;
  if (!r || !r.ok) {
    hostSwitch = null;
    redrawHost(from);
    return;
  }
  // chat, state and stats reconnected through the new host
  st.ws?.close();
  connectState();
  appCall('status', false, (m) => m.statusReconnect());
}

// the served host from the state, held at the pending one until it answers
export function settleHost(served: string): string {
  const sw = hostSwitch;
  if (!sw) return served;
  // the pulse dropped on the next draw
  meshSig = '';
  if (served === sw.to) {
    hostSwitch = null;
    return served;
  }
  if (Date.now() - sw.at < HOST_SWITCH_MS) return sw.to;
  hostSwitch = null;
  return served;
}

// a node's half-width before the depth scale
const NODE_HALF = 3;

// one square plus its name, the rest in the tooltip, opts: size (half-width),
// scale (depth), opacity, noLabel, host (a host to switch to), all optional
function drawNode(x: number, y: number, name: string, cls: string, tooltip: string, opts?: { size?: number; scale?: number; opacity?: number; noLabel?: boolean; host?: string }) {
  const o = opts || {};
  const scale = o.scale || 1;
  const size = o.size || NODE_HALF * scale;
  const opacity = o.opacity === undefined ? 1 : o.opacity;
  // a host: square, name and a wider hit area as one target
  const parent: SVGElement = o.host
    ? meshSvg.appendChild(svgEl('g', { class: 'mesh-host', 'data-host': o.host }))
    : meshSvg;
  if (o.host) {
    const w = Math.max(18, name.length * 4.3 + 6);
    parent.appendChild(svgEl('rect', { x: x - w / 2, y: y - 8, width: w, height: 24, class: 'mesh-hit' }));
  }
  const node = svgEl('rect', {
    x: x - size, y: y - size, width: size * 2, height: size * 2,
    class: `mesh-node ${cls}`, style: `opacity:${opacity}`,
  });
  const title = svgEl('title', {});
  title.textContent = tooltip;
  node.appendChild(title);
  parent.appendChild(node);

  if (o.noLabel) return;
  // kept inside the frame, ~4.3 units a 7px monospace char
  const textScale = Math.sqrt(scale);
  const half = name.length * 2.15 * textScale;
  const frame = meshSvg.viewBox.baseVal;
  const label = svgEl('text', {
    x: Math.max(half, Math.min(frame.width - half, x)), y: Math.min(frame.height - 1.5, y + 10 * scale + 3), 'text-anchor': 'middle',
    class: 'mesh-label', style: `opacity:${opacity};font-size:${7 * textScale}px`,
  });
  label.textContent = name;
  parent.appendChild(label);
}

// beside a git host: the git service's own glyph for the master, a * for the rest,
// purple master, sand available, dark grey out of date, red unreachable
function drawGitMarker(x: number, y: number, h: GitHost, scale = 1) {
  const master = h.reachable && h.role === 'master';
  const state = !h.reachable ? 'down' : master ? 'master' : h.eligible ? 'ok' : 'stale';
  const g = svgEl('g', { class: `mesh-git ${state}`, transform: `translate(${x + 4.5 * scale} ${y - 4.5 * scale}) scale(${0.9 * scale})` });
  const title = svgEl('title', {});
  title.textContent = { master: 'git master', ok: 'git servant, in sync', stale: 'git servant, out of date', down: 'git servant, unreachable' }[state];
  g.appendChild(title);
  if (master) {
    // no CSS size for a nested svg, only its own attributes
    const db = databaseIcon();
    db.setAttribute('width', '7');
    db.setAttribute('height', '8');
    g.appendChild(db);
  } else {
    const star = svgEl('text', { x: 3.5, y: 6.5, 'text-anchor': 'middle', class: 'mesh-git-star' });
    star.textContent = '*';
    g.appendChild(star);
  }
  meshSvg.appendChild(g);
}

document.querySelector('.mesh-legend-git')!.prepend(databaseIcon());

// the gradient sliding by smil, out of the stylesheet's reduced-motion
// rule's reach, so held still here the same way
const svgDefs = document.querySelector('.svg-defs') as SVGSVGElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const syncMotion = () => (reduceMotion.matches ? svgDefs.pauseAnimations() : svgDefs.unpauseAnimations());
reduceMotion.addEventListener('change', syncMotion);
syncMotion();

// a model host as the graph marks it
interface MeshModel { file?: string; ready?: boolean; agents: string[] }

// left of a model host, mirroring the git mark: how many agents ask it, in
// the glyph's colours, dimmed while not loaded
function drawModelMarker(x: number, y: number, mm: MeshModel, scale = 1, opacity = 1) {
  const mark = svgEl('text', {
    x: x - 4.5 * scale, y: y - 1.2 * scale, 'text-anchor': 'end', class: `mesh-model-mark${mm.ready ? '' : ' down'}`,
    style: `font-size:${7 * scale}px;opacity:${opacity}`,
  });
  mark.textContent = String(mm.agents.length || 'm');
  const title = svgEl('title', {});
  title.textContent = `${mm.agents.length ? mm.agents.join(', ') : 'no agents'} on ${mm.file || 'no model yet'}${mm.ready ? '' : ', not loaded'}`;
  mark.appendChild(title);
  meshSvg.appendChild(mark);
}

let meshRoutes: Route[] = [];
let meshTailnet: TailnetDevice[] = [];
// the model hosts, marked in the glyph's colours
let meshModels = new Map<string, MeshModel>();
let meshSig = '';

export function renderMesh(routes: Route[], tailnet: TailnetDevice[]): void {
  meshRoutes = routes;
  meshTailnet = tailnet;
  // nothing redrawn for a poll changing nothing drawn (a full rebuild at 10/s grew the tab)
  const sig = JSON.stringify([st.selfHost, routes.map((r) => [r.host, r.name]),
    tailnet.map((d) => [d.name, !!d.phosphorus, d.os || ''])]);
  if (sig === meshSig) return;
  meshSig = sig;
  meshStatsDirty = true;
  if (!meshAnimFrame) drawMesh();
}

// the model hosts from a state push, the graph drawn again for a git or model change
export function meshModelsFrom(state: State, gitChanged: boolean): void {
  const nextModels = new Map<string, MeshModel>((state.model?.models || []).map((x) => [x.host, { file: x.file, ready: x.ready, agents: x.agents || [] }]));
  const modelChanged = JSON.stringify([...nextModels]) !== JSON.stringify([...meshModels]);
  meshModels = nextModels;
  if ((gitChanged || modelChanged) && !meshAnimFrame) drawMesh();
}

// every host pinged from this browser, through the tunnel and the host serving
// the page, the whole round trip timed here
export async function pingHosts(): Promise<void> {
  const hosts = phosphorusHosts();
  if (!hosts.length) return;
  await Promise.all(hosts.map(async (h) => {
    const t = performance.now();
    const r = await fetch(`/api/ping/${encodeURIComponent(h)}`, { cache: 'no-store' }).catch(() => null);
    const ms = r?.status === 204 ? Math.round(performance.now() - t) : null;
    hostRtt.set(h, ms);
    if (ms === null) return;
    const hist = rttHistory.get(h) || [];
    hist.push(ms);
    if (hist.length > RTT_HISTORY_LEN) hist.shift();
    rttHistory.set(h, hist);
  }));
  meshStatsDirty = true;
  if (!meshAnimFrame) drawMesh();
}
// only while the mesh graph or the status view is on screen
const pingWanted = () => !document.hidden && [meshPanel, document.getElementById('view-status')]
  .some((v) => v?.getClientRects().length && !v.closest('.stash'));
setInterval(() => { if (pingWanted()) pingHosts(); }, RTT_SAMPLE_MS);

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ping bucket -> CSS class, null/undefined meaning unmeasured, not offline
export function pingClass(rttMs: number | null | undefined): string {
  if (rttMs === null || rttMs === undefined) return '';
  if (rttMs <= 150) return 'good';
  if (rttMs <= 300) return 'slow';
  return 'bad';
}

function pingText(rttMs: number | null | undefined): string {
  if (rttMs === null || rttMs === undefined) return '–';
  return `${rttMs}ms`;
}

// unmeasured kept unmeasured at once, otherwise the recent median
export function steadyRtt(name: string): number | null {
  if (typeof hostRtt.get(name) !== 'number') return null;
  const recent = (rttHistory.get(name) || []).slice(-RTT_SHOWN_OF).sort((a, b) => a - b);
  return recent.length ? recent[recent.length >> 1]! : hostRtt.get(name)!;
}

// inline trend line over the last RTT samples, '' without enough history,
// fixed 0..SPARK_MAX_MS scale so 1ms jitter stays flat
const SPARK_MAX_MS = 300;
function sparkline(history: number[] | undefined, cls: string): string {
  if (!history || history.length < 2) return '';
  const w = 24;
  const h = 10;
  const pts = history.map((v, i) => {
    const x = (i / (history.length - 1)) * w;
    const y = h - (Math.min(v, SPARK_MAX_MS) / SPARK_MAX_MS) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="mesh-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<polyline points="${pts}" class="${cls}"/></svg>`;
}

// CSS-hidden until .expanded, built every render anyway, cheap and always
// current the moment the panel opens
function renderMeshStats(hosts: string[], grouped: Map<string, Route[]>) {
  meshStatsRows.innerHTML = '';
  const addRow = (name: string, os: string | undefined, rttMs: number | null, dotCls: string) => {
    const row = document.createElement('div');
    row.className = 'mesh-stat-row';
    if (name !== st.selfHost) {
      row.dataset.host = name;
      row.title = `switch host to ${name}`;
    }
    const dot = `<span class="mesh-stat-dot ${dotCls}"></span>`;
    const cls = pingClass(rttMs);
    const spark = sparkline(rttHistory.get(name), cls);
    row.innerHTML =
      `<span class="mesh-stat-name">${dot}<span class="mesh-stat-nm">${name}</span>` +
      `<span class="mesh-stat-os">${os || '?'}</span></span>` +
      `<span class="mesh-stat-ping-cell">${spark}<span class="mesh-stat-ping ${cls}">${pingText(rttMs)}</span></span>`;
    meshStatsRows.appendChild(row);
  };
  // phosphorus hosts only, other mesh devices just in the graph
  for (const m of hosts) {
    const dotCls = m === st.selfHost ? 'self' : grouped.get(m)!.length ? 'active' : 'idle';
    addRow(m, hostPlatform.get(m), steadyRtt(m), dotCls);
  }

  // everything below measuring the table, 0 under display:none, so forced
  // visible for these reads, then restored exactly as found
  const prevDisplay = meshStats.style.display;
  const prevMaxHeight = meshStats.style.maxHeight;
  meshStats.style.display = 'flex';
  meshStats.style.maxHeight = 'none';

  document.getElementById('mesh-nodes-n')!.textContent = String(hosts.length);
  // up to 8 rows tall, then a scroll, measured off a real row, not guessed
  const firstRow = meshStatsRows.firstElementChild as HTMLElement | null;
  meshStatsRows.style.maxHeight = firstRow?.offsetHeight ? `${firstRow.offsetHeight * 8}px` : '';

  // scrollHeight: the natural height, whatever max-height drawMesh() animates
  lastStatsHeight = meshStats.scrollHeight;
  meshDims = null;
  meshStats.style.display = prevDisplay;
  meshStats.style.maxHeight = prevMaxHeight;
}

// --- git backups: each git host's copy and how far it trails the master

const meshGit = document.getElementById('mesh-git')!;
const meshGitRows = document.getElementById('mesh-git-rows')!;
// five cells a band, each filled across its own seconds
const GIT_LAG_CELLS = 5;
const GIT_LAG_BANDS: [string, number, number][] = [['good', 0, 8], ['slow', 8, 15], ['stale', 15, 60]];
let meshGitHosts = '';

function lagMeter(sec: number): string {
  let html = '';
  let empty = 0;
  for (const [cls, from, to] of GIT_LAG_BANDS) {
    const full = Math.round(Math.max(0, Math.min(1, (sec - from) / (to - from))) * GIT_LAG_CELLS);
    if (full) html += `<span class="${cls}">${'█'.repeat(full)}</span>`;
    empty += GIT_LAG_CELLS - full;
  }
  return `${html}<span class="off">${'░'.repeat(empty)}</span>`;
}

function gitBackupText(h: GitHost, masterGen: number | null): string {
  if (!h.reachable) return 'unreachable';
  // a live master to copy from: the first download under way
  if (h.gen == null || h.ageSec == null) return masterGen != null && h.role !== 'master' ? 'downloading' : 'no data yet';
  const parts = [h.role === 'master' ? 'master, live' : masterGen != null && h.gen < masterGen ? 'older lineage' : h.role];
  if (h.role !== 'master' && !h.eligible) parts.push('catching up');
  if (h.updating) parts.push('updating');
  return parts.join(' · ');
}

// every state push, ageSec fresh each time; the table remeasured on a new host set
export function renderMeshGit(): void {
  const gitHostsList = st.gitHostsList;
  meshGit.hidden = !gitHostsList.length;
  document.getElementById('mesh-git-n')!.textContent = String(gitHostsList.length);
  const masterGen = gitHostsList.find((h) => h.role === 'master' && h.reachable)?.gen ?? null;
  meshGitRows.innerHTML = gitHostsList.map((h) => {
    const master = h.reachable && h.role === 'master';
    const cls = master ? 'master' : !h.reachable ? 'down' : !h.eligible ? 'catching' : '';
    const text = gitBackupText(h, masterGen);
    const behind = h.reachable && !master && h.ageSec != null
      ? `<span class="git-lag" title="last matched the master's stamp, checked every 5s and copied only on change: green to 8s, yellow to 15s, red to 60s">${lagMeter(h.ageSec)}</span><span class="git-ago">${ago(h.ageSec)}</span>` : '';
    return `<div class="mesh-git-row ${cls}"><span class="mesh-stat-name"><span class="mesh-git-dot"></span>`
      + `<span class="mesh-stat-nm">${esc(h.host)}</span><span class="mesh-git-text">${text === 'downloading' ? '<span class="git-spin"></span>' : ''}${esc(text)}</span></span>`
      + `<span class="mesh-git-behind">${behind}${h.reachable && !master && st.acct?.admin
        ? `<button type="button" class="mesh-git-take" data-host="${esc(h.host)}" title="make ${esc(h.host)} the git master">master</button>` : ''}</span></div>`;
  }).join('');
  const sig = gitHostsList.map((h) => h.host).join();
  if (sig !== meshGitHosts) {
    meshGitHosts = sig;
    meshStatsDirty = true;
    if (!meshAnimFrame) drawMesh();
  }
}

// a live master handing off, none force-promoting
async function askGitSwitch(name: string) {
  const master = st.gitHostsList.find((h) => h.role === 'master' && h.reachable);
  const ok = await pageAsk({ title: master ? 'switch git master' : 'force-promote', message: master ? `${name} master?` : `force ${name}?`,
    action: master ? 'make master' : 'force-promote', danger: !master });
  if (!ok) return;
  let why = '';
  try {
    const r = await fetch(`/api/githosts/${encodeURIComponent(name)}/force`, { method: 'POST' });
    if (!r.ok) why = String((await r.json().catch(() => ({}))).error || r.status);
  } catch (err) { why = (err as Error).message; }
  if (why) noteAdd('git master failed', why);
  pageAsk({ title: 'git master', message: why ? 'failed' : 'switching', cancel: false });
}

// the one place a host is switched: its square in the graph or its row in the stats
meshSvg.addEventListener('click', (e) => {
  const g = (e.target as Element).closest('.mesh-host') as SVGElement | null;
  if (g && meshPanel.classList.contains('expanded')) switchHost(g.dataset.host!);
});
meshStatsRows.addEventListener('click', (e) => {
  const row = (e.target as Element).closest('.mesh-stat-row[data-host]') as HTMLElement | null;
  if (row) switchHost(row.dataset.host!);
});
meshGitRows.addEventListener('click', (e) => {
  const b = (e.target as Element).closest('.mesh-git-take') as HTMLElement | null;
  if (b) askGitSwitch(b.dataset.host!);
});

let pulseAnimFrame: number | ReturnType<typeof setTimeout> | null = null;

// the touched elements drawMesh() drew (tunnel spoke, peer arc, service stem)
// via getPointAtLength(), so the pulse rides the real curve
function pulsePoint(key: string, host: string, distFrac: number): DOMPoint | null {
  const ids = ['mesh-tunnel-self'];
  if (host !== st.selfHost) ids.push(`peer-${host}`);
  ids.push(`stem-${key}`);
  const segs = ids.map((id) => document.getElementById(id) as unknown as SVGGeometryElement | null).filter((s): s is SVGGeometryElement => !!s);
  if (!segs.length) return null;

  const lens = segs.map((el) => el.getTotalLength());
  const total = lens.reduce((a, b) => a + b, 0);
  let dist = distFrac * total;
  for (let i = 0; i < segs.length; i++) {
    if (dist <= lens[i]! || i === segs.length - 1) return segs[i]!.getPointAtLength(Math.min(dist, lens[i]!));
    dist -= lens[i]!;
  }
  return segs[segs.length - 1]!.getPointAtLength(lens[lens.length - 1]!);
}

// one pulse/sec per connection: hub, self, target host if different, target
// service, its own rAF loop while any connection is open
export function startPulseLoop(): void {
  if (pulseAnimFrame) return;
  const tick = (now: number) => {
    if (!activeConnections.size) { pulseAnimFrame = null; return; }
    // the graph off screen: nothing to measure, looked at again a few times a second
    if (!meshPanel.offsetParent) { pulseAnimFrame = setTimeout(() => requestAnimationFrame(tick), 250); return; }
    const progress = (now / 1000) % 1;
    for (const [key, conn] of activeConnections) {
      const point = pulsePoint(key, conn.host, progress);
      if (!point) continue;
      let mark = document.getElementById(`pulse-${key}`);
      if (!mark || !mark.isConnected) {
        mark = svgEl('rect', { id: `pulse-${key}`, width: 2, height: 2, class: 'mesh-pulse' }) as unknown as HTMLElement;
        meshSvg.appendChild(mark);
      }
      mark.setAttribute('x', String(point.x - 1));
      mark.setAttribute('y', String(point.y - 1));
      mark.setAttribute('style', `opacity:${Math.sin(progress * Math.PI)}`);
    }
    pulseAnimFrame = requestAnimationFrame(tick);
  };
  pulseAnimFrame = requestAnimationFrame(tick);
}

// pure function of last-fetched data + meshT, called per data poll and per
// animation frame, so layout restructures/rescales instead of a CSS transform
export function drawMesh(): void {
  const t = meshT;

  // hosts a live connection targets, and the specific services it's touching
  const touchedHosts = new Set<string>();
  const touchedServices = new Set<string>();
  for (const conn of activeConnections.values()) {
    touchedHosts.add(conn.host);
    touchedServices.add(serviceKey(conn));
  }

  const routes = meshRoutes;
  const tailnet = meshTailnet;
  const grouped = new Map<string, Route[]>();
  for (const r of routes) {
    if (!grouped.has(r.host)) grouped.set(r.host, []);
    grouped.get(r.host)!.push(r);
  }
  // tailnet devices without phosphorus: no routes, known only to the tailnet list
  const outside = new Map<string, TailnetDevice>();
  for (const d of tailnet) {
    if (d.phosphorus) {
      hostPlatform.set(d.name, d.os || '');
      if (!grouped.has(d.name)) grouped.set(d.name, []);
    } else if (!grouped.has(d.name)) {
      outside.set(d.name, d);
    }
  }
  const hosts = [...grouped.keys()].sort();
  const others = [...outside.keys()].sort();

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  meshCount.textContent = [
    hosts.length ? plural(hosts.length, 'host') : '',
    others.length ? `${others.length} in-mesh` : '',
  ].filter(Boolean).join(' · ');
  // stats table first, room for its height reserved by meshLayoutParams(),
  // rebuilt only on real change, never per tween frame
  if (meshStatsDirty) {
    renderMeshStats(hosts, grouped);
    meshStatsDirty = false;
  }

  // tied to meshT, not the .expanded class, max-height reclaiming space at
  // the rate opacity fades, neither in one jump
  if (t > 0) {
    meshStats.style.display = 'flex';
    meshStats.style.opacity = String(t);
    meshStats.style.maxHeight = `${lastStatsHeight * t}px`;
  } else if (meshStats.style.display !== 'none') {
    meshStats.style.opacity = '0';
    meshStats.style.maxHeight = '0px';
    meshStats.style.display = 'none';
  }

  const { collapsed, expanded } = meshDimsNow();

  // service squares fanned out in a row below their host once t>0, the frame
  // grown by a fixed drop to clear that row, not per extra service
  const maxSvc = Math.max(0, ...hosts.map((m) => grouped.get(m)!.length));
  const CHILD_BASE = 26;
  // crowded hosts staggered into lanes for clear labels: side by side collapsed,
  // stacked rows expanded, each row with room for its services
  const labelW = Math.max(0, ...hosts.map((m) => m.length)) * 4.3 + 6;
  const lanesFor = (span: number, need: number, most: number) => Math.min(most, Math.ceil(need / (span / (hosts.length + 1))));
  const lanesC = lanesFor(collapsed.height, 22, 3);
  const lanesE = lanesFor(expanded.width, labelW, 5);
  const LANE_C = Math.min(labelW, 34);
  const LANE_E = CHILD_BASE + 10;
  const expandedH = expanded.height + (maxSvc ? CHILD_BASE : 0);

  const width = lerp(collapsed.width, expanded.width, t);
  const height = lerp(collapsed.height, expandedH, t);
  // expanded lanes stacked downward, the frame grown only by what the room
  // below the host row (0.4 to 0.84 of the height) can't take
  const span = (lanesE - 1) * LANE_E;
  const grow = t * Math.max(0, span + CHILD_BASE + 22 - (OTHERS_AXIS + LIFT) * expandedH);

  meshSvg.innerHTML = '';
  meshSvg.setAttribute('viewBox', `0 0 ${width} ${height + grow}`);
  // every edge in the first layer, so nodes always sit on top of them
  const edges = svgEl('g', { class: 'mesh-edges' });
  meshSvg.appendChild(edges);

  if (!hosts.length && !others.length) {
    const text = svgEl('text', { x: width / 2, y: height / 2, 'text-anchor': 'middle', class: 'mesh-label' });
    text.textContent = 'no nodes live';
    meshSvg.appendChild(text);
    return;
  }

  // collapsed: hub|hosts|others as columns, expanded: rows, a rigid 90deg
  // spin (not a mirror), hub and hosts lifted for service room
  const margin = 0.12;
  const angle = t * (Math.PI / 2);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotate = (x: number, y: number) => ({ x: x * cos - y * sin, y: x * sin + y * cos });

  const lift = t * LIFT;
  const centerX = width / 2;
  const centerY = height / 2;

  // a floor tilted back from the viewer, lower nearer, side lanes stepping in
  // depth too, s the perspective scale, fog the depth fade
  const TILT = 0.5;
  const tiltSin = Math.sin(TILT);
  const tiltCos = Math.cos(TILT);
  const PERSP = 0.38;
  const floorH = (height + grow) / 2;
  const floorY = centerY + grow / 2;
  const fitY = tiltCos / (1 - tiltSin * PERSP);
  interface Projected { x: number; y: number; s: number; fog: number }
  const project = (x: number, y: number, depth = 0): Projected => {
    const u = (y - floorY) / floorH;
    const z = -u * tiltSin + depth;
    const s = 1 / (1 + z * PERSP);
    return {
      x: centerX + (x - centerX) * s,
      y: floorY + (u * tiltCos * s / fitY) * floorH,
      s,
      fog: Math.max(0.35, Math.min(1, 1 - 0.55 * z)),
    };
  };

  const hubRel = rotate(margin - 0.5, 0);
  const hub = project(centerX + hubRel.x * width, centerY + (hubRel.y - lift) * height);
  const hubX = hub.x;
  const hubY = hub.y;

  const fracAlong = (i: number, n: number) => (i + 1) / (n + 1);
  const hostSpread = new Map(hosts.map((n, i) => [n, fracAlong(i, hosts.length)]));
  const otherSpread = new Map(others.map((n, i) => [n, fracAlong(i, others.length)]));
  // across the host axis, turning with the layout
  const laneOff = new Map(hosts.map((n, i) => [n,
    lerp((i % lanesC - (lanesC - 1) / 2) * LANE_C, (i % lanesE) * LANE_E, t)]));
  // collapsed lanes side by side, so depth apart, expanded ones, depth from the tilt
  const laneDepth = new Map(hosts.map((n, i) => [n, (1 - t) * 0.7 * (i % lanesC - (lanesC - 1) / 2)]));

  // flat layout position, before the tilt
  const flatOf = (name: string, isHost: boolean) => {
    const frac = (isHost ? hostSpread : otherSpread).get(name)!;
    const axisFrac = isHost ? 0 : OTHERS_AXIS;
    const rel = rotate(axisFrac, frac - 0.5);
    const off = isHost ? laneOff.get(name)! : grow;
    return {
      x: centerX + rel.x * width + off * cos,
      y: centerY + (rel.y - (isHost ? lift : 0)) * height + off * sin,
      depth: isHost ? laneDepth.get(name)! : 0,
    };
  };
  const posOf = (name: string, isHost: boolean) => {
    const f = flatOf(name, isHost);
    return project(f.x, f.y, f.depth);
  };
  const edgeFog = (a: Projected, b: Projected) => `stroke-opacity:${((a.fog + b.fog) / 2).toFixed(3)}`;

  // fainter peer lines the more there are
  const n = hosts.length;
  const o = others.length;
  meshSvg.style.setProperty('--fade', Math.min(1, Math.sqrt(12 / Math.max(1, (n * (n - 1) + o * (o - 1)) / 2 + n * o))).toFixed(3));

  // every device reaching every other, a line per pair, same-group pairs
  // arced outward, the bulge itself rotating with the layout
  const groupMesh = (names: string[], isHost: boolean) => {
    const zoom = width / 232;
    const bulgeStep = zoom * Math.min(7, 60 / Math.max(1, names.length - 2));
    const bulgeAngle = t * (Math.PI / 2);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const p1 = posOf(names[i]!, isHost);
        const p2 = posOf(names[j]!, isHost);
        const bulge = 12 * zoom + (j - i - 1) * bulgeStep;
        const cx = (p1.x + p2.x) / 2 + bulge * Math.cos(bulgeAngle);
        const cy = (p1.y + p2.y) / 2 + bulge * Math.sin(bulgeAngle);
        const other = names[i] === st.selfHost ? names[j] : names[j] === st.selfHost ? names[i] : null;
        const touched = isHost && other && touchedHosts.has(other);
        // flipped when self is p2, so the pulse runs self->target
        const [start, end] = touched && names[j] === st.selfHost ? [p2, p1] : [p1, p2];
        const attrs: Record<string, string> = {
          d: `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`,
          class: touched ? 'mesh-line-peer touched' : 'mesh-line-peer', style: edgeFog(p1, p2),
        };
        if (touched) attrs.id = `peer-${other}`;
        edges.appendChild(svgEl('path', attrs));
      }
    }
  };
  groupMesh(hosts, true);
  groupMesh(others, false);
  for (const name of others) {
    for (const m of hosts) {
      const p1 = posOf(m, true);
      const p2 = posOf(name, false);
      edges.appendChild(svgEl('line', {
        x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, class: 'mesh-line-peer', style: edgeFog(p1, p2),
      }));
    }
  }

  const hubR = 4 * hub.s;
  meshSvg.appendChild(svgEl('rect', { x: hubX - hubR, y: hubY - hubR, width: hubR * 2, height: hubR * 2, class: 'mesh-hub' }));
  const hubDns = svgEl('text', {
    x: hubX, y: hubY + 12 * hub.s + 4, 'text-anchor': 'middle', class: 'mesh-hub-dns', style: `font-size:${6 * hub.s}px`,
  });
  hubDns.textContent = st.meshDomain || 'tailnet';
  meshSvg.appendChild(hubDns);

  // spokes on the tunnel, only this node's highlighted
  hosts.forEach((m) => {
    const p = posOf(m, true);
    const isSelf = m === st.selfHost;
    const spoke: Record<string, string | number> = {
      x1: hubX, y1: hubY, x2: p.x, y2: p.y, class: isSelf ? 'mesh-line-tunnel self' : 'mesh-line-tunnel', style: edgeFog(hub, p),
    };
    if (isSelf) spoke.id = 'mesh-tunnel-self';
    edges.appendChild(svgEl('line', spoke));
  });

  // far to near, so nearer squares overlap farther ones
  const byDepth = hosts.map((m): [string, Projected] => [m, posOf(m, true)]).sort((a, b) => a[1].s - b[1].s);
  byDepth.forEach(([m, p]) => {
    const own = grouped.get(m)!;
    const isSelf = m === st.selfHost;
    // the new self pulsing until a switch is answered
    const cls = isSelf ? (hostSwitch ? 'self pending' : 'self') : own.length ? 'active' : 'idle';
    const os = hostPlatform.get(m);
    drawNode(p.x, p.y, m, cls,
      `${m}${os ? ` (${os})` : ''}: ${own.length} service${own.length === 1 ? '' : 's'}`,
      { host: isSelf ? '' : m, scale: p.s, opacity: p.fog });
    if (meshModels.has(m)) drawModelMarker(p.x, p.y, meshModels.get(m)!, p.s, p.fog);
    const gitHost = st.gitHostsList.find((h) => h.host === m);
    if (gitHost) drawGitMarker(p.x, p.y, gitHost, p.s);
    const flat = flatOf(m, true);

    // a row below their host as the panel expands, on it (invisible) at t=0,
    // so a pulse always has a target
    const rowZoom = width / 232;
    const gapMax = 20 * rowZoom;
    // no wider than the space to the next host in its lane
    const rowMax = Math.min(45 * rowZoom, 0.7 * lanesE * (width / (hosts.length + 1)));
    const gap = own.length > 1 ? Math.min(gapMax, rowMax / (own.length - 1)) : 0;
    const rowWidth = (own.length - 1) * gap;
    const dropY = flat.y + CHILD_BASE;
    own.forEach((r, i) => {
      const c = project(lerp(flat.x, flat.x - rowWidth / 2 + i * gap, t), lerp(flat.y, dropY, t), flat.depth);
      const key = serviceKey(r);
      const svcTouched = touchedServices.has(key);
      const stem: Record<string, string | number> = {
        x1: p.x, y1: p.y, x2: c.x, y2: c.y,
        class: svcTouched ? 'mesh-line-stem touched' : 'mesh-line-stem',
        style: `opacity:${t};${edgeFog(p, c)}`,
      };
      if (svcTouched) stem.id = `stem-${key}`;
      edges.appendChild(svgEl('line', stem));
      drawNode(c.x, c.y, r.name, svcTouched ? 'svc touched' : 'svc', r.public || r.master !== undefined ? `${r.name} (public, no phosphorus login)` : r.name,
        { size: 1.8 * c.s, opacity: t * c.fog, noLabel: true });
    });
  });

  // no spoke, not routable through the tunnel
  others.forEach((name) => {
    const { os } = outside.get(name)!;
    const p = posOf(name, false);
    drawNode(p.x, p.y, name, 'outside',
      `${name}${os ? ` (${os})` : ''}: in-mesh`, { scale: p.s, opacity: p.fog });
  });
  fitMesh(width, height + grow, t ? expanded : collapsed);
}

// viewBox zoomed onto what was drawn, clear of the legend band, at most MESH_ZOOM_MAX
const MESH_ZOOM_MAX = 1.8;
function fitMesh(w: number, h: number, dims: Dims) {
  const b = meshSvg.getBBox();
  const u = w / dims.widthPx;
  const pad = 6 * u;
  const top = dims.legendPx * u;
  const z = Math.min(MESH_ZOOM_MAX, w / (b.width + 2 * pad), (h - top) / (b.height + 2 * pad));
  const vw = w / z;
  const vh = h / z;
  const vx = b.x + b.width / 2 - vw / 2;
  const vy = b.y + b.height / 2 - (vh + top / z) / 2;
  meshSvg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
}

// --- the mesh: the tray's icon, its graph and pings in a popup above it

export function dkMeshTray(anchor?: HTMLElement): HTMLElement {
  const wrap = el('div', 'dk-tray-wrap');
  const b = Object.assign(el('button', 'dk-tray'), { type: 'button', title: 'mesh', ariaLabel: 'mesh' });
  b.setAttribute('aria-expanded', 'false');
  b.appendChild(dkGlyph(DK_GLYPHS.mesh!));
  const pop = Object.assign(el('div', 'dk-mesh-pop dk-pop'), { hidden: true }) as Pop;
  wrap.append(b, pop);
  // a column up the screen's right edge, the button at its bottom left corner
  const size = meshUi.size || { w: 320, h: 540 };
  dkAnchor(pop, anchor || b, { fill: size.w, tall: size.h });
  // its top left corner dragged for a size, the popup pinned bottom right
  const grip = Object.assign(el('span', 'dk-mesh-grip'), { title: 'resize' });
  pop.append(grip);
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const w0 = pop.offsetWidth;
    const h0 = pop.offsetHeight;
    const move = (ev: PointerEvent) => {
      meshUi.size = { w: Math.max(240, Math.round(w0 + x0 - ev.clientX)), h: Math.max(260, Math.round(h0 + y0 - ev.clientY)) };
      pop.dkAnchor!.fill = meshUi.size.w;
      pop.dkAnchor!.tall = meshUi.size.h;
      pop.style.width = '';
      pop.dkPlace!();
    };
    const up = () => { grip.removeEventListener('pointermove', move); saveMeshUi(); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  const fit = new ResizeObserver(() => { meshDims = null; if (!pop.hidden && !meshAnimFrame) drawMesh(); });
  const show = (on: boolean) => {
    if (!on && pop.hidden) return;
    if (on) dkPopsClose('mesh');
    pop.hidden = !on;
    b.setAttribute('aria-expanded', String(on));
    if (on) {
      pop.appendChild(meshPanel);
      fit.observe(pop);
      meshDims = null;
      // measured while stashed, 0 tall: measured again now it shows
      meshStatsDirty = true;
      drawMesh();
      pingHosts();
    } else {
      fit.disconnect();
      stash.prepend(meshPanel);
    }
  };
  b.addEventListener('click', () => show(pop.hidden as boolean));
  // a press anywhere else closes it
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !wrap.contains(e.target as Node)) show(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });
  dk.meshTray = { show };
  return wrap;
}
