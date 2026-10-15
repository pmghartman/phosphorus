import { renderMd, mdBlocks, fitMath } from './md.js';
import { parserFor, parserNow, highlight, syntaxErrors } from './lezer.js';

// the page's vendor files, hashed by the build
const ASSETS = __ASSETS__;

// --- self / routes ------------------------------------------------------
// everything from /api/state, pushed, see connectState at the bottom
let selfHost = '';
// BASE_DOMAIN from /api/state, the page's own host until the first answer
let baseDomain = location.hostname;
// games joined at <name>.phosphorus
const gameZone = 'phosphorus';
const aboutVersion = document.getElementById('about-version');
const topUpdate = document.getElementById('top-update');

// the desktop's apps up and not minimized, for each view's own watchers
const deskApps = new Set();
// unread lines, for the chat icon's and task's badges
let deskNews = 0;

function serviceUrl(route) {
  const base = route.base_path ? `${route.base_path.replace(/^\/+|\/+$/g, '')}/` : '';
  if (route.mode === 'subdomain') return `https://${route.name}.${baseDomain}/${base}`;
  return `/${route.host}/${route.name}/${base}`;
}

const serviceKey = (route) => `${route.host}::${route.name}`;

// key -> { win, host, name } for each service opened from here whose tab is
// still open, driving the touched/purple path and the packet pulse
const activeConnections = new Map();

// a closed tab's line dropped from the graph, checked every second
function pruneConnections() {
  let changed = false;
  for (const [key, conn] of activeConnections) {
    if (conn.win.closed) { activeConnections.delete(key); changed = true; }
  }
  if (changed) drawMesh();
}

// hosts whose frontend answers, each one terminal tab
let terminalHosts = [];

// a host's OS, from /api/state's tailnet (tailscale itself sees every
// host as linux)
const hostPlatform = new Map();

// round-trip ms of the mesh poller's snapshot call to that host, null until
// measured
const hostRtt = new Map();

// host -> last 20 rttMs samples, oldest first, for the stats table sparkline,
// one a second at most so a 100ms poll can't make the table flicker
const rttHistory = new Map();
const RTT_HISTORY_LEN = 20;
const RTT_SAMPLE_MS = 1000;
const rttSampledAt = new Map();
// the table's number: the median of the last few samples
const RTT_SHOWN_OF = 5;

// forgejo's service name, its own app rather than a service icon
const GIT_SERVICE = 'git';
// the git service, and every git host's role and lag
let gitRoute = null;
let gitHostsList = [];

function renderRoutes(routes, tailnet) {
  terminalHosts = tailnet.filter((d) => d.phosphorus).map((d) => d.name);
  const services = routes.filter((r) => r.type !== 'game' && r.name !== GIT_SERVICE);
  renderGames(routes.filter((r) => r.type === 'game'));
  gitRoute = routes.find((r) => r.name === GIT_SERVICE) || null;
  renderMesh(routes, tailnet);
  dkRoutes(services);
  dkHostsGone();
}

// a host gone from the mesh: its terminals closed, its chip red until it answers again
function dkHostsGone() {
  const up = new Set([...terminalHosts, selfHost]);
  for (const w of [...dk.wins.values()]) if (w.kind === 'term' && w.host && !up.has(w.host)) dkClose(w, true);
  dkChips();
}

// a bare POST's failure as text, blank when it went through
async function postFailure(url) {
  try {
    const res = await fetch(url, { method: 'POST' });
    if (res.ok) return '';
    const body = await res.json().catch(() => ({}));
    return body.error || `status ${res.status}`;
  } catch (err) {
    return err.message;
  }
}

// --- game servers -----------------------------------------------------------

// not links: joined in-game at <name>.<zone>, tailnet only, play/stop open to
// any viewer

const gameBusy = new Map(); // key -> action, while its press is in flight
const gameError = new Map(); // key -> message from the last failed press
let lastGamesSig = '';
let lastGames = [];

// stopping still counted as up, so a press never reshuffles the list
const gameUp = (g) => g.status === 'online' || g.status === 'stopping';

function gameIcon(kind) {
  const icon = svgEl('svg', { viewBox: '0 0 10 10', 'aria-hidden': 'true' });
  if (kind === 'play') icon.appendChild(svgEl('path', { d: 'M 2.5 1.5 L 8.5 5 L 2.5 8.5 Z' }));
  if (kind === 'pause') {
    icon.appendChild(svgEl('rect', { x: 2, y: 1.5, width: 2, height: 7 }));
    icon.appendChild(svgEl('rect', { x: 6, y: 1.5, width: 2, height: 7 }));
  }
  if (kind === 'busy') icon.appendChild(svgEl('path', { d: 'M 5 1.5 A 3.5 3.5 0 1 1 1.5 5', class: 'game-spin' }));
  if (kind === 'copy') {
    icon.appendChild(svgEl('rect', { x: 3.5, y: 3.5, width: 5, height: 5, class: 'stroke' }));
    icon.appendChild(svgEl('path', { d: 'M 1.5 6.5 V 1.5 H 6.5', class: 'stroke' }));
  }
  if (kind === 'check') icon.appendChild(svgEl('path', { d: 'M 1.5 5.5 L 4 8 L 8.5 2', class: 'stroke' }));
  return icon;
}

// clipboard API https only and deniable, execCommand for both
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

// one-use ephemeral tag:guest key, minted per click
const joinKeyBtn = document.getElementById('join-key-btn');
joinKeyBtn.addEventListener('click', async () => {
  const box = document.getElementById('join-key');
  box.querySelectorAll('.join-key-cmd, .join-key-err').forEach((el) => el.remove());
  joinKeyBtn.disabled = true;
  try {
    const r = await fetch('/api/join-key', { method: 'POST' });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || !out.key) throw new Error(out.error || `status ${r.status}`);
    const cmd = `tailscale up --auth-key=${out.key}`;
    const row = document.createElement('div');
    row.className = 'join-key-cmd';
    row.title = 'run once tailscale is installed, single use, gone in 3 days';
    const code = document.createElement('code');
    code.textContent = cmd;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'game-copy';
    copy.title = 'copy';
    copy.appendChild(gameIcon('copy'));
    copy.addEventListener('click', () => copyText(cmd).then(() => {
      copy.replaceChildren(gameIcon('check'));
      setTimeout(() => copy.replaceChildren(gameIcon('copy')), 1200);
    }).catch(() => {}));
    row.append(code, copy);
    box.appendChild(row);
  } catch (err) {
    const e = document.createElement('div');
    e.className = 'join-key-err';
    e.textContent = `no key: ${err.message}`;
    box.appendChild(e);
  } finally {
    joinKeyBtn.disabled = false;
  }
});

// rebuilt only on change, a 500ms rebuild eating clicks mid-press
function renderGames(games) {
  lastGames = games.sort((a, b) => gameUp(b) - gameUp(a)
    || a.host.localeCompare(b.host) || a.name.localeCompare(b.name));
  const sig = JSON.stringify([games, [...gameBusy], [...gameError]]);
  if (sig === lastGamesSig) return;
  lastGamesSig = sig;

  const list = document.getElementById('game-servers-list');
  const focused = document.activeElement?.closest?.('.game-card')?.dataset.key;
  list.innerHTML = '';
  if (!games.length) {
    list.innerHTML = '<li class="empty">none yet</li>';
    return;
  }
  for (const g of games) {
    const key = serviceKey(g);
    const li = document.createElement('li');
    const card = document.createElement('div');
    card.className = 'game-card';
    card.tabIndex = 0;
    card.dataset.key = key;

    // online: pause (stops it), offline: play (starts it), in between: spinner
    const busy = gameBusy.has(key) || g.status === 'starting' || g.status === 'stopping';
    const action = gameUp(g) ? 'stop' : 'start';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `game-btn ${busy ? 'busy' : g.status}`;
    btn.disabled = busy || !g.controllable;
    btn.title = busy ? `${gameBusy.get(key) || g.status}…`
      : g.controllable ? `${g.status}: ${action === 'start' ? 'play' : 'stop'}` : `${g.status}: no start/stop commands`;
    btn.appendChild(gameIcon(busy ? 'busy' : action === 'start' ? 'play' : 'pause'));
    btn.addEventListener('click', () => pressGame(g, action));

    const info = document.createElement('div');
    info.className = 'game-info';
    const title = document.createElement('div');
    title.textContent = g.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = g.host;
    title.appendChild(meta);

    const address = `${g.name}.${gameZone}:${g.port}`;
    const detail = document.createElement('div');
    detail.className = 'game-detail';
    const addr = document.createElement('span');
    addr.className = 'game-addr';
    addr.textContent = address;
    addr.title = 'join at this address, on the tailnet';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'game-copy';
    copy.title = 'copy';
    copy.appendChild(gameIcon('copy'));
    copy.addEventListener('click', () => copyText(address).then(() => {
      copy.replaceChildren(gameIcon('check'));
      setTimeout(() => copy.replaceChildren(gameIcon('copy')), 1200);
    }).catch(() => {}));
    detail.append(addr, copy);
    info.append(title);
    if (gameError.has(key)) {
      const err = document.createElement('div');
      err.className = 'game-error';
      err.textContent = gameError.get(key);
      info.appendChild(err);
    }

    card.append(btn, info, detail);
    li.appendChild(card);
    list.appendChild(li);
  }
  if (focused) [...list.querySelectorAll('.game-card')].find((c) => c.dataset.key === focused)?.focus();
}

async function pressGame(g, action) {
  const key = serviceKey(g);
  gameBusy.set(key, action);
  gameError.delete(key);
  renderGames(lastGames);
  const why = await postFailure(`/api/games/${encodeURIComponent(g.host)}/${encodeURIComponent(g.name)}/${action}`);
  if (why) gameError.set(key, `${action} failed: ${why}`);
  gameBusy.delete(key);
  renderGames(lastGames);
  pollState();
  const shown = gameError.get(key);
  if (shown) setTimeout(() => { if (gameError.get(key) === shown) { gameError.delete(key); renderGames(lastGames); } }, 15000);
}

// --- mesh status diagram --------------------------------------------------
// one list for good, each matchMedia() call another for the engine to re-evaluate
const mobileQuery = matchMedia('(max-width: 720px)');
const meshSvg = document.getElementById('mesh-svg');
const meshCount = document.getElementById('mesh-count');
const meshPanel = document.getElementById('mesh-panel');
const meshGraphWrap = document.getElementById('mesh-graph-wrap');
const meshStats = document.getElementById('mesh-stats');
const meshStatsRows = document.getElementById('mesh-stats-rows');
const meshHeader = document.querySelector('.mesh-header');
const stash = document.querySelector('.stash');
const SVG_NS = 'http://www.w3.org/2000/svg';

// the stats table's unclipped height, cached whenever renderMeshStats() runs,
// reserved by meshLayoutParams() when expanded
let lastStatsHeight = 0;

// stats table DOM rebuilt only on real data changes, never per
// expand/collapse frame
let meshStatsDirty = true;

// expanded: fewer logical units per pixel width, a real zoom, the popup's
// height whatever the stats table leaves
function meshLayoutParams(expanded) {
  const width = expanded ? 200 : 232;
  const box = meshPanel.closest('.dk-mesh-pop');
  const bodyH = (box?.clientHeight || 240) - meshHeader.clientHeight - (expanded ? lastStatsHeight : 0);
  const widthPx = meshGraphWrap.clientWidth || width;
  // the legend expanded only, hidden, not gone, so still measured
  const legend = meshGraphWrap.querySelector('.mesh-legend');
  return { width, height: width * (Math.max(60, bodyH) / widthPx), widthPx, legendPx: expanded ? legend.offsetTop + legend.offsetHeight : 0 };
}

// host row to the non-phosphorus devices, a frame fraction, LIFT the
// expanded host row's rise
const OTHERS_AXIS = 0.34;
const LIFT = 0.1;

// both ends of the tween, measured once per animation or static draw,
// no per-frame read forcing a reflow
let meshDims = null;
function meshDimsNow() {
  if (!meshDims || !meshAnimFrame) meshDims = { collapsed: meshLayoutParams(false), expanded: meshLayoutParams(true) };
  return meshDims;
}

// meshT: 0 = base (hub | hosts | others columns, 25% height), 1 = expanded
// (hub-on-top rows, 50% height), lerped by drawMesh() each frame
let meshT = 0;
let meshAnimFrame = null;

function animateMeshT(target) {
  if (meshAnimFrame) cancelAnimationFrame(meshAnimFrame);
  meshDims = null;
  // quick, and fastest at the start, so the click answers at once
  const duration = 200;
  const start = performance.now();
  const from = meshT;
  const easeOutCubic = (p) => 1 - (1 - p) ** 3;
  const step = (now) => {
    const p = Math.min(1, (now - start) / duration);
    meshT = from + (target - from) * easeOutCubic(p);
    drawMesh();
    meshAnimFrame = p < 1 ? requestAnimationFrame(step) : null;
  };
  meshAnimFrame = requestAnimationFrame(step);
}

// snap: straight to the end, no table fading in or out on the way
function setMeshExpanded(willExpand, snap) {
  if (willExpand === meshPanel.classList.contains('expanded')) return;
  meshPanel.classList.toggle('expanded', willExpand);
  if (!snap) { animateMeshT(willExpand ? 1 : 0); return; }
  if (meshAnimFrame) cancelAnimationFrame(meshAnimFrame);
  meshAnimFrame = null;
  meshT = willExpand ? 1 : 0;
  meshDims = null;
  drawMesh();
}

// always expanded, its table always up
meshPanel.classList.add('expanded');
meshT = 1;

window.addEventListener('resize', () => {
  if (!meshAnimFrame) drawMesh();
});

// --- serving host -----------------------------------------------------------
// the host serving this page, held by the ingress's phosphorus-host cookie

const phosphorusHosts = () => meshTailnet.filter((d) => d.phosphorus).map((d) => d.name).sort();

// {to, from, at} of a switch awaiting the new host's first answer
let hostSwitch = null;
// grace for a late poll from the old host
const HOST_SWITCH_MS = 4000;
let hostNoteTimer = null;

// beside the task bar's hosts, kind: pending, ok or error, the last two fading on their own
function setHostNote(text, kind) {
  clearTimeout(hostNoteTimer);
  const note = document.querySelector('.dk-host-note');
  if (!note) return;
  note.textContent = text;
  note.className = `dk-host-note ${kind}`;
  note.hidden = false;
  if (kind !== 'pending') hostNoteTimer = setTimeout(() => { note.hidden = true; }, kind === 'ok' ? 2500 : 6000);
}

// drawn at once as the new self, confirmed or undone by the state
function redrawHost(host) {
  selfHost = host;
  meshSig = '';
  renderMesh(meshRoutes, meshTailnet);
  dkChips();
}

async function switchHost(host) {
  if (!host || host === (hostSwitch?.to || selfHost)) return;
  const from = hostSwitch?.from || selfHost;
  hostSwitch = { to: host, from, at: Date.now() };
  setHostNote(`switching to ${host}…`, 'pending');
  redrawHost(host);
  const r = await fetch(`/api/host?host=${encodeURIComponent(host)}`, { method: 'POST' }).catch(() => null);
  if (hostSwitch?.to !== host) return;
  if (!r || !r.ok) {
    hostSwitch = null;
    setHostNote(`couldn't switch to ${host}: ${r ? (await r.text()).trim() : 'no answer'}`, 'error');
    redrawHost(from);
    return;
  }
  // chat, state and stats reconnected through the new host
  ws?.close();
  connectState();
  if (stWs) statusConnect();
}

// the served host from the state, held at the pending one until it answers
function settleHost(served) {
  const sw = hostSwitch;
  if (!sw) return served;
  // the pulse dropped on the next draw
  meshSig = '';
  if (served === sw.to) {
    hostSwitch = null;
    setHostNote(`hosted by ${served}`, 'ok');
    return served;
  }
  if (Date.now() - sw.at < HOST_SWITCH_MS) return sw.to;
  hostSwitch = null;
  setHostNote(`${sw.to} didn't take over, still on ${served}`, 'error');
  return served;
}

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

// inline cylinder, sized to the text beside it, stroked in currentColor
function databaseIcon() {
  const x = 0.5;
  const y = 0.5;
  const w = 6;
  const h = 7;
  const ry = 1.5;
  const icon = svgEl('svg', { viewBox: '0 0 7 8', class: 'db-icon', 'aria-hidden': 'true' });
  icon.appendChild(svgEl('ellipse', { cx: x + w / 2, cy: y + ry, rx: w / 2, ry }));
  icon.appendChild(svgEl('path', { d: `M ${x} ${y + ry} V ${y + h - ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h - ry} V ${y + ry}` }));
  icon.appendChild(svgEl('path', { d: `M ${x} ${y + h / 2} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + h / 2}` }));
  return icon;
}

// a node's half-width before the depth scale
const NODE_HALF = 3;

// one square plus its name, the rest in the tooltip, opts: size (half-width),
// scale (depth), opacity, noLabel, host (a host to switch to), all optional
function drawNode(x, y, name, cls, tooltip, opts) {
  const o = opts || {};
  const scale = o.scale || 1;
  const size = o.size || NODE_HALF * scale;
  const opacity = o.opacity === undefined ? 1 : o.opacity;
  // a host: square, name and a wider hit area as one target
  const parent = o.host
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
function drawGitMarker(x, y, h, scale = 1) {
  const master = h.reachable && h.role === 'master';
  const state = !h.reachable ? 'down' : master ? 'master' : h.eligible ? 'ok' : 'stale';
  const g = svgEl('g', { class: `mesh-git ${state}`, transform: `translate(${x + 4.5 * scale} ${y - 4.5 * scale}) scale(${0.9 * scale})` });
  const title = svgEl('title', {});
  title.textContent = { master: 'git master', ok: 'git servant, in sync', stale: 'git servant, out of date', down: 'git servant, unreachable' }[state];
  g.appendChild(title);
  if (master) {
    // no CSS size for a nested svg, only its own attributes
    const db = databaseIcon();
    db.setAttribute('width', 7);
    db.setAttribute('height', 8);
    g.appendChild(db);
  } else {
    const star = svgEl('text', { x: 3.5, y: 6.5, 'text-anchor': 'middle', class: 'mesh-git-star' });
    star.textContent = '*';
    g.appendChild(star);
  }
  meshSvg.appendChild(g);
}

document.querySelector('.mesh-legend-git').prepend(databaseIcon());

// the gradient sliding by smil, out of the stylesheet's reduced-motion
// rule's reach, so held still here the same way
const svgDefs = document.querySelector('.svg-defs');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const syncMotion = () => (reduceMotion.matches ? svgDefs.pauseAnimations() : svgDefs.unpauseAnimations());
reduceMotion.addEventListener('change', syncMotion);
syncMotion();

// left of a model host, mirroring the git mark: c the chimp, o the orangutan,
// in the glyph's colours, dimmed while not loaded
function drawModelMarker(x, y, mm, scale = 1, opacity = 1) {
  const mark = svgEl('text', {
    x: x - 4.5 * scale, y: y - 1.2 * scale, 'text-anchor': 'end', class: `mesh-model-mark${mm.ready ? '' : ' down'}`,
    style: `font-size:${7 * scale}px;opacity:${opacity}`,
  });
  mark.textContent = mm.roles.map((r) => r[0]).join('');
  const title = svgEl('title', {});
  title.textContent = `${mm.roles.join(' and ')} model: ${mm.file || 'no model yet'}${mm.ready ? '' : ', not loaded'}`;
  mark.appendChild(title);
  meshSvg.appendChild(mark);
}

// a model host's roles, as each now answers
function modelRoles(x, model) {
  return [x.host === model.chimp && 'chimp', x.host === model.orangutan && 'orangutan'].filter(Boolean);
}

let meshRoutes = [];
let meshTailnet = [];
// the chimp's and orangutan's hosts, marked in the glyph's colours
let meshModels = new Map();
let meshSig = '';

function renderMesh(routes, tailnet) {
  meshRoutes = routes;
  meshTailnet = tailnet;
  // once per real poll, never per animation frame
  const now = Date.now();
  let sampled = false;
  for (const d of tailnet) {
    if (!d.phosphorus || typeof d.rttMs !== 'number') continue;
    if (now - (rttSampledAt.get(d.name) || 0) < RTT_SAMPLE_MS) continue;
    rttSampledAt.set(d.name, now);
    const hist = rttHistory.get(d.name) || [];
    hist.push(d.rttMs);
    if (hist.length > RTT_HISTORY_LEN) hist.shift();
    rttHistory.set(d.name, hist);
    sampled = true;
  }
  // nothing redrawn for a poll changing nothing drawn (a full rebuild at 10/s grew the tab)
  const sig = JSON.stringify([selfHost, routes.map((r) => [r.host, r.name]),
    tailnet.map((d) => [d.name, !!d.phosphorus, d.os || '', typeof d.rttMs === 'number'])]);
  if (sig === meshSig && !sampled) return;
  meshSig = sig;
  meshStatsDirty = true;
  if (!meshAnimFrame) drawMesh();
}

const lerp = (a, b, t) => a + (b - a) * t;

// ping bucket -> CSS class, null/undefined meaning unmeasured, not offline
function pingClass(rttMs) {
  if (rttMs === null || rttMs === undefined) return '';
  if (rttMs <= 40) return 'good';
  if (rttMs <= 150) return 'slow';
  return 'bad';
}

function pingText(rttMs) {
  if (rttMs === null || rttMs === undefined) return '–';
  return `${rttMs}ms`;
}

// unmeasured kept unmeasured at once, otherwise the recent median
function steadyRtt(name) {
  if (typeof hostRtt.get(name) !== 'number') return null;
  const recent = (rttHistory.get(name) || []).slice(-RTT_SHOWN_OF).sort((a, b) => a - b);
  return recent.length ? recent[recent.length >> 1] : hostRtt.get(name);
}

// inline trend line over the last RTT samples, '' without enough history,
// fixed 0..SPARK_MAX_MS scale so 1ms jitter stays flat
const SPARK_MAX_MS = 150;
function sparkline(history, cls) {
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
function renderMeshStats(hosts, grouped) {
  meshStatsRows.innerHTML = '';
  const addRow = (name, os, rttMs, dotCls) => {
    const row = document.createElement('div');
    row.className = 'mesh-stat-row';
    if (name !== selfHost) {
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
    const dotCls = m === selfHost ? 'self' : grouped.get(m).length ? 'active' : 'idle';
    addRow(m, hostPlatform.get(m), steadyRtt(m), dotCls);
  }

  // everything below measuring the table, 0 under display:none, so forced
  // visible for these reads, then restored exactly as found
  const prevDisplay = meshStats.style.display;
  const prevMaxHeight = meshStats.style.maxHeight;
  meshStats.style.display = 'flex';
  meshStats.style.maxHeight = 'none';

  // up to 4 rows tall, then a scroll, measured off a real row, not guessed
  const firstRow = meshStatsRows.firstElementChild;
  meshStatsRows.style.maxHeight = firstRow ? `${firstRow.offsetHeight * 4}px` : '';

  // scrollHeight: the natural height, whatever max-height drawMesh() animates
  lastStatsHeight = meshStats.scrollHeight;
  meshDims = null;
  meshStats.style.display = prevDisplay;
  meshStats.style.maxHeight = prevMaxHeight;
}

// --- git backups: each git host's copy and how far it trails the master

const meshGit = document.getElementById('mesh-git');
const meshGitRows = document.getElementById('mesh-git-rows');
// five cells a band, each filled across its own seconds
const GIT_LAG_CELLS = 5;
const GIT_LAG_BANDS = [['good', 0, 8], ['slow', 8, 15], ['stale', 15, 60]];
let meshGitHosts = '';

function ago(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

function lagMeter(sec) {
  let html = '';
  let empty = 0;
  for (const [cls, from, to] of GIT_LAG_BANDS) {
    const full = Math.round(Math.max(0, Math.min(1, (sec - from) / (to - from))) * GIT_LAG_CELLS);
    if (full) html += `<span class="${cls}">${'█'.repeat(full)}</span>`;
    empty += GIT_LAG_CELLS - full;
  }
  return `${html}<span class="off">${'░'.repeat(empty)}</span>`;
}

function gitBackupText(h, masterGen) {
  if (!h.reachable) return 'unreachable';
  if (h.gen == null || h.ageSec == null) return 'no data yet';
  const parts = [h.role === 'master' ? 'master, live' : masterGen != null && h.gen < masterGen ? 'older lineage' : h.role];
  if (h.role !== 'master' && !h.eligible) parts.push('catching up');
  if (h.updating) parts.push('updating');
  return parts.join(' · ');
}

// every state push, ageSec fresh each time; the table remeasured on a new host set
function renderMeshGit() {
  meshGit.hidden = !gitHostsList.length;
  const masterGen = gitHostsList.find((h) => h.role === 'master' && h.reachable)?.gen ?? null;
  meshGitRows.innerHTML = gitHostsList.map((h) => {
    const master = h.reachable && h.role === 'master';
    const cls = master ? 'master' : !h.reachable ? 'down' : !h.eligible ? 'catching' : '';
    const behind = h.reachable && !master && h.ageSec != null
      ? `<span class="git-lag" title="green to 8s, yellow to 15s, red to 60s">${lagMeter(h.ageSec)}</span><span class="git-ago">${ago(h.ageSec)}</span>` : '';
    return `<div class="mesh-git-row ${cls}"><span class="mesh-stat-name"><span class="mesh-git-dot"></span>`
      + `<span class="mesh-stat-nm">${esc(h.host)}</span><span class="mesh-git-text">${esc(gitBackupText(h, masterGen))}</span></span>`
      + `<span class="mesh-git-behind">${behind}</span></div>`;
  }).join('');
  const sig = gitHostsList.map((h) => h.host).join();
  if (sig !== meshGitHosts) {
    meshGitHosts = sig;
    meshStatsDirty = true;
    if (!meshAnimFrame) drawMesh();
  }
}

let pulseAnimFrame = null;

// the touched elements drawMesh() drew (tunnel spoke, peer arc, service stem)
// via getPointAtLength(), so the pulse rides the real curve
function pulsePoint(key, host, distFrac) {
  const ids = ['mesh-tunnel-self'];
  if (host !== selfHost) ids.push(`peer-${host}`);
  ids.push(`stem-${key}`);
  const segs = ids.map((id) => document.getElementById(id)).filter(Boolean);
  if (!segs.length) return null;

  const lens = segs.map((el) => el.getTotalLength());
  const total = lens.reduce((a, b) => a + b, 0);
  let dist = distFrac * total;
  for (let i = 0; i < segs.length; i++) {
    if (dist <= lens[i] || i === segs.length - 1) return segs[i].getPointAtLength(Math.min(dist, lens[i]));
    dist -= lens[i];
  }
  return segs[segs.length - 1].getPointAtLength(lens[lens.length - 1]);
}

// one pulse/sec per connection: hub, self, target host if different, target
// service, its own rAF loop while any connection is open
function startPulseLoop() {
  if (pulseAnimFrame) return;
  const tick = (now) => {
    if (!activeConnections.size) { pulseAnimFrame = null; return; }
    // the graph off screen: nothing to measure, the loop kept for its return
    if (!meshPanel.offsetParent) { pulseAnimFrame = requestAnimationFrame(tick); return; }
    const progress = (now / 1000) % 1;
    for (const [key, conn] of activeConnections) {
      const point = pulsePoint(key, conn.host, progress);
      if (!point) continue;
      let mark = document.getElementById(`pulse-${key}`);
      if (!mark || !mark.isConnected) {
        mark = svgEl('rect', { id: `pulse-${key}`, width: 2, height: 2, class: 'mesh-pulse' });
        meshSvg.appendChild(mark);
      }
      mark.setAttribute('x', point.x - 1);
      mark.setAttribute('y', point.y - 1);
      mark.setAttribute('style', `opacity:${Math.sin(progress * Math.PI)}`);
    }
    pulseAnimFrame = requestAnimationFrame(tick);
  };
  pulseAnimFrame = requestAnimationFrame(tick);
}

// pure function of last-fetched data + meshT, called per data poll and per
// animation frame, so layout restructures/rescales instead of a CSS transform
function drawMesh() {
  const t = meshT;

  // hosts a live connection targets, and the specific services it's touching
  const touchedHosts = new Set();
  const touchedServices = new Set();
  for (const conn of activeConnections.values()) {
    touchedHosts.add(conn.host);
    touchedServices.add(serviceKey(conn));
  }

  const routes = meshRoutes;
  const tailnet = meshTailnet;
  const grouped = new Map();
  for (const r of routes) {
    if (!grouped.has(r.host)) grouped.set(r.host, []);
    grouped.get(r.host).push(r);
  }
  // tailnet devices without phosphorus: no routes, known only to the tailnet list
  const outside = new Map();
  for (const d of tailnet) {
    if (d.phosphorus) {
      hostPlatform.set(d.name, d.os || '');
      hostRtt.set(d.name, typeof d.rttMs === 'number' ? d.rttMs : null);
      if (!grouped.has(d.name)) grouped.set(d.name, []);
    } else if (!grouped.has(d.name)) {
      outside.set(d.name, d);
    }
  }
  const hosts = [...grouped.keys()].sort();
  const others = [...outside.keys()].sort();

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
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
  const maxSvc = Math.max(0, ...hosts.map((m) => grouped.get(m).length));
  const CHILD_BASE = 26;
  // crowded hosts staggered into lanes for clear labels: side by side collapsed,
  // stacked rows expanded, each row with room for its services
  const labelW = Math.max(0, ...hosts.map((m) => m.length)) * 4.3 + 6;
  const lanesFor = (span, need, most) => Math.min(most, Math.ceil(need / (span / (hosts.length + 1))));
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
  const rotate = (x, y) => ({ x: x * cos - y * sin, y: x * sin + y * cos });

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
  const project = (x, y, depth = 0) => {
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

  const fracAlong = (i, n) => (i + 1) / (n + 1);
  const hostSpread = new Map(hosts.map((n, i) => [n, fracAlong(i, hosts.length)]));
  const otherSpread = new Map(others.map((n, i) => [n, fracAlong(i, others.length)]));
  // across the host axis, turning with the layout
  const laneOff = new Map(hosts.map((n, i) => [n,
    lerp((i % lanesC - (lanesC - 1) / 2) * LANE_C, (i % lanesE) * LANE_E, t)]));
  // collapsed lanes side by side, so depth apart, expanded ones, depth from the tilt
  const laneDepth = new Map(hosts.map((n, i) => [n, (1 - t) * 0.7 * (i % lanesC - (lanesC - 1) / 2)]));

  // flat layout position, before the tilt
  const flatOf = (name, isHost) => {
    const frac = (isHost ? hostSpread : otherSpread).get(name);
    const axisFrac = isHost ? 0 : OTHERS_AXIS;
    const rel = rotate(axisFrac, frac - 0.5);
    const off = isHost ? laneOff.get(name) : grow;
    return {
      x: centerX + rel.x * width + off * cos,
      y: centerY + (rel.y - (isHost ? lift : 0)) * height + off * sin,
      depth: isHost ? laneDepth.get(name) : 0,
    };
  };
  const posOf = (name, isHost) => {
    const f = flatOf(name, isHost);
    return project(f.x, f.y, f.depth);
  };
  const edgeFog = (a, b) => `stroke-opacity:${((a.fog + b.fog) / 2).toFixed(3)}`;

  // fainter peer lines the more there are
  const n = hosts.length;
  const o = others.length;
  meshSvg.style.setProperty('--fade', Math.min(1, Math.sqrt(12 / Math.max(1, (n * (n - 1) + o * (o - 1)) / 2 + n * o))).toFixed(3));

  // every device reaching every other, a line per pair, same-group pairs
  // arced outward, the bulge itself rotating with the layout
  const groupMesh = (names, isHost) => {
    const zoom = width / 232;
    const bulgeStep = zoom * Math.min(7, 60 / Math.max(1, names.length - 2));
    const bulgeAngle = t * (Math.PI / 2);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const p1 = posOf(names[i], isHost);
        const p2 = posOf(names[j], isHost);
        const bulge = 12 * zoom + (j - i - 1) * bulgeStep;
        const cx = (p1.x + p2.x) / 2 + bulge * Math.cos(bulgeAngle);
        const cy = (p1.y + p2.y) / 2 + bulge * Math.sin(bulgeAngle);
        const other = names[i] === selfHost ? names[j] : names[j] === selfHost ? names[i] : null;
        const touched = isHost && other && touchedHosts.has(other);
        // flipped when self is p2, so the pulse runs self->target
        const [start, end] = touched && names[j] === selfHost ? [p2, p1] : [p1, p2];
        const attrs = {
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
  hubDns.textContent = baseDomain;
  meshSvg.appendChild(hubDns);

  // spokes on the tunnel, only this node's highlighted
  hosts.forEach((m) => {
    const p = posOf(m, true);
    const isSelf = m === selfHost;
    const spoke = {
      x1: hubX, y1: hubY, x2: p.x, y2: p.y, class: isSelf ? 'mesh-line-tunnel self' : 'mesh-line-tunnel', style: edgeFog(hub, p),
    };
    if (isSelf) spoke.id = 'mesh-tunnel-self';
    edges.appendChild(svgEl('line', spoke));
  });

  // far to near, so nearer squares overlap farther ones
  const byDepth = hosts.map((m) => [m, posOf(m, true)]).sort((a, b) => a[1].s - b[1].s);
  byDepth.forEach(([m, p]) => {
    const own = grouped.get(m);
    const isSelf = m === selfHost;
    // the new self pulsing until a switch is answered
    const cls = isSelf ? (hostSwitch ? 'self pending' : 'self') : own.length ? 'active' : 'idle';
    const os = hostPlatform.get(m);
    drawNode(p.x, p.y, m, cls,
      `${m}${os ? ` (${os})` : ''}: ${own.length} service${own.length === 1 ? '' : 's'}`,
      { host: isSelf ? '' : m, scale: p.s, opacity: p.fog });
    if (meshModels.has(m)) drawModelMarker(p.x, p.y, meshModels.get(m), p.s, p.fog);
    const gitHost = gitHostsList.find((h) => h.host === m);
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
      const stem = {
        x1: p.x, y1: p.y, x2: c.x, y2: c.y,
        class: svcTouched ? 'mesh-line-stem touched' : 'mesh-line-stem',
        style: `opacity:${t};${edgeFog(p, c)}`,
      };
      if (svcTouched) stem.id = `stem-${key}`;
      edges.appendChild(svgEl('line', stem));
      drawNode(c.x, c.y, r.name, svcTouched ? 'svc touched' : 'svc', r.name,
        { size: 1.8 * c.s, opacity: t * c.fog, noLabel: true });
    });
  });

  // no spoke, not routable through the tunnel
  others.forEach((name) => {
    const { os } = outside.get(name);
    const p = posOf(name, false);
    drawNode(p.x, p.y, name, 'outside',
      `${name}${os ? ` (${os})` : ''}: in-mesh`, { scale: p.s, opacity: p.fog });
  });
  fitMesh(width, height + grow, t ? expanded : collapsed);
}

// viewBox zoomed onto what was drawn, clear of the legend band, at most MESH_ZOOM_MAX
const MESH_ZOOM_MAX = 1.8;
function fitMesh(w, h, dims) {
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

// each host's own info.json off sys, offline ones too
let hostsInfo = {};

function applyState(state) {
  selfHost = settleHost(state.self.host || '');
  hostsInfo = state.hosts && typeof state.hosts === 'object' ? state.hosts : {};
  if (state.domain) baseDomain = state.domain;
  if (state.self.version) {
    aboutVersion.textContent = `v${state.self.version}`;
  }

  const next = state.gitHosts;
  const gitChanged = JSON.stringify(next.map((h) => [h.host, h.reachable, h.role, h.eligible]))
    !== JSON.stringify(gitHostsList.map((h) => [h.host, h.reachable, h.role, h.eligible]));
  gitHostsList = next;
  renderMeshGit();

  renderRoutes(state.routes, state.tailnet);
  statusState(state);
  modelPresence(state.model);
  const nextModels = new Map((state.model?.models || []).map((x) => [x.host, { file: x.file, ready: x.ready, roles: modelRoles(x, state.model) }])
    .filter(([, v]) => v.roles.length));
  const modelChanged = JSON.stringify([...nextModels]) !== JSON.stringify([...meshModels]);
  meshModels = nextModels;
  if ((gitChanged || modelChanged) && !meshAnimFrame) drawMesh();
  meshLock = state.lock && state.lock.initiator ? state.lock : null;
  renderUpdateButton();
  updateSeen = { tailnet: state.tailnet, selfVersion: state.self.version || '' };
  // ours with its buttons, else a peer's, to watch
  const chain = holdChain(state.chain);
  // a walk starting anywhere opens the pane on every host, once
  if (chain && !chain.done && chain.chainId !== paneOpenedFor && updateConfirm.hidden) {
    paneOpenedFor = chain.chainId;
    updateMesh.hidden = false;
    updateModal.hidden = false;
  }
  // the confirm prompt borrowing this same pane, its text otherwise lost
  if (updateConfirm.hidden) applyChain(chain, !!state.chainMine); else renderVersions();
  // the update icon's dot: a host on another version, or a walk under way
  const mine = state.self.version || '';
  const differs = state.tailnet.some((d) => d.phosphorus && d.version && mine && d.version !== mine);
  const news = differs || !!meshLock || !!(chain && !chain.done);
  topUpdate.toggleAttribute('data-news', news);
  topUpdate.title = `mesh update (u)${meshLock || (chain && !chain.done) ? ', under way' : differs ? ', hosts on different versions' : ''}`;
}

// --- terminals --------------------------------------------------------------
const paneContent = document.getElementById('pane-content');

// xterm only on the first terminal, most visits never opening one
let xtermLoaded = null;
let Terminal = null;
let FitAddon = null;
let WebglAddon = null;
function loadXterm() {
  if (xtermLoaded) return xtermLoaded;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = ASSETS['xterm.css'];
  document.head.appendChild(css);
  xtermLoaded = Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-webgl')])
    .then(([x, f, g]) => { Terminal = x.Terminal; FitAddon = f; WebglAddon = g; })
    .catch((e) => { xtermLoaded = null; throw e; });
  return xtermLoaded;
}

// server's close codes: session gone for good, or taken by another tab
const TERM_ENDED = 4000;
// cmd+c and cmd+v a mac's own, its ctrl+c always ^C
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgentData?.platform || navigator.platform || '');
const TERM_TAKEN = 4001;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10000;
// the sixteen ANSI colors from the page's own tokens, so a restyle reaches
// terminals too: magenta the accent, yellow its orange, blue the sky
const TERM_HUES = {
  red: '--offmesh', green: '--online', yellow: '--accent-2',
  blue: '--sky', magenta: '--accent', cyan: '--teal',
};

const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mixHex = (a, b, t) => `#${hexRgb(a).map((v, i) => Math.round(v + (hexRgb(b)[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;

// read fresh each time so a theme switch reaches open terminals,
// light's tokens already inked for white, only its brights darker
function termTheme() {
  const css = getComputedStyle(document.documentElement);
  const cssVar = (name) => css.getPropertyValue(name).trim();
  const light = document.documentElement.dataset.theme === 'light';
  const fg = cssVar('--fg');
  const theme = {
    background: cssVar('--bg'), foreground: fg,
    cursor: cssVar('--accent'), cursorAccent: cssVar('--bg'),
    selectionBackground: `${cssVar('--accent')}59`,
    black: light ? fg : cssVar('--border'),
    brightBlack: light ? cssVar('--muted') : mixHex(cssVar('--dim'), cssVar('--muted'), 0.5),
    white: light ? cssVar('--dim') : mixHex(cssVar('--muted'), fg, 0.5),
    brightWhite: light ? cssVar('--border') : fg,
  };
  for (const [name, token] of Object.entries(TERM_HUES)) {
    const hue = cssVar(token);
    const bright = `bright${name[0].toUpperCase()}${name.slice(1)}`;
    theme[name] = hue;
    theme[bright] = light ? mixHex(hue, fg, 0.25) : mixHex(hue, '#ffffff', 0.25);
  }
  return theme;
}
const liveTerms = new Set();

// /api/term/<host>: keystrokes and output as binary frames, resize as JSON,
// a dropped socket's rejoin by sid, until the server's ENDED
// login: {user, pass} typed into the host's prompts, unseen
function startTerminal(view, host, sid, resume, shared = false, login = null) {
  let term = null;
  let fit = null;
  let ws = null;
  let observer = null;
  let retry = null;

  // the page's font in before xterm measures its cells
  const fontIn = document.fonts.load('14px "Geist Mono Variable"').catch(() => {});
  const ready = Promise.all([loadXterm(), fontIn]).then(() => {
    term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 14,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font').trim(),
      lineHeight: 1,
      letterSpacing: 0,
      theme: termTheme(),
    });
    liveTerms.add(term);
    // shift+esc left to the page, which unfocuses, plain esc the terminal's;
    // off a mac ctrl+c copies a selection (else ^C) and ctrl+v pastes, as Windows Terminal
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === 'Escape' && e.shiftKey) return false;
      if (IS_MAC || e.type !== 'keydown' || !e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && term.hasSelection()) {
        copyText(term.getSelection()).catch(() => {});
        term.clearSelection();
        e.preventDefault();
        return false;
      }
      // the browser's own paste event, into xterm's textarea, instead of ^V
      if (k === 'v') return false;
      return true;
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(view);
    // pixel exact block and box glyphs, DOM renderer if no WebGL2
    try {
      const gl = new WebglAddon.WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      term.loadAddon(gl);
    } catch {}
    // 0x0 for hidden views, skipped by fit
    observer = new ResizeObserver(() => fit.fit());
    observer.observe(view);

    const sendSize = () => ws?.readyState === WebSocket.OPEN
      && ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    const enc = new TextEncoder();
    term.onResize(sendSize);
    term.onData((d) => ws?.readyState === WebSocket.OPEN && ws.send(enc.encode(d)));

    // bytes so far, so a rejoin replays only what's missing, 0 after a reload
    let got = 0;
    // true while the prompts are still being answered
    let seen = '';
    // the password's echoed line break dropped, the shell's first output at the top
    let trim = false;
    const loginStep = (data) => {
      seen += new TextDecoder().decode(data);
      if (/login: $/.test(seen)) { seen = ''; ws.send(enc.encode(`${login.user}\r`)); }
      else if (/password: $/.test(seen)) {
        ws.send(enc.encode(`${login.pass}\r`));
        // a command asked for, typed ahead of the shell's prompt
        if (login.run) ws.send(enc.encode(`${login.run}\r`));
        login = null;
        trim = true;
      }
      return true;
    };
    const trimStep = (data) => {
      const bytes = new Uint8Array(data);
      let i = 0;
      while (i < bytes.length && (bytes[i] === 13 || bytes[i] === 10)) i += 1;
      if (i < bytes.length) trim = false;
      return bytes.subarray(i);
    };
    let delay = RETRY_MIN_MS;
    const connect = () => {
      const q = new URLSearchParams({ sid, since: got });
      if (resume) q.set('resume', '1');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/term/${encodeURIComponent(host)}?${q}`);
      ws.binaryType = 'arraybuffer';
      // the share said again on every join, so a reload's choice holds
      ws.onopen = () => { delay = RETRY_MIN_MS; sendSize(); ws.send(JSON.stringify({ type: 'share', on: shared, by: name })); };
      ws.onmessage = (e) => {
        resume = true;
        got += e.data.byteLength;
        if (login && loginStep(e.data)) return;
        term.write(trim ? trimStep(e.data) : new Uint8Array(e.data));
      };
      ws.onclose = (e) => {
        if (e.code === TERM_TAKEN) {
          term.write('\r\n\x1b[2m[opened in another tab]\x1b[0m\r\n');
          return;
        }
        if (e.code === TERM_ENDED || !resume) {
          term.write('\r\n\x1b[2m[connection closed]\x1b[0m\r\n');
          return;
        }
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RETRY_MAX_MS);
      };
    };
    connect();
    fit.fit();
    term.focus();
  }).catch((err) => { view.textContent = err.message; });

  return {
    show: () => ready.then(() => { fit?.fit(); term?.focus(); }),
    focus: () => term?.focus(),
    close: () => ready.then(() => {
      observer?.disconnect();
      clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
        ws.close();
      }
      liveTerms.delete(term);
      term?.dispose();
    }),
  };
}

function newSid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// files opened in the editor, newest first, for the + menu
const RECENT_FILES_KEY = 'phosphorus-recent-files';
const RECENT_FILES_MAX = 3;
function rememberFile(file) {
  const list = loadJsonSafe(RECENT_FILES_KEY).filter((f) => f && codeKey(f) !== codeKey(file));
  try { localStorage.setItem(RECENT_FILES_KEY, JSON.stringify([file, ...list].slice(0, RECENT_FILES_MAX))); } catch {}
}
// --- files -----------------------------------------------------------------

// hosts at the top, their published directories beneath, every path relative
// to one of those, anything resolving outside it refused by the frontend

const ICONS = {
  folder: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  file: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3',
  download: 'M8 2v8M4.5 7L8 10.5 11.5 7M2.5 13.5h11',
  rename: 'M11.5 1.8l2.7 2.7-8.2 8.2-3.5.8.8-3.5zM9.8 3.5l2.7 2.7',
  trash: 'M2.5 4h11M6 4V2.2h4V4M4 4l.7 10h6.6L12 4M6.4 6.5v5M9.6 6.5v5',
  mkdir: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13zM8 7.5v4M6 9.5h4',
  upload: 'M8 10.5v-8M4.5 5.5L8 2l3.5 3.5M2.5 13.5h11',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.8-4.1M13.5 1.5v3.5h-3.5',
  split: 'M1.5 2.5h13v11h-13zM8 2.5v11',
  view: 'M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  host: 'M1.5 2.5h13v4.5h-13zM1.5 9h13v4.5h-13zM4 4.75h1.5M4 11.25h1.5',
};

function icon(name) {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: `ic ic-${name}`, 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d: ICONS[name] }));
  return svg;
}

// loc is any {host, share}: a pane, a share row, or the pair a transfer holds;
// host * the merged home, a path's call sent to a host holding it
const filesApi = (loc, op, params) => {
  const q = new URLSearchParams({ share: loc.share || '0', ...(params || {}) });
  const host = loc.host === '*' ? homePick(params?.path || '') : loc.host;
  return `/api/files/${encodeURIComponent(host)}/${op}?${q}`;
};
const filesJoin = (a, b) => (a ? `${a}/${b}` : b);
// host then the share path: razer/phosphorus/files/gondor.jpg
const filesPath = (host, root, rel) =>
  [host === '*' ? '' : host, ...`${root}/${rel || ''}`.split('/')].filter(Boolean).join('/');
const filesParent = (p) => p.split('/').slice(0, -1).join('/');

// JSON from every call, failures included, one place to surface them
async function filesCall(loc, op, init, params) {
  if (loc.host === '*') return homeCall(op, init, params);
  const res = await fetch(filesApi(loc, op, params), init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `status ${res.status}`);
  return body;
}

const jsonPost = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

// r browse and download, w upload/new folder/rename, d delete
const may = (loc, perm) => (loc.perms || '').includes(perm);

function humanSize(n) {
  if (n === null || n === undefined) return '';
  const u = ['b', 'k', 'm', 'g', 't'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${i ? v.toFixed(1) : v}${u[i]}`;
}

// ---- the merged home: usr on every host as one, each entry carrying the
// hosts that hold it, an offline host's last listing shown greyed

const HOME = { host: '*', share: 'home', root: 'home', perms: 'rwd' };
const isHome = (loc) => !!loc && loc.share === 'home';
const homeAt = (host) => ({ host, share: 'home', root: 'home', perms: 'rwd' });
// path -> hosts holding it, from the last listings
const homeWhere = new Map();
const homeCacheKey = () => `phosphorus-home-cache:${acct?.user || ''}`;
let homeCache = null;

const homeOnline = () => [...new Set([selfHost, ...phosphorusHosts()].filter(Boolean))];
const homeOffline = () => meshTailnet.filter((d) => d.phosphorusSeen && !d.phosphorus).map((d) => d.name).filter((h) => h !== selfHost);

// the holder to read a path from: this host first, then any online one
function homePick(rel) {
  const on = homeOnline();
  const has = [...(homeWhere.get(rel) || [])].filter((h) => on.includes(h));
  return has.includes(selfHost) ? selfHost : has[0] || selfHost;
}
const homeHolders = (rel) => {
  const on = homeOnline();
  const has = [...(homeWhere.get(rel) || [])].filter((h) => on.includes(h));
  return has.length ? has : [selfHost];
};

function homeCached() {
  if (!homeCache) { try { homeCache = JSON.parse(localStorage.getItem(homeCacheKey())) || {}; } catch { homeCache = {}; } }
  return homeCache;
}
function homeRemember(host, dir, entries) {
  const c = homeCached();
  c[`${host}\n${dir}`] = entries.slice(0, 300).map(({ name, dir: d, size, mtime }) => ({ name, dir: d, size, mtime }));
  const keys = Object.keys(c);
  for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete c[k];
  try { localStorage.setItem(homeCacheKey(), JSON.stringify(c)); } catch {}
}

async function homeList(dir) {
  const online = homeOnline();
  const got = await Promise.all(online.map(async (h) => {
    try {
      const body = await filesCall(homeAt(h), 'list', undefined, { path: dir });
      homeRemember(h, dir, body.entries);
      return { h, entries: body.entries };
    } catch { return { h, entries: homeCached()[`${h}\n${dir}`] || [], stale: true }; }
  }));
  for (const h of homeOffline()) got.push({ h, entries: homeCached()[`${h}\n${dir}`] || [], stale: true });
  const by = new Map();
  for (const { h, entries, stale } of got) {
    for (const e of entries) {
      const m = by.get(e.name) || { ...e, hosts: [], live: [] };
      m.hosts.push(h);
      if (!stale) m.live.push(h);
      m.mtime = Math.max(m.mtime || 0, e.mtime || 0);
      m.all ||= !!e.all;
      m.dir ||= e.dir;
      by.set(e.name, m);
    }
  }
  const entries = [...by.values()].map((m) => ({ ...m, stale: !m.live.length }));
  for (const e of entries) homeWhere.set(filesJoin(dir, e.name), new Set(e.live.length ? e.live : e.hosts));
  if (!got.some((g) => !g.stale)) throw new Error('no host answered');
  return { path: dir, entries };
}

// one call over the merged home: listing merged, new folders made everywhere,
// deletes and renames on every holder, the rest on one
async function homeCall(op, init, params) {
  if (op === 'list') return homeList(params?.path || '');
  const body = init?.body ? JSON.parse(init.body) : {};
  const rel = op === 'rename' ? body.from : body.path ?? params?.path ?? '';
  const hosts = op === 'mkdir' ? homeOnline() : ['delete', 'rename', 'mirror'].includes(op) ? homeHolders(rel) : [homePick(rel)];
  const out = await Promise.allSettled(hosts.map((h) => filesCall(homeAt(h), op, init, params)));
  const ok = out.find((r) => r.status === 'fulfilled');
  if (!ok) throw out[0].reason;
  if (op === 'delete') homeWhere.delete(rel);
  return ok.value;
}

// where new bytes in the home go: one host, or every host (small files only)
async function homeTarget(fm, bytes, what) {
  const on = homeOnline();
  const opts = [...on.map((h) => [h === selfHost ? `${h} (this host)` : h, h]), ['all hosts', '*', bytes > HOME_ALL_MAX ? 'over 32MB' : '']];
  if (on.length < 2) return { host: selfHost, all: false };
  const pick = await dkChoose(fm, { title: 'keep it on', message: what, options: opts });
  if (!pick) return null;
  return pick === '*' ? { host: selfHost, all: true } : { host: pick, all: false };
}
const HOME_ALL_MAX = 32 * 1024 * 1024;

// ---- transfer -------------------------------------------------------------

// sent in chunks, each its own XHR, so no request nears a proxy's body cap or
// a phone holds one huge one open, a failed chunk retried alone
const CHUNK = 4 * 1024 * 1024;

async function putFile(loc, path, body, onSent) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join('');
  const total = body.size;
  let offset = 0;
  let last = {};
  do {
    const end = Math.min(offset + CHUNK, total);
    const piece = body.slice(offset, end);
    for (let tries = 1; ; tries++) {
      try {
        last = await putChunk(loc, { path, id, offset, total }, piece, (sent) => onSent && onSent(offset + sent));
        break;
      } catch (err) {
        if (tries >= 4 || err.fatal) throw err;
        await new Promise((r) => setTimeout(r, 1000 * tries));
      }
    }
    offset = end;
    if (onSent) onSent(offset);
  } while (offset < total);
  return last;
}

function putChunk(loc, params, piece, onSent) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', filesApi(loc, 'upload', params));
    xhr.timeout = 120000;
    xhr.upload.addEventListener('progress', (e) => onSent(e.loaded));
    xhr.addEventListener('load', () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200) { resolve(body); return; }
      const err = new Error(body.error || `status ${xhr.status}`);
      // a refusal the server means, retrying changes nothing
      err.fatal = xhr.status >= 400 && xhr.status < 500;
      reject(err);
    });
    xhr.addEventListener('error', () => reject(new Error('upload failed')));
    xhr.addEventListener('timeout', () => reject(new Error('upload timed out')));
    xhr.send(piece);
  });
}

// streamed for a bar that moves on the read too, the body still in memory
// before the write, the cost of no host-to-host copy
async function getFile(loc, path, onGot) {
  const res = await fetch(filesApi(loc, 'download', { path }));
  if (!res.ok) throw new Error(`couldn't read ${path}`);
  const size = Number(res.headers.get('Content-Length')) || 0;
  if (!res.body) return { blob: await res.blob(), size };
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    onGot && onGot(got, size);
  }
  return { blob: new Blob(chunks), size: got };
}

// no server-side copy between hosts: each file pulled from one share by the
// browser and pushed to the other, the read the first half of the bar
async function copyFile(from, fromPath, to, toPath, tick) {
  const { blob } = await getFile(from, fromPath, (got, size) => tick(size ? (got / size) * 0.5 : 0));
  await putFile(to, toPath, blob, (sent) => tick(0.5 + (blob.size ? (sent / blob.size) * 0.5 : 0.5)));
}

async function copyTree(from, fromPath, to, toPath, tick) {
  const listing = await filesCall(from, 'list', undefined, { path: fromPath });
  // already there: fine, anything else surfacing on the first child write
  await filesCall(to, 'mkdir', jsonPost({ path: toPath })).catch(() => {});
  for (const e of listing.entries) {
    const src = filesJoin(fromPath, e.name);
    const dst = filesJoin(toPath, e.name);
    if (e.dir) await copyTree(from, src, to, dst, tick);
    else await copyFile(from, src, to, dst, (f) => tick(f, e.name));
  }
}

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
function statusWatch() {
  if (!stOpen()) return;
  if (!stWs) statusConnect();
  statusDraw();
}

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

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
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
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
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

const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
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
  const rtt = steadyRtt(name) ?? dev.rttMs;
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
  const vm = h.s.platform && h.s.platform !== 'linux' ? ' · docker vm' : '';
  p.ctrHead.innerHTML = `containers <span class="st-dim">${list ? list.length : ''}${vm}</span>`;
  if (!list) { p.ctr.innerHTML = '<div class="st-dim">no docker access</div>'; return; }
  p.ctr.innerHTML = '<div class="st-ctr-row st-dim"><span>name</span><span>cpu</span><span>mem</span><span>pids</span></div>'
    + list.map((c) => `<div class="st-ctr-row"><span class="st-ctr-name">${esc(c.name)}</span>`
      + `<span class="${heat(c.cpu / 100)}">${c.cpu.toFixed(1)}%</span><span>${humanSize(c.mem)}</span>`
      + `<span class="st-dim">${c.pids}</span></div>`).join('');
}

function drawProc(p, h) {
  const pr = h.s.procs;
  const vm = h.s.platform && h.s.platform !== 'linux' ? ' · docker vm' : '';
  p.procHead.innerHTML = `processes <span class="st-dim">${pr ? pr.count : ''}${vm}</span>`;
  if (!pr) { p.proc.innerHTML = '<div class="st-dim">no process list</div>'; return; }
  p.proc.innerHTML = '<div class="st-proc-row st-dim"><span>name</span><span>pid</span><span>cpu</span><span>mem</span></div>'
    + pr.top.map((x) => `<div class="st-proc-row"${x.cmd ? ` title="${esc(x.cmd)}"` : ''}>`
      + `<span class="st-ctr-name">${esc(x.name)}</span><span class="st-dim">${x.pid}</span>`
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

// --- chat ------------------------------------------------------------
// one log, redrawn per conversation from what the socket handed over: the
// mesh and its channels, direct messages, and private phosphorus sessions kept in
// this browser. Bubbles: yours on the right, everyone else's on the left,
// phosphorus's replies the full width

const chatPanel = document.getElementById('chat-panel');
const chatLog = document.getElementById('chat-log');
// phosphorus's [open a terminal on host](#term:host): a terminal window, never a navigation
chatPanel.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#term:"]');
  if (!a) return;
  e.preventDefault();
  const host = decodeURIComponent(a.getAttribute('href').slice(6));
  dkOpenTerminal(host);
});
const chatTitle = document.getElementById('chat-title');
const chatStatus = document.getElementById('chat-status');
const chatJoin = document.getElementById('chat-join');
const chatName = document.getElementById('chat-name');
const chatJoinGo = document.getElementById('chat-join-go');
const chatCompose = document.getElementById('chat-compose');
const chatForm = document.getElementById('chat-form');
const chatText = document.getElementById('chat-text');
const chatSend = document.getElementById('chat-send');
const chatChip = document.getElementById('chat-chip');
const chatCmds = document.getElementById('chat-cmds');
const chatBar = document.getElementById('chat-bar');
const chatAtts = document.getElementById('chat-atts');
const chatAttach = document.getElementById('chat-attach');
const chatFile = document.getElementById('chat-file');
const chatTyping = document.getElementById('chat-typing');
const chatFind = document.getElementById('chat-find');
const chatFindInput = document.getElementById('chat-find-input');
const chatFindCount = document.getElementById('chat-find-count');
const chatDrop = document.getElementById('chat-drop');
const cwList = document.getElementById('cw-list');
const cwMain = document.getElementById('cw-main');
// the chat's panel beside its conversations, in the chat app
cwMain.appendChild(chatPanel);
const chatFilesBtn = document.getElementById('chat-files-btn');
const chatPop = document.getElementById('chat-pop');

// everyone on the mesh, peers merged in by the frontend
let people = [];
// the model as one of them while loaded and answering, from /api/state,
// not the chat socket, so kept here for a redraw either way
let chatOnline = false;
let modelWho = [];

const NAME_COLORS = [
  '#4f9eff', '#3fb950', '#f0883e', '#d2a8ff', '#ff7b72', '#79c0ff', '#ffa657',
  '#e3b341', '#ff9bce', '#39c5cf', '#db61a2', '#7ee787', '#d4a72c', '#ffa198',
];
const COLOR_NAMES = [
  'blue', 'green', 'orange', 'purple', 'red', 'skyblue', 'gold',
  'yellow', 'pink', 'teal', 'magenta', 'lime', 'amber', 'coral',
];

function colorFor(n) {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length];
}

let name = localStorage.getItem('phosphorus-chat-name') || '';
let color = localStorage.getItem('phosphorus-chat-color') || '';
let ws = null;
// fast first, then backing off x1.5 (capped), most reconnects a blip
let reconnectDelay = 300;
const wsOpen = () => ws && ws.readyState === WebSocket.OPEN;
const send = (body) => wsOpen() && ws.send(JSON.stringify(body));
const joined = () => !chatCompose.hidden;

const formatTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
function formatDay(ts) {
  const d = new Date(ts);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(days > 300 ? { year: 'numeric' } : {}) });
}

// the chimp online while its model answers: a mesh host's loaded,
// or one off the mesh
function modelPresence(model) {
  const next = AGENTS.map((r) => {
    const x = model?.roles?.[r];
    if (!x || !x.ready) return null;
    const m = x.host && (model.models || []).find((y) => y.host === x.host);
    return { name: r, host: x.host, file: m ? m.file : x.model };
  }).filter(Boolean);
  if (JSON.stringify(next) === JSON.stringify(modelWho)) return;
  modelWho = next;
  paintStatus();
}

// --- unread and notifications -------------------------------------------------

// unread tally in the tab title, counted only while the tab is away
const BASE_TITLE = document.title;
let unread = 0;

// away: another tab, minimized, or a window behind this one
const away = () => document.hidden || !document.hasFocus();

function titleBadge() {
  document.title = unread ? `(${unread > 99 ? '99+' : unread}) ${BASE_TITLE}` : BASE_TITLE;
}

function bumpUnread() {
  if (!away()) return;
  unread += 1;
  titleBadge();
}

// back on the tab: badge cleared, however many piled up
function clearUnread() {
  if (away() || !unread) return;
  unread = 0;
  titleBadge();
}

document.addEventListener('visibilitychange', clearUnread);
window.addEventListener('focus', clearUnread);

// desktop notifications, opt-in per browser, secure context only, the bell
// hidden on plain http
const chatBell = document.getElementById('chat-bell');
const canNotify = 'Notification' in window;
let notifyOn = canNotify && Notification.permission === 'granted'
  && localStorage.getItem('phosphorus-chat-notify') === '1';

function paintBell() {
  chatBell.setAttribute('aria-pressed', String(notifyOn));
  chatBell.title = notifyOn ? 'desktop notifications on, click to mute'
    : 'notify me when someone chats';
}

if (canNotify) { chatBell.hidden = false; paintBell(); }

// permission asked on the click, the gesture browsers want
chatBell.addEventListener('click', async () => {
  if (notifyOn) {
    notifyOn = false;
    localStorage.setItem('phosphorus-chat-notify', '0');
    paintBell();
    return;
  }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    chatNote('notifications are blocked for this site, allow them in the browser to turn them on');
    return;
  }
  notifyOn = true;
  localStorage.setItem('phosphorus-chat-notify', '1');
  paintBell();
});

// silent, one live popup replaced by the next, a burst never stacking
// an invite to a file past the bell: asked of this person by name
function notifyChat(m, invite = false) {
  if ((!notifyOn && !invite) || !away() || !canNotify || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(m.name, { body: m.text, tag: 'phosphorus-chat', silent: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

// the log following its newest line, eased down rather than snapped, a jump
// past a screen (history, a conversation coming up) still snapped
let glide = 0;
const nearBottom = () => !!glide || chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 20;
function toBottom() {
  if (glide) return;
  const step = () => {
    const gap = chatLog.scrollHeight - chatLog.clientHeight - chatLog.scrollTop;
    if (gap <= 1 || gap > chatLog.clientHeight) { chatLog.scrollTop = chatLog.scrollHeight; glide = 0; return; }
    chatLog.scrollTop += Math.ceil(gap * 0.2);
    glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}
// the reader scrolling away ending the glide
for (const ev of ['wheel', 'touchmove']) chatLog.addEventListener(ev, () => { cancelAnimationFrame(glide); glide = 0; }, { passive: true });

// pinned while scrolled to the bottom, kept there by a resize
let chatPinned = true;
chatLog.addEventListener('scroll', () => { chatPinned = nearBottom(); });
// math refitted when the width moves or katex's fonts land
const refitMath = () => { for (const t of chatLog.querySelectorAll('.md')) if (t.querySelector('.katex')) fitMath(t); };
document.fonts.addEventListener('loadingdone', refitMath);
let chatWidth = 0;
new ResizeObserver(() => {
  if (chatLog.clientWidth !== chatWidth) { chatWidth = chatLog.clientWidth; refitMath(); }
  if (chatPinned) chatLog.scrollTop = chatLog.scrollHeight;
}).observe(chatLog);

// "in 5 seconds" down to 1 on the same line, then the bare text, from arrival
// when live, from the timestamp for history
function alertCountdown(li, m, until) {
  const left = Math.ceil((until - Date.now()) / 1000);
  li.textContent = left > 0 ? `system: ${m.text} in ${left} second${left === 1 ? '' : 's'}` : `system: ${m.text}`;
  if (left > 0) setTimeout(() => { if (li.isConnected) alertCountdown(li, m, until); }, (until - Date.now()) % 1000 || 1000);
}

// what the model posts: its answer, its spinner and why it can't
const MODEL_KINDS = ['model', 'pending', 'notice'];

// a chat reply opened with who it's for, "Patrick, yes", a plain first word lowered,
// a block (fence, list, heading, table, display math) on its own line
const PLAIN_FIRST = /^(?:Yes|No|The|It|Its|It's|That|This|There|These|Those|You|Your|A|An|Sure|Done|Here|Nothing|None|All|Both|Not|To|In|On|For|With|From|At|By|Use|Run|Try|Open|Ok|Okay|Each|One|Some|Only|Just)\b/;
const BLOCK_FIRST = /^\s*(?:```|[-*+] |\d+\. |#|>|\||\$\$|\\\[)/;
function addressed(to, text) {
  if (!to || !text || text.toLowerCase().startsWith(`${to.toLowerCase()},`)) return text;
  if (BLOCK_FIRST.test(text)) return `${to},\n\n${text}`;
  return `${to}, ${PLAIN_FIRST.test(text) ? text[0].toLowerCase() + text.slice(1) : text}`;
}

// @name lit, outside code, true when it's this browser's own
function markMentions(el) {
  if (!name) return false;
  let me = false;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest('code, pre, a, .katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const hits = [];
  while (walk.nextNode()) if (walk.currentNode.nodeValue.includes('@')) hits.push(walk.currentNode);
  for (const t of hits) {
    const parts = t.nodeValue.split(/(@[\w.-]+)/);
    if (parts.length < 2) continue;
    t.replaceWith(...parts.map((p, i) => {
      if (i % 2 === 0) return p;
      const s = Object.assign(document.createElement('span'), { className: 'mention', textContent: p });
      if (p.slice(1).toLowerCase() === name.toLowerCase()) { s.classList.add('me'); me = true; }
      return s;
    }));
  }
  return me;
}

// --- the log as it came in -------------------------------------------------------
// every line by host:seq, sorted into conversations: mesh, ch:<name>, dm:<name>,
// reactions, edits and deletes folded into the line they point at

const MARKS = ['react', 'edit', 'delete'];
const REACTIONS = ['+1', '✓', '✗', '?', '!', '♡'];
const lines = new Map();
const convLines = new Map();
// marks whose line hasn't come yet
const orphanMarks = new Map();
// 500 drawn at a time, as the server keeps, no more for a tab open for days
const CHAT_KEEP = 500;
// consecutive lines from one name within this run on under one header
const GROUP_MS = 5 * 60 * 1000;
let sysSeq = 0;

const keyOf = (m) => `${m.host}:${m.seq}`;
const convOf = (m) => (m.dm ? `dm:${m.name === name ? m.dm : m.name}` : m.ch ? `ch:${m.ch}` : 'mesh');

function fold(k) {
  const m = lines.get(k.ref);
  if (!m) {
    orphanMarks.set(k.ref, [...(orphanMarks.get(k.ref) || []), k]);
    return null;
  }
  if (k.kind === 'react') {
    const id = `${k.name}\n${k.emoji}`;
    const was = m.reacts.get(id);
    if (!was || was.at <= k.timestamp) m.reacts.set(id, { name: k.name, emoji: k.emoji, on: k.on !== false, at: k.timestamp });
    return m;
  }
  if (k.name !== m.name) return null;
  if (k.kind === 'edit' && (!m.editAt || m.editAt <= k.timestamp)) { m.edited = k.text; m.editedHtml = k.html; m.editAt = k.timestamp; }
  if (k.kind === 'delete') m.gone = true;
  return m;
}

// a line into its conversation, kept in time order, null when already held
function holdLine(m) {
  const key = keyOf(m);
  if (lines.has(key)) return null;
  m.reacts = new Map();
  lines.set(key, m);
  const c = convOf(m);
  const list = convLines.get(c) || [];
  let at = list.length;
  while (at > 0 && list[at - 1].timestamp > m.timestamp) at -= 1;
  list.splice(at, 0, m);
  convLines.set(c, list);
  for (const k of orphanMarks.get(key) || []) fold(k);
  orphanMarks.delete(key);
  return c;
}

function dropLine(key) {
  const m = lines.get(key);
  if (!m) return;
  lines.delete(key);
  const list = convLines.get(convOf(m));
  if (list) list.splice(list.indexOf(m), 1);
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(key)}"]`);
  if (!li) return;
  // a model's spinner kept a beat for the answer that takes its place
  if (m.kind !== 'pending' || !li.dataset.to) { li.remove(); return; }
  li.classList.add('retired');
  setTimeout(() => li.remove(), 1500);
}

// a passing note in the log: joins, leaves, renames, a mistyped command
function sysLine(c, text, cls = '') {
  const m = { host: 'sys', seq: ++sysSeq, timestamp: Date.now(), kind: 'sys', name: '', text, cls };
  holdLine(Object.assign(m, { ch: c.startsWith('ch:') ? c.slice(3) : undefined }));
  if (c === conv) putLine(m, true);
}

// a note for this browser only, in whatever is on screen
function chatNote(text) {
  const li = Object.assign(document.createElement('li'), { className: 'sys', textContent: text });
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// --- one line ---------------------------------------------------------------------

const mediaUrl = (f, dl) => `/api/chat/media/${encodeURIComponent(f.host)}/${f.id}${dl ? '?dl' : ''}`;
const el = (tag, cls, text) => Object.assign(document.createElement(tag), cls ? { className: cls } : {}, text != null ? { textContent: text } : {});

function filesEl(files) {
  const box = el('div', 'msg-files');
  for (const f of files) {
    const kind = (f.type || '').split('/')[0];
    if (kind === 'image') {
      const a = Object.assign(el('a', 'msg-img'), { href: mediaUrl(f), target: '_blank', rel: 'noopener', title: f.name });
      a.append(Object.assign(document.createElement('img'), { src: mediaUrl(f), alt: f.name, loading: 'lazy' }));
      box.append(a);
    } else if (kind === 'video' || kind === 'audio') {
      const v = Object.assign(document.createElement(kind), { src: mediaUrl(f), controls: true, preload: 'metadata', title: f.name });
      v.className = `msg-${kind}`;
      box.append(v);
    } else {
      const a = Object.assign(el('a', 'msg-file'), { href: mediaUrl(f, true), download: f.name, title: `download ${f.name}` });
      a.append(el('span', 'msg-file-icon', '▤'), el('span', 'msg-file-name', f.name), el('span', 'msg-file-size', humanSize(f.size || 0)));
      box.append(a);
    }
  }
  return box;
}

function reactsEl(m) {
  if (!m.reacts) return null;
  const by = new Map();
  for (const r of m.reacts.values()) if (r.on) by.set(r.emoji, [...(by.get(r.emoji) || []), r.name]);
  if (!by.size) return null;
  const row = el('div', 'msg-reacts');
  for (const e of REACTIONS) {
    const who = by.get(e);
    if (!who) continue;
    const b = Object.assign(el('button', `react${who.includes(name) ? ' on' : ''}`, `${e} ${who.length}`), { type: 'button', title: who.join(', ') });
    b.dataset.act = 'react';
    b.dataset.emoji = e;
    row.append(b);
  }
  return row;
}

function quoteEl(ref) {
  const t = lines.get(ref);
  const q = el('button', 'msg-re');
  q.type = 'button';
  q.dataset.act = 'goto';
  q.dataset.ref = ref;
  if (!t || t.gone) { q.textContent = '↳ a message no longer here'; return q; }
  const text = (t.edited ?? t.text) || (t.files ? `[${t.files.map((f) => f.name).join(', ')}]` : '');
  q.append('↳ ', Object.assign(el('b', '', t.name), { style: `color: ${t.color || colorFor(t.name)}` }), ` ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  return q;
}

// the li for a line, prev the li before it, for its header and day
function lineEl(m, prev) {
  const li = el('li');
  li.dataset.key = keyOf(m);
  li.dataset.at = m.timestamp;
  if (m.kind === 'sys') {
    li.className = `sys ${m.cls || ''}`;
    li.textContent = m.text;
    return li;
  }
  if (m.kind === 'alert') {
    li.className = 'sys alert';
    li.textContent = `system: ${m.text}`;
    if (m.countdown > 0) alertCountdown(li, m, (m.live ? Date.now() : m.timestamp) + m.countdown * 1000);
    return li;
  }
  if (m.kind === 'show') {
    li.className = 'sys show';
    li.append(m.name === name ? `you invited ${m.dm} to work on ` : `${m.name} invited you to work on `, el('code', '', m.file?.label || m.text));
    if (m.file) {
      const b = Object.assign(el('button', 'show-open', 'open'), { type: 'button', title: 'open it in a shared editor' });
      b.dataset.act = 'show';
      li.append(' ', b);
      fileThere(m.file).then((there) => { if (!there) b.replaceWith(el('span', 'st-dim', '(gone)')); });
    }
    return li;
  }
  if (m.kind === 'topic') {
    li.className = 'sys';
    li.textContent = m.text ? `${m.name} set the topic: ${m.text}` : `${m.name} opened #${m.ch}`;
    return li;
  }
  const agent = MODEL_KINDS.includes(m.kind);
  const mine = !agent && m.name === name;
  const real = m.host !== 'agent' && m.kind !== 'pending' && m.kind !== 'notice' && !m.gone && !m.sending;
  li.className = `msg ${agent ? 'agent' : mine ? 'mine' : 'theirs'}`;
  if (m.kind === 'pending') li.classList.add('pending');
  li.dataset.who = m.name;
  li.style.setProperty('--who', m.color || colorFor(m.name));
  const p = prev?.matches?.('.msg') && prev;
  if (p && p.dataset.who === m.name && m.timestamp - Number(p.dataset.at) < GROUP_MS && !m.re) li.classList.add('cont');

  const head = el('div', 'msg-head');
  const user = el('span', 'user', mine ? 'you' : m.name);
  if (agent) user.classList.add('who-model');
  head.append(user, el('span', 'ts', formatTime(m.timestamp)));
  if (m.edited != null && !m.gone) head.append(el('span', 'edited', 'edited'));
  if (real) li.dataset.acts = mine ? 'mine' : 'theirs';
  li.append(head);

  const bubble = el('div', 'bubble');
  if (m.re && !m.gone) bubble.append(quoteEl(m.re));
  const text = el('div', 'text');
  // who a model reply is for, since several can be written at once
  const to = ['model', 'pending'].includes(m.kind) && typeof m.to === 'string' ? m.to : '';
  if (to) li.dataset.to = to;
  const body = m.edited ?? m.text;
  const html = m.edited != null ? m.editedHtml : m.html;
  // an ask's /chimp or /orang coloured as the command it is, the rest as markdown
  const cmd = !m.kind && typeof body === 'string' && body.match(/^\/chimp(?=\s|$)/i);
  if (m.gone) {
    text.classList.add('gone');
    text.textContent = 'message deleted';
  } else if (m.kind === 'pending') {
    const row = el('div', 'spin-row');
    row.append(el('span', 'spin who-model'), el('span', 'spin-say', 'writing'));
    text.append(row);
  } else if (cmd) {
    const rest = el('span');
    renderMd(rest, body.slice(cmd[0].length).trimStart(), true, html);
    text.append(el('span', 'cmd', cmd[0]), ' ', rest);
  } else if (body) {
    renderMd(text, addressed(to, body), true, html);
  }
  if (!m.gone && markMentions(text)) li.classList.add('at-me');
  if (body || m.gone || m.kind === 'pending') bubble.append(text);
  if (m.files && !m.gone) bubble.append(filesEl(m.files));
  if (!body && !m.gone && m.files?.length && m.files.every((f) => (f.type || '').startsWith('image/'))) li.classList.add('just-img');
  li.append(bubble);
  const reacts = !m.gone && reactsEl(m);
  if (reacts) li.append(reacts);
  return li;
}

// a day's first line under its date, was: a spinner line it takes the place of
function putLine(m, live, was = null) {
  const atBottom = live && nearBottom();
  const to = MODEL_KINDS.includes(m.kind) && typeof m.to === 'string' && m.to;
  const old = was?.isConnected ? was : to && chatLog.querySelector(`li.retired[data-to="${CSS.escape(to)}"]`);
  let li;
  if (old) {
    li = lineEl(m, old.previousElementSibling?.matches('.day') ? null : old.previousElementSibling);
    old.replaceWith(li);
  } else {
    const last = chatLog.lastElementChild;
    const day = formatDay(m.timestamp);
    if (chatLog.dataset.day !== day) {
      chatLog.dataset.day = day;
      chatLog.append(el('li', 'day', day));
    }
    li = lineEl(m, chatLog.lastElementChild?.matches('.day') ? null : last);
    chatLog.append(li);
  }
  // a model's answer popped in whole once it lands
  if (live && m.kind === 'model') li.classList.add('pop');
  while (chatLog.childElementCount > CHAT_KEEP) chatLog.firstElementChild.remove();
  if (live && atBottom) toBottom();
  if (li.querySelector('.katex')) fitMath(li.querySelector('.text'));
  if (chatFindInput.value) findIn(li);
  return li;
}

// a line drawn again in place, after a reaction, edit or delete
function redrawLine(m) {
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(keyOf(m))}"]`);
  if (!li) return;
  const next = lineEl(m, li.previousElementSibling?.matches('.day') ? null : li.previousElementSibling);
  li.replaceWith(next);
  if (next.querySelector('.katex')) fitMath(next.querySelector('.text'));
}

// --- conversations -------------------------------------------------------------
// mesh and the channels anyone opens, the agents' dms (kept in this browser),
// and people's dms (kept by the mesh, shown to their two ends)

const CHANNELS_KEY = 'phosphorus-chat-channels';
// chat's agents, the orangutan kept for projects; both picked in the model card
const AGENTS = ['chimp'];
const MODEL_ROLES = ['chimp', 'orangutan'];
const AGENT_SUB = { chimp: 'quick' };
const AGENT_KEY = 'phosphorus-agents';
const AGENT_KEEP = 200;
// mesh, ch:<name>, dm:<name> or chimp
let conv = 'mesh';
const loadJson = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
// each agent's turns, and seen: its sent messages up to here already shown or forgotten
const agents = (() => {
  const kept = loadJson(AGENT_KEY, {}) || {};
  return Object.fromEntries(AGENTS.map((r) => [r, { turns: [], seen: 0, ...kept[r] }]));
})();
// channels opened here, kept listed before anyone has said a word in them
let myChannels = loadJson(CHANNELS_KEY, []);
// channels left here, by when, hidden until a line comes after
const LEFT_KEY = 'phosphorus-chat-left';
let leftChannels = loadJson(LEFT_KEY, {}) || {};
const saveChannels = () => {
  try {
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(myChannels));
    localStorage.setItem(LEFT_KEY, JSON.stringify(leftChannels));
  } catch {}
};
// answers in flight, id -> {agent, at}
const agentWaiting = new Map();
// unread lines by conversation
const news = new Map();
// the conversation the divider was drawn for, and how many lines it marks
let freshFrom = 0;

const dmWith = (c) => (c.startsWith('dm:') ? c.slice(3) : '');
const chOf = (c) => (c.startsWith('ch:') ? c.slice(3) : '');
const isAgent = (c) => AGENTS.includes(c);
const convName = (c) => (c === 'mesh' ? '#mesh' : chOf(c) ? `#${chOf(c)}` : dmWith(c) ? `@${dmWith(c)}` : c);
const convHint = () => (isAgent(conv) ? `ask the ${conv}` : `message ${convName(conv)}`);
const agentBusy = (r) => [...agentWaiting.values()].some((w) => w.agent === r);

function saveAgents() {
  try { localStorage.setItem(AGENT_KEY, JSON.stringify(agents)); } catch {}
}

function noteNews(c) {
  if (c === conv && !away() && chatPanel.offsetParent) return;
  news.set(c, (news.get(c) || 0) + 1);
  paintConvs();
}

// each channel's mesh-wide meta: when made, its topic, its last close
let chMetas = {};
const chOpen = (m) => !!m.created && m.created > (m.closedAt || 0);

// every channel: mesh, those open mesh-wide or with lines, those opened here
function channels() {
  const seen = [...convLines.keys()].filter((c) => c.startsWith('ch:') && convLines.get(c).length).map(chOf);
  const open = Object.keys(chMetas).filter((ch) => chOpen(chMetas[ch]));
  const shown = [...seen, ...open].filter((ch) => !(leftChannels[ch] >= Math.max(lastAt(`ch:${ch}`), chMetas[ch]?.created || 0)));
  return [...new Set([...shown, ...myChannels])].sort();
}

const lastAt = (c) => convLines.get(c)?.at(-1)?.timestamp || 0;
function topicOf(c) {
  const m = chMetas[chOf(c)];
  if (m && chOpen(m)) return m.topic || '';
  return convLines.get(c)?.findLast((x) => x.kind === 'topic' && x.text)?.text || '';
}

// everyone to dm, by name so a new line never moves a chat
function dmNames() {
  const talked = [...convLines.keys()].map(dmWith).filter(Boolean);
  return [...new Set([...talked, ...people.map((p) => p.name)])].filter((n) => n !== name && !isAgent(n))
    .sort((a, b) => a.localeCompare(b));
}

// the conversations in the list's order
const convOrder = () => ['mesh', ...channels().map((ch) => `ch:${ch}`), ...AGENTS, ...dmNames().map((n) => `dm:${n}`)];

// ctrl+↑↓: the one above or below in the list, wrapping
function stepConv(step) {
  const order = convOrder();
  const at = order.indexOf(conv);
  openConv(order[(Math.max(0, at) + step + order.length) % order.length]);
}

// the list, in the tab beside the chat or the corner's menu
function convItems() {
  const online = new Map(people.map((p) => [p.name, p]));
  const names = dmNames();
  const head = (text, add) => {
    const h = el('div', 'cw-head', text);
    if (add) {
      const b = Object.assign(el('button', 'cw-add', '+'), { type: 'button', title: add[0] });
      b.addEventListener('click', add[1]);
      h.append(b);
    }
    return h;
  };
  const item = (c, label, { sub = '', dot, hue, model } = {}) => {
    const row = el('div', 'cw-row');
    const b = Object.assign(el('button', `cw-item${c === conv ? ' on' : ''}`), { type: 'button' });
    b.dataset.conv = c;
    if (dot !== undefined) b.append(Object.assign(el('span', `cw-dot${dot ? ' up' : ''}`), { title: dot ? 'online' : 'offline' }));
    const l = el('span', `cw-name${model ? ' who-model' : ''}`, label);
    if (hue) l.style.color = hue;
    b.append(l);
    if (typers(c).length) b.append(el('span', 'cw-typing', '···'));
    else if (sub) b.append(el('span', 'cw-sub', sub));
    const k = news.get(c);
    if (k && c !== conv) b.append(el('span', 'chat-badge', `${k > 99 ? '99+' : k}`));
    const more = Object.assign(el('button', 'cw-more', '…'), { type: 'button', title: `${convName(c)}: more (.)`, tabIndex: -1 });
    more.dataset.conv = c;
    row.append(b, more);
    return row;
  };
  const hueOf = (n) => online.get(n)?.color || convLines.get(`dm:${n}`)?.findLast((m) => m.name === n)?.color || colorFor(n);
  return [
    head('channels', ['open a channel', () => startCommand(CHANNEL_CHIP[0])]),
    item('mesh', '# mesh', { sub: `${people.length} online` }),
    ...channels().map((ch) => item(`ch:${ch}`, `# ${ch}`)),
    head('direct'),
    ...AGENTS.map((r) => item(r, r, { sub: AGENT_SUB[r], model: true })),
    ...names.map((n) => item(`dm:${n}`, n, { dot: online.has(n), hue: hueOf(n) })),
  ];
}

function paintConvs() {
  const total = [...news].reduce((n, [c, k]) => n + (c === conv ? 0 : k), 0);
  deskBadge(total);
  chatTitle.querySelector('.chat-title-dot').hidden = !total;
  cwList.replaceChildren(...convItems());
}

for (const list of [cwList]) {
  list.addEventListener('click', (e) => {
    const more = e.target.closest('.cw-more');
    if (more) { e.stopPropagation(); convMenu(more.dataset.conv, more); return; }
    const b = e.target.closest('.cw-item');
    if (!b) return;
    setConv(b.dataset.conv);
    (joined() ? chatText : chatName).focus();
  });
  // right click, or a long press on a phone: the same menu
  list.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.cw-item');
    if (!b) return;
    e.preventDefault();
    convMenu(b.dataset.conv, b);
  });
}

// --- popup menus ------------------------------------------------------------------
// one small menu at a time, by whatever opened it: a conversation's actions or
// the attachments. ↑↓ to move, enter to pick, esc back to where it came from,
// a destructive pick asking once more before it goes

let popFrom = null;
function closePop(refocus) {
  if (chatPop.hidden) return;
  chatPop.hidden = true;
  if (refocus && popFrom?.isConnected) popFrom.focus();
  popFrom = null;
}

// title: a heading, or a node over the items; at: a right click's point to open at
function popMenu(anchor, title, items, focusAt = 0, at = null) {
  if (!chatPop.hidden && popFrom === anchor) { closePop(true); return; }
  closePop(false);
  popFrom = anchor;
  const els = items.map((it) => {
    const b = it.href
      ? Object.assign(el('a', 'pop-item'), { href: it.href, target: '_blank', rel: 'noopener noreferrer' })
      : Object.assign(el('button', 'pop-item'), { type: 'button' });
    if (it.danger) b.classList.add('danger');
    if (it.thumb) b.append(Object.assign(document.createElement('img'), { src: it.thumb, alt: '', loading: 'lazy', className: 'pop-thumb' }));
    const text = el('span', 'pop-text');
    text.append(el('span', 'pop-label', it.label));
    if (it.sub) text.append(el('span', 'pop-sub', it.sub));
    b.append(text);
    if (it.key) b.append(el('span', 'pop-key', it.key));
    b.addEventListener('click', (e) => {
      if (it.confirm && !b.classList.contains('armed')) {
        e.preventDefault();
        b.classList.add('armed');
        b.querySelector('.pop-label').textContent = it.confirm;
        return;
      }
      if (it.act) { e.preventDefault(); it.act(); }
      closePop(!it.href);
    });
    return b;
  });
  chatPop.replaceChildren(...(title ? [typeof title === 'string' ? el('div', 'pop-title', title) : title] : []), ...els);
  chatPop.hidden = false;
  // under the anchor, kept on screen, over it when there's no room below
  const r = at ? { left: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
  const w = chatPop.offsetWidth;
  const h = chatPop.offsetHeight;
  chatPop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
  chatPop.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  els[Math.min(focusAt, els.length - 1)]?.focus();
}

chatPop.addEventListener('keydown', (e) => {
  const items = [...chatPop.querySelectorAll('.pop-item')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    closePop(true);
  } else return;
  e.preventDefault();
  e.stopPropagation();
});
document.addEventListener('mousedown', (e) => {
  if (!chatPop.hidden && !chatPop.contains(e.target) && !popFrom?.contains(e.target)) closePop(false);
});
window.addEventListener('resize', () => closePop(false));

// what a conversation offers: read, leave, close or clear, the destructive one last
function convActions(c) {
  const read = news.get(c) && { label: 'mark read', act: () => { news.delete(c); paintConvs(); } };
  const ch = chOf(c);
  if (ch) {
    return [read, { label: 'open', act: () => openConv(c) },
      { label: 'leave', sub: 'hide it here until someone posts', act: () => leaveChannel(ch) },
      { label: 'close for everyone', sub: 'its history gone mesh-wide', key: 'd', danger: true, confirm: `sure? close #${ch} for everyone`, act: () => send({ type: 'close', ch }) },
    ].filter(Boolean);
  }
  if (c === 'mesh') {
    return [read, { label: 'clear for everyone', sub: "#mesh's history gone mesh-wide", key: 'd', danger: true, confirm: 'sure? clear #mesh for everyone', act: () => send({ type: 'clear' }) }].filter(Boolean);
  }
  if (isAgent(c)) {
    return [read, { label: 'open', act: () => openConv(c) },
      { label: 'clear conversation', sub: 'and its context, in this browser', key: 'd', danger: true, confirm: `sure? forget the ${c} conversation`, act: () => clearAgent(c) },
    ].filter(Boolean);
  }
  return [read, { label: 'open', act: () => openConv(c) }].filter(Boolean);
}

function convMenu(c, anchor, destructive) {
  const items = convActions(c);
  popMenu(anchor, convName(c), items, destructive ? Math.max(0, items.findIndex((it) => it.danger)) : 0);
}

function leaveChannel(ch) {
  myChannels = myChannels.filter((x) => x !== ch);
  leftChannels[ch] = Date.now();
  saveChannels();
  if (conv === `ch:${ch}`) setConv('mesh');
  else paintConvs();
}

// a channel closed by anyone: its lines gone here too, off every list
function channelClosed(ch, by) {
  const c = `ch:${ch}`;
  for (const m of convLines.get(c) || []) lines.delete(keyOf(m));
  convLines.delete(c);
  news.delete(c);
  myChannels = myChannels.filter((x) => x !== ch);
  saveChannels();
  if (conv === c) setConv('mesh');
  else paintConvs();
  sysLine('mesh', `#${ch} closed${by ? ` by ${by}` : ''}`);
}

// --- attachments ------------------------------------------------------------------

// everything shared in this conversation, newest first, with who and when
const convFiles = () => (isAgent(conv) ? [] : (convLines.get(conv) || []).filter((m) => m.files && !m.gone)
  .flatMap((m) => m.files.map((f) => [f, m])).reverse());

function paintFiles() {
  const n = convFiles().length;
  chatFilesBtn.hidden = !n;
  chatFilesBtn.querySelector('.n').textContent = n > 99 ? '99+' : String(n);
  chatFilesBtn.title = `${n} attachment${n === 1 ? '' : 's'} here`;
}

function openFiles() {
  const list = convFiles().slice(0, 50);
  if (!list.length) { chatNote('nothing shared here yet'); return; }
  popMenu(chatFilesBtn, `attachments · ${convFiles().length}`, list.map(([f, m]) => ({
    label: f.name, href: mediaUrl(f),
    sub: `${humanSize(f.size || 0)} · ${m.name === name ? 'you' : m.name} · ${formatDay(m.timestamp)} ${formatTime(m.timestamp)}`,
    thumb: (f.type || '').startsWith('image/') ? mediaUrl(f) : '',
  })));
}
chatFilesBtn.addEventListener('click', openFiles);

// who's typing here, never this browser's own name
function typers(c) {
  const dm = dmWith(c);
  return people.filter((p) => p.name !== name && p.typing
    && (dm ? p.name === dm && p.typing === `dm:${name}` : p.typing === c)).map((p) => p.name);
}

function paintTyping() {
  const who = [...new Set(typers(conv))];
  const writing = isAgent(conv) && agentBusy(conv);
  chatTyping.textContent = '';
  if (!who.length && !writing) return;
  const text = writing ? `the ${conv} is writing`
    : who.length === 1 ? `${who[0]} is typing` : who.length === 2 ? `${who[0]} and ${who[1]} are typing` : `${who.length} people are typing`;
  chatTyping.append(text, el('span', 'dots'));
}

// the header's names, and the line under the box: who and where this is
function paintStatus() {
  chatStatus.classList.toggle('online', chatOnline);
  const label = chatStatus.querySelector('.label');
  label.textContent = '';
  if (!chatOnline) { label.textContent = 'offline'; return; }
  const dm = dmWith(conv);
  const agent = isAgent(conv);
  const who = (p) => {
    const span = el('span', 'who', p.name);
    span.style.color = p.color || colorFor(p.name);
    if (p.host) span.title = `${p.name}: ${p.host}`;
    return span;
  };
  const model = (a) => Object.assign(el('span', 'who who-model', a.name), { title: `${a.name}: ${a.file} on ${a.host}` });
  if (dm) {
    const p = people.find((x) => x.name === dm);
    label.append(p ? who(p) : el('span', 'who off', dm), el('span', 'st-dim', p ? ` on ${p.host}` : ' offline'));
  } else if (agent) {
    const host = agentHost(conv);
    if (host) label.append(Object.assign(el('span', 'who who-model', conv), { title: `${conv} on ${host}` }), el('span', 'st-dim', ` on ${host}`));
    else label.textContent = `no ${conv} loaded`;
  } else {
    const uniq = [...new Map(people.map((p) => [p.name, p])).values()];
    if (!uniq.length && !modelWho.length) label.textContent = 'nobody online';
    for (const p of uniq) label.append(who(p));
    for (const a of modelWho) label.append(model(a));
  }
  paintCtx();
  paintTyping();
}

// the host answering for an agent, with no chimp chosen, the one /chimp goes to
const agentHost = (r) => modelWho.find((a) => a.name === r)?.host || '';

// the editor last focused and still open: the file the models take "this file" to mean
const chatSees = document.getElementById('chat-sees');
const SEEN_MAX = 24000;
let seenEditor = '';
function seenFile() {
  const ed = seenEditor && editors.get(seenEditor);
  if (!ed) return undefined;
  const text = ed.text();
  return { ...ed.file, text: text.slice(0, SEEN_MAX), size: text.length };
}
function paintSeen() {
  const f = seenEditor && editors.get(seenEditor)?.file;
  chatSees.hidden = !f;
  if (!f) return;
  chatSees.textContent = codeName(f);
  chatSees.title = `the chimp sees ${f.label}, the file you have open, and knows you mean it`;
}

function paintCtx() {
  chatAttach.hidden = isAgent(conv);
}

function renderConv() {
  chatLog.replaceChildren();
  delete chatLog.dataset.day;
  const dm = dmWith(conv);
  if (isAgent(conv)) {
    chatNote(`only you and the ${conv} see this, kept in this browser. /clear forgets it`);
    agents[conv].turns.forEach((t, i) => putLine(turnLine(conv, t, i)));
    for (const [id, w] of agentWaiting) if (w.agent === conv) putLine(agentPendingLine(id, w));
  } else {
    if (dm) chatNote(`direct messages with ${dm}, shown only to the two of you`);
    else if (chOf(conv) && !convLines.get(conv)?.length) chatNote(`#${chOf(conv)} is new. say something, or /topic to describe it`);
    for (const m of (convLines.get(conv) || []).slice(-CHAT_KEEP)) putLine(m);
  }
  // unread since last here, under a rule
  if (freshFrom > 0) {
    const msgs = [...chatLog.querySelectorAll('li.msg')];
    const first = msgs[Math.max(0, msgs.length - freshFrom)];
    if (first) first.before(el('li', 'fresh', `${freshFrom} new`));
  }
  chatLog.scrollTop = chatLog.scrollHeight;
  chatPinned = true;
}

function setConv(c) {
  const was = conv;
  conv = c;
  freshFrom = news.get(c) || 0;
  news.delete(c);
  if (was !== c) { cancelCompose(); setChatChip(''); typingSent = ''; }
  chatTitle.querySelector('.chat-title-text').textContent = convName(conv);
  if (!chatChip.textContent) chatText.placeholder = convHint();
  renderConv();
  paintConvs();
  paintStatus();
  paintFiles();
}

// the chat app up, on this conversation
function openConv(c) {
  dkOpenApp('chat');
  setConv(c);
}

// --- incoming ---------------------------------------------------------------------

// a line in, live or from history: folded, held, drawn if on screen, noted if not
function takeLine(m, live) {
  if (MARKS.includes(m.kind)) {
    const t = fold(m);
    if (t && live && convOf(t) === conv) redrawLine(t);
    if (t && live && m.kind === 'react' && t.name === name && m.name !== name && m.on !== false) notifyChat({ name: m.name, text: `reacted ${m.emoji}` });
    return;
  }
  // an agent's invite: asked, not kept in its dm
  if (m.kind === 'show' && isAgent(m.name)) {
    if (live && isInvite(m)) { showInvite(m); notifyChat({ name: `${m.name} invited you`, text: `to work on ${m.file.label} together` }, true); }
    return;
  }
  if (m.dm && isAgent(m.name)) { agentSaid(m, live); return; }
  if (live) m.live = true;
  const ghost = live && m.name === name && sendingLines.find((g) => g.text === (m.text || '') && convOf(g) === convOf(m));
  const c = holdLine(m);
  if (ghost) settleSending(ghost, m, c);
  if (!c || !live) return;
  if (c === conv && !ghost) putLine(m, true);
  if (m.kind === 'topic') { paintConvs(); paintCtx(); return; }
  // an invite to this browser's name, fresh: asked as a dialog and notified past the bell
  if (isInvite(m)) {
    showInvite(m);
    noteNews(c);
    bumpUnread();
    notifyChat({ name: `${m.name} invited you`, text: `to work on ${m.file.label} together` }, true);
    return;
  }
  if (m.files && c === conv) paintFiles();
  if (m.kind === 'pending' || m.name === name) { paintConvs(); return; }
  noteNews(c);
  bumpUnread();
  const text = m.text || (m.files ? `shared ${m.files.map((f) => f.name).join(', ')}` : '');
  const atMe = name && new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.text || '');
  notifyChat({ name: m.dm ? `${m.name} (direct)` : atMe ? `${m.name} mentioned you` : m.ch ? `${m.name} in #${m.ch}` : m.name, text });
}

// own lines drawn at once, swapped in place for the host's echo
const sendingLines = [];
const SENDING_MS = 10000;
let sendingSeq = 0;
function putSending(fields) {
  const g = { host: 'sending', seq: sendingSeq += 1, timestamp: Date.now(), name, color: color || colorFor(name), sending: true, ...fields, text: fields.text.slice(0, 2000) };
  sendingLines.push(g);
  if (holdLine(g) === conv) putLine(g, true).classList.add('sending');
  setTimeout(() => {
    if (!sendingLines.includes(g)) return;
    sendingLines.splice(sendingLines.indexOf(g), 1);
    dropLine(keyOf(g));
    chatNote(`not sent: ${g.text.slice(0, 40)}`);
  }, SENDING_MS);
}
function settleSending(g, m, c) {
  sendingLines.splice(sendingLines.indexOf(g), 1);
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(keyOf(g))}"]`);
  if (li && c === conv) putLine(m, true, li).style.animation = 'none';
  dropLine(keyOf(g));
}

// an invite this browser hasn't answered, still fresh
const INVITE_MS = 15 * 60 * 1000;
const isInvite = (m) => m.kind === 'show' && m.file && m.dm === name && m.name !== name
  && Date.now() - m.timestamp < INVITE_MS && m.timestamp > showSeen;
let showSeen = Number(localStorage.getItem('phosphorus-show-seen')) || 0;

function renderHistory(messages, closed = {}) {
  lines.clear();
  convLines.clear();
  orphanMarks.clear();
  for (const m of messages) takeLine(m, false);
  // one sent while this browser was away, asked now
  const missed = messages.filter(isInvite).pop();
  if (missed) { showInvite(missed); notifyChat({ name: `${missed.name} invited you`, text: `to work on ${missed.file.label} together` }, true); }
  // channels closed while this browser was away, unless opened again since
  const gone = Object.keys(closed).filter((ch) => !convLines.get(`ch:${ch}`)?.length);
  if (gone.some((ch) => myChannels.includes(ch))) { myChannels = myChannels.filter((ch) => !gone.includes(ch)); saveChannels(); }
  if (gone.includes(chOf(conv))) conv = 'mesh';
  renderConv();
  paintConvs();
  paintFiles();
}

// an agent messaging this person on someone's ask: a line in its dm, once
function agentSaid(m, live) {
  const a = agents[m.name];
  if (m.timestamp <= a.seen) return;
  a.seen = m.timestamp;
  addAgentTurn(m.name, { role: 'assistant', text: m.text, at: m.timestamp });
  if (!live) return;
  noteNews(m.name);
  bumpUnread();
  notifyChat({ name: m.name, text: m.text });
}

// --- the agents' dms -------------------------------------------------------------

// one turn as a chat line: theirs, the agent's, or a notice
function turnLine(r, t, i) {
  return {
    host: 'agent', seq: `${r}-${i}`, timestamp: t.at, name: t.role === 'user' ? name : t.by || r, color: color || undefined,
    kind: t.role === 'assistant' ? 'model' : t.role === 'notice' ? 'notice' : undefined, text: t.text, html: t.html,
  };
}

const agentPendingLine = (id, w) => ({ host: 'agent', seq: id, timestamp: w.at, name: w.agent, kind: 'pending' });

function addAgentTurn(r, t, was = null) {
  const { turns } = agents[r];
  turns.push(t);
  if (turns.length > AGENT_KEEP) turns.splice(0, turns.length - AGENT_KEEP);
  saveAgents();
  if (conv === r) { putLine(turnLine(r, t, turns.length - 1), true, was); paintFiles(); }
  paintConvs();
}

// its context forgotten, the conversation left open and empty
function clearAgent(r) {
  agents[r] = { turns: [], seen: Date.now() };
  for (const [id, w] of agentWaiting) if (w.agent === r) agentWaiting.delete(id);
  saveAgents();
  if (conv === r) { renderConv(); paintFiles(); paintTyping(); }
}

// their line and the agent's spinner under it, until the answer lands
function agentPending(r, id, text) {
  addAgentTurn(r, { role: 'user', text, at: Date.now() });
  agentWaiting.set(id, { agent: r, at: Date.now() });
  if (conv === r) putLine(agentPendingLine(id, agentWaiting.get(id)), true);
  paintTyping();
}

// the whole conversation as its context
function sendAgent(r, text) {
  if (agentBusy(r)) { if (conv === r) chatNote(`the ${r} is still answering the last one`); return; }
  const history = agents[r].turns.filter((t) => t.role !== 'notice').map(({ role, text: tx }) => ({ role, text: tx }));
  const id = newSid().slice(0, 12);
  agentPending(r, id, text);
  send({ type: 'agent', id, to: r, text, history, open: seenFile() });
}

// its answer in the making dropped, the model told to stop
function stopAgent(r) {
  const id = [...agentWaiting].find(([, w]) => w.agent === r)?.[0];
  if (!id) { chatNote(`the ${r} isn't answering anything`); return; }
  send({ type: 'agent-stop', id });
  agentAnswered({ id, error: 'stopped' });
}

stModelRoles.addEventListener('click', (e) => {
  const b = e.target.closest('.st-clear');
  if (!b || b.disabled) return;
  b.disabled = true;
  b.textContent = 'clearing';
  send({ type: 'agent-purge', id: `st:${b.dataset.role}`, to: b.dataset.role });
});

// the llama-server slots on its host erased, a fresh start for its kv cache
function purgeAgent(r) {
  send({ type: 'agent-purge', id: r, to: r });
  chatNote(`purging the ${r}'s cache`);
}
function agentPurged(msg) {
  const btn = stModelRoles.querySelector(`.st-clear[data-role="${CSS.escape(String(msg.id).replace(/^st:/, ''))}"]`);
  if (btn && msg.id.startsWith('st:')) {
    btn.disabled = false;
    btn.textContent = msg.error ? `no clear: ${msg.error}` : 'cleared';
    setTimeout(() => { btn.textContent = 'clear context'; }, 2500);
    return;
  }
  if (conv !== msg.id) return;
  if (msg.error) { chatNote(`no purge: ${msg.error}`); return; }
  chatNote(`the ${msg.id}'s cache on ${msg.host} cleared, ${msg.erased} slot${msg.erased === 1 ? '' : 's'}${msg.busy ? `, ${msg.busy} mid-answer left alone` : ''}`);
}

// the answer, or why there's none, counted on the agent while away from it
function agentAnswered(msg) {
  const w = agentWaiting.get(msg.id);
  if (!w) return;
  agentWaiting.delete(msg.id);
  const was = chatLog.querySelector(`li[data-key="${CSS.escape(`agent:${msg.id}`)}"]`);
  paintTyping();
  const by = isAgent(msg.by) && msg.by !== w.agent ? { by: msg.by } : {};
  const said = String(msg.error || msg.text || '');
  addAgentTurn(w.agent, msg.error ? { role: 'notice', text: said, at: Date.now() } : { role: 'assistant', text: said, html: msg.html, ...by, at: Date.now() }, was);
  was?.remove();
  noteNews(w.agent);
  bumpUnread();
  notifyChat({ name: by.by || w.agent, text: said });
}

// --- the socket -------------------------------------------------------------------

// the chat socket proved alive: a ping when it's been quiet, on coming back
// and coming online, closed for a fresh one when no answer lands
let chatHeard = 0;
const CHAT_QUIET_MS = 25000;
const CHAT_PONG_MS = 4000;
function chatAwake(now = false) {
  if (!wsOpen() || (!now && Date.now() - chatHeard < CHAT_QUIET_MS)) return;
  const sock = ws;
  const asked = Date.now();
  send({ type: 'ping' });
  // a dead socket's own close can take minutes, so its close run now
  setTimeout(() => {
    if (ws !== sock || chatHeard >= asked) return;
    const closed = sock.onclose;
    sock.onclose = null;
    sock.onmessage = null;
    sock.close();
    closed();
  }, CHAT_PONG_MS);
}
setInterval(() => { if (!document.hidden) chatAwake(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) chatAwake(true); });
window.addEventListener('online', () => chatAwake(true));

function connectChat() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => {
    reconnectDelay = 300;
    chatHeard = Date.now();
    chatOnline = true;
    paintStatus();
    send({ type: 'join', name, color: color || undefined });
  };
  ws.onclose = () => {
    // an answer in flight lost with the socket
    for (const id of [...agentWaiting.keys()]) agentAnswered({ id, error: 'the connection dropped before it answered, ask again' });
    credsClose();
    people = [];
    chatOnline = false;
    paintStatus();
    setTimeout(() => { if (name) connectChat(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    chatHeard = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'history') {
      chMetas = msg.channels && typeof msg.channels === 'object' ? msg.channels : {};
      renderHistory(msg.messages, msg.closed && typeof msg.closed === 'object' ? msg.closed : {});
    } else if (msg.type === 'message') {
      const { type, ...m } = msg;
      takeLine(m, true);
    } else if (msg.type === 'phosphorus-ui') {
      phosphorusPressed(msg.action);
    } else if (msg.type === 'agent-reply') {
      agentAnswered(msg);
    } else if (msg.type === 'agent-purged') {
      agentPurged(msg);
    } else if (msg.type === 'retract') {
      dropLine(`${msg.host}:${msg.seq}`);
    } else if (msg.type === 'presence') {
      people = msg.people;
      paintStatus();
      paintConvs();
      paintFiles();
    } else if (msg.type === 'system') {
      sysLine('mesh', msg.text);
    } else if (msg.type === 'clear') {
      for (const m of [...(convLines.get('mesh') || [])]) lines.delete(keyOf(m));
      convLines.delete('mesh');
      if (conv === 'mesh') renderConv();
      sysLine('mesh', msg.by ? `chat cleared by ${msg.by}` : 'chat cleared');
      paintFiles();
    } else if (msg.type === 'close') {
      if (typeof msg.ch === 'string') channelClosed(msg.ch, msg.by);
    } else if (msg.type === 'channel') {
      if (typeof msg.ch === 'string' && msg.meta && typeof msg.meta === 'object') { chMetas[msg.ch] = msg.meta; paintConvs(); paintCtx(); }
    }
  };
}

// --- typing ---------------------------------------------------------------------

// where a key went down, said again every few seconds while it keeps going
const TYPING_EVERY_MS = 3000;
let typingSent = '';
let typingAt = 0;
function typingTick() {
  const busy = chatText.value.trim() && !chatText.value.startsWith('/') && !chatChip.textContent && !isAgent(conv);
  const where = busy ? conv : '';
  if (where === typingSent && (!where || Date.now() - typingAt < TYPING_EVERY_MS)) return;
  typingSent = where;
  typingAt = Date.now();
  send({ type: 'typing', conv: where });
}

// --- attachments ------------------------------------------------------------------

// uploaded the moment they're picked, pasted or dropped, sent with the next line
let atts = [];

function paintAtts() {
  chatAtts.hidden = !atts.length;
  chatAtts.replaceChildren(...atts.map((a) => {
    const li = el('li', `att ${a.state}`);
    li.append(el('span', 'att-name', a.file.name), el('span', 'att-state', a.state === 'up' ? `${a.pct}%` : a.state === 'err' ? a.error : humanSize(a.file.size)));
    const x = Object.assign(el('button', 'att-x', '×'), { type: 'button', title: 'remove' });
    x.addEventListener('click', () => { a.xhr?.abort(); atts = atts.filter((b) => b !== a); paintAtts(); syncSend(); });
    li.append(x);
    return li;
  }));
  syncSend();
}

function addFiles(list) {
  if (!joined() || isAgent(conv)) return;
  for (const file of list) {
    const a = { file, state: 'up', pct: 0, meta: null, error: '' };
    const xhr = new XMLHttpRequest();
    a.xhr = xhr;
    xhr.open('POST', `/api/chat/upload?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || '')}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { a.pct = Math.round((e.loaded / e.total) * 100); paintAtts(); } };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && body.id) { a.state = 'done'; a.meta = body; } else { a.state = 'err'; a.error = body.error || `failed (${xhr.status})`; }
      a.xhr = null;
      paintAtts();
    };
    xhr.onerror = () => { a.state = 'err'; a.error = 'upload failed'; a.xhr = null; paintAtts(); };
    xhr.send(file);
    atts.push(a);
  }
  paintAtts();
  chatText.focus();
}

chatAttach.addEventListener('click', () => chatFile.click());
chatFile.addEventListener('change', () => { addFiles([...chatFile.files]); chatFile.value = ''; });
chatText.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
// anything dragged over the panel, its own overlay until dropped or gone
let dragDepth = 0;
const dragsFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
chatPanel.addEventListener('dragenter', (e) => {
  if (!dragsFiles(e) || !joined() || isAgent(conv)) return;
  dragDepth += 1;
  chatDrop.hidden = false;
});
chatPanel.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) chatDrop.hidden = true; });
chatPanel.addEventListener('dragover', (e) => { if (dragsFiles(e)) e.preventDefault(); });
chatPanel.addEventListener('drop', (e) => {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  chatDrop.hidden = true;
  addFiles([...e.dataTransfer.files]);
});

// --- reply, react, edit, delete ---------------------------------------------------

// the line being answered or rewritten, shown over the box until sent or esc
let replyTo = null;
let editing = null;

function paintBar() {
  const m = replyTo || editing;
  chatBar.hidden = !m;
  if (!m) return;
  const t = (m.edited ?? m.text) || '';
  chatBar.replaceChildren(
    el('span', 'bar-kind', editing ? 'editing' : `replying to ${m.name}`),
    el('span', 'bar-text', t.replace(/\s+/g, ' ').slice(0, 100)),
    el('span', 'bar-esc', 'esc cancel'),
  );
}

function cancelCompose() {
  if (editing) { chatText.value = ''; autoGrowChatText(); }
  replyTo = null;
  editing = null;
  paintBar();
}

function startEdit(m) {
  replyTo = null;
  editing = m;
  setChatChip('');
  chatText.value = m.edited ?? m.text;
  autoGrowChatText();
  paintBar();
  chatText.focus();
}

chatLog.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const li = b.closest('li');
  const m = b.dataset.act === 'goto' ? lines.get(b.dataset.ref) : lines.get(li?.dataset.key);
  if (!m) return;
  const act = b.dataset.act;
  if (act === 'goto') {
    const t = chatLog.querySelector(`li[data-key="${CSS.escape(b.dataset.ref)}"]`);
    if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.remove('flash');
    void t.offsetWidth;
    t.classList.add('flash');
  } else if (act === 'show') {
    if (m.file) dkCode(m.file);
  } else if (act === 'react') react(m, b.dataset.emoji);
});

function react(m, emoji) {
  const on = m.reacts?.get(`${name}\n${emoji}`)?.on;
  send({ type: 'react', ref: keyOf(m), emoji, on: !on });
}

// right click, or a long press on a phone: react, reply, edit, delete, on any line
chatLog.addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li.msg[data-acts]');
  const m = li && lines.get(li.dataset.key);
  if (!m || e.target.closest('a')) return;
  e.preventDefault();
  const mine = li.dataset.acts === 'mine';
  const items = [{ label: 'reply', act: () => { editing = null; replyTo = m; paintBar(); chatText.focus(); } }];
  if (mine && (!m.kind || m.kind === 'dm')) items.push({ label: 'edit', act: () => startEdit(m) });
  if (mine) items.push({ label: 'delete', sub: 'for everyone', danger: true, confirm: 'sure? delete it', act: () => send({ type: 'delete', ref: keyOf(m) }) });
  const row = el('div', 'pop-reacts');
  for (const r of REACTIONS) {
    const x = Object.assign(el('button', m.reacts?.get(`${name}\n${r}`)?.on ? 'on' : '', r), { type: 'button' });
    x.addEventListener('click', () => { react(m, r); closePop(false); });
    row.append(x);
  }
  popMenu(li, row, items, 0, { x: e.clientX, y: e.clientY });
});

// --- find ---------------------------------------------------------------------------

function findIn(li) {
  const q = chatFindInput.value.trim().toLowerCase();
  if (!li.matches('.msg, .sys')) return;
  li.classList.toggle('miss', !!q && !li.textContent.toLowerCase().includes(q));
}

function runFind() {
  const all = [...chatLog.querySelectorAll('li.msg, li.sys')];
  all.forEach(findIn);
  const q = chatFindInput.value.trim();
  chatFindCount.textContent = q ? `${all.filter((li) => !li.classList.contains('miss')).length} of ${all.length}` : '';
  chatLog.classList.toggle('finding', !!q);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function toggleFind(on = chatFind.hidden) {
  chatFind.hidden = !on;
  if (!on) { chatFindInput.value = ''; runFind(); chatText.focus(); return; }
  chatFindInput.focus();
  chatFindInput.select();
}

document.getElementById('chat-find-btn').addEventListener('click', () => toggleFind());
chatFindInput.addEventListener('input', runFind);
chatFindInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); toggleFind(false); }
});

// --- commands -----------------------------------------------------------------------

// a channel opened or made from the conversations' +, a topic after its name
function joinChannel(arg) {
  const [raw, ...topic] = arg.trim().split(/s+/);
  const ch = (raw || '').replace(/^#/, '').toLowerCase();
  if (ch === 'mesh') { setConv('mesh'); return; }
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(ch)) { chatNote('a channel name: lowercase letters, digits and dashes'); return; }
  if (!myChannels.includes(ch)) myChannels.push(ch);
  delete leftChannels[ch];
  saveChannels();
  const fresh = !convLines.get(`ch:${ch}`)?.length;
  openConv(`ch:${ch}`);
  if (fresh || topic.length) send({ type: 'topic', ch, text: topic.join(' ') });
}

function runCommand(input) {
  const [cmd, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(' ').trim();
  const agentHere = isAgent(conv);

  // in #mesh or a channel a line everyone sees, answered there or in a dm once
  // long, anywhere else or bare: the agent's own dm
  const agent = AGENT_CMDS[cmd.toLowerCase()];
  if (agent) {
    if ((conv === 'mesh' || chOf(conv)) && arg) { send({ type: 'message', text: input.trim(), ch: chOf(conv) || undefined, open: seenFile() }); return; }
    openConv(agent);
    if (arg) sendAgent(agent, arg);
    return;
  }
  if (cmd === '/share') {
    // in a dm, its other end unless another name leads
    let to = nameIn(arg);
    let what = arg.slice(to.length).trim();
    if (dmWith(conv) && !knownNames().includes(to)) { to = dmWith(conv); what = arg; }
    if (!to || to === name || !what) { chatNote('usage: /share name file, an open editor tab or a file as the files tab shows it'); return; }
    if (isAgent(to)) { chatNote(`ask the ${to} to open it, it can`); return; }
    resolveShow(what).then((f) => {
      if (!f) { chatNote(`no open editor tab or shared file called ${what}`); return; }
      chatNote(`${shareWith(to, f)}, it's open in its own tab`);
      dkCode(f);
    });
    return;
  }
  if (cmd === '/dm') {
    const to = nameIn(arg);
    if (!to || to === name) { chatNote('usage: /dm name [message]'); return; }
    const text = arg.slice(to.length).trim();
    if (isAgent(to)) { openConv(to); if (text) sendAgent(to, text); return; }
    openConv(`dm:${to}`);
    if (text) send({ type: 'dm', to, text });
    return;
  }
  if (cmd === '/chat') { setConv('mesh'); return; }
  if (agentHere && cmd === '/clear') { clearAgent(conv); return; }
  if (agentHere && cmd === '/stop') { stopAgent(conv); return; }
  if (agentHere && cmd === '/purge') { purgeAgent(conv); return; }
  if (cmd === '/leave' && chOf(conv)) { leaveChannel(chOf(conv)); return; }
  // asked once more in the menu, never closed on one keystroke
  if (cmd === '/close' && chOf(conv)) { convMenu(conv, chatTitle, true); return; }
  if (cmd === '/topic' && chOf(conv)) { send({ type: 'topic', ch: chOf(conv), text: arg }); return; }
  if (cmd === '/rename') {
    if (acct) { chatNote('your chat name is your user name'); return; }
    if (!arg) { chatNote('usage: /rename name'); return; }
    name = arg.slice(0, 32);
    localStorage.setItem('phosphorus-chat-name', name);
    send({ type: 'rename', name });
    return;
  }
  if (cmd === '/recolor') {
    const idx = arg ? COLOR_NAMES.indexOf(arg.toLowerCase()) : -1;
    if (arg && idx === -1) { chatNote(`usage: /recolor ${COLOR_NAMES.join('|')}`); return; }
    color = idx !== -1 ? NAME_COLORS[idx] : NAME_COLORS[Math.floor(Math.random() * NAME_COLORS.length)];
    localStorage.setItem('phosphorus-chat-color', color);
    send({ type: 'recolor', color });
    return;
  }
  if (agentHere || dmWith(conv)) { chatNote(`${cmd} isn't for here`); return; }
  // the mesh channel's own, everyone's, not a local scrollback wipe
  if (cmd === '/clear' && conv === 'mesh') { send({ type: 'clear' }); return; }
  chatNote(`unknown command: ${cmd}`);
}

// every name this browser knows of, and the longest of them an argument starts
// with, names with spaces included
const knownNames = () => [...new Set([...people.map((p) => p.name), ...[...convLines.keys()].map(dmWith).filter(Boolean), ...AGENTS])]
  .filter((n) => n !== name);
const nameIn = (arg) => knownNames().sort((a, b) => b.length - a.length).find((n) => arg === n || arg.startsWith(`${n} `)) || arg.split(/\s+/)[0];

// a file offered to someone: an invite as a dm, a dialog on their end
function shareWith(to, f) {
  if (!joined()) return 'join the chat first, then share';
  send({ type: 'show', to, file: f });
  return `invited ${to} to ${f.label}`;
}
// the people to offer it to, those on first; done says how it went
function shareMenu(anchor, f, done) {
  const on = (n) => people.some((p) => p.name === n);
  const who = knownNames().filter((n) => !isAgent(n)).sort((a, b) => on(b) - on(a) || a.localeCompare(b));
  popMenu(anchor, `share ${codeName(f)} with`, who.length
    ? who.map((n) => ({ label: n, sub: on(n) ? 'online' : 'asked when they are back', act: () => done(shareWith(n, f)) }))
    : [{ label: 'nobody else here yet', act: () => {} }]);
}

// a /share's file: an open editor tab by its name or path, else a file as the
// files tab shows it, host then the share's root then the path
async function resolveShow(what) {
  const w = what.replace(/^\/+/, '');
  for (const id of codeTabs.values()) {
    const f = editors.get(id)?.file;
    if (f && (f.label === w || f.path === w || codeName(f) === w || f.label.endsWith(`/${w}`))) return f;
  }
  const [host, ...rest] = w.split('/');
  if (![selfHost, ...phosphorusHosts()].includes(host) || !rest.length) return null;
  const info = await fetch(`/api/files/${encodeURIComponent(host)}/info`).then((r) => r.json()).catch(() => null);
  const full = rest.join('/');
  const bare = (l) => String(l || '').replace(/^\/+|\/+$/g, '');
  const sh = (info?.shares || []).filter((x) => full.startsWith(`${bare(x.label)}/`)).sort((a, b) => bare(b.label).length - bare(a.label).length)[0];
  if (!sh) return null;
  const rel = full.slice(bare(sh.label).length + 1);
  return rel ? { host, share: sh.id, path: rel, label: fileLabel(host, sh.label, rel) } : null;
}

// the dialog for an invite to this browser
const showModal = document.getElementById('show-modal');
let showFile = null;
function showInvite(m) {
  showFile = m.file;
  showSeen = Math.max(showSeen, m.timestamp);
  try { localStorage.setItem('phosphorus-show-seen', String(showSeen)); } catch {}
  document.getElementById('show-modal-text').replaceChildren(el('b', '', m.name), ' wants to work on ', el('code', '', m.file.label), ' with you, in a shared editor.');
  showModal.hidden = false;
  document.getElementById('show-modal-go').focus();
}
const closeShow = () => { showModal.hidden = true; };
document.getElementById('show-modal-go').addEventListener('click', () => { closeShow(); if (showFile) dkCode(showFile); });
document.getElementById('show-modal-no').addEventListener('click', closeShow);
document.getElementById('show-modal-close').addEventListener('click', closeShow);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !showModal.hidden) closeShow(); });

// the choices a command's words already have: people, open files, channels, colours
function argHints() {
  const cmd = chatChip.textContent;
  const v = chatText.value;
  const online = (n) => (people.some((p) => p.name === n) ? 'online' : isAgent(n) ? 'agent' : 'offline');
  let prefix = '';
  let list = [];
  if (cmd === '/dm' || cmd === '/share') {
    const who = knownNames().sort((a, b) => b.length - a.length).find((n) => v.startsWith(`${n} `));
    if (!who) list = knownNames().filter((n) => cmd === '/dm' || !isAgent(n)).map((n) => [n, online(n)]);
    else if (cmd === '/share') {
      prefix = `${who} `;
      list = [...codeTabs.values()].map((id) => editors.get(id)?.file).filter(Boolean).map((f) => [f.label, 'open in an editor tab']);
    }
  } else if (cmd === CHANNEL_CHIP[0]) list = channels().map((c) => [c, topicOf(`ch:${c}`) || 'channel']);
  else if (cmd === '/recolor') list = COLOR_NAMES.map((c) => [c, '']);
  const token = v.slice(prefix.length).toLowerCase();
  return list.filter(([x]) => x.toLowerCase().includes(token) && x.toLowerCase() !== token).slice(0, 8).map(([x, what]) => ({
    label: x, what,
    pick: () => {
      chatText.value = `${prefix}${x}${cmd === '/recolor' || prefix ? '' : ' '}`;
      chatText.setSelectionRange(chatText.value.length, chatText.value.length);
      autoGrowChatText();
    },
  }));
}

// name, what it does, and the box's placeholder once chosen, none for a
// command that takes nothing
const AGENT_CMDS = { '/chimp': 'chimp' };
const ASK_CMDS = [
  ['/chimp', 'ask the chimp, small and quick', 'ask the chimp'],
];
const DM_CMD = ['/dm', 'message one person directly', 'name, then the message'];
// not a command: the conversations' + asking for a channel's name
const CHANNEL_CHIP = ['#', 'open or make a channel', 'channel name, then a topic'];
const SHARE_CMD = ['/share', 'work on a file together', 'name, then an open tab or a shared file'];
const BACK_CMD = ['/chat', 'back to #mesh', ''];
const ME_CMDS = [['/recolor', 'change your colour', COLOR_NAMES.join(', ')]];
function commands() {
  if (isAgent(conv)) {
    return [BACK_CMD, ...ASK_CMDS, ['/stop', `stop the ${conv}'s answer`, ''], ['/clear', 'clear this conversation and its context', ''],
      ['/purge', `clear the ${conv}'s cache on its host`, ''], DM_CMD, SHARE_CMD];
  }
  if (dmWith(conv)) return [BACK_CMD, SHARE_CMD, ...ASK_CMDS, DM_CMD];
  return [
    ...ASK_CMDS, DM_CMD, SHARE_CMD,
    ...(chOf(conv) ? [['/topic', 'describe this channel', 'topic'], ['/leave', 'hide it from your list', ''], ['/close', 'close it for everyone', ''], BACK_CMD] : [['/clear', 'clear #mesh for everyone', '']]),
    ...ME_CMDS,
  ];
}
let chatHits = [];
let chatHit = 0;

// a command that takes words, held beside the box rather than in it, so
// spellcheck never underlines it and it keeps its colour
function setChatChip(cmd) {
  const spec = [CHANNEL_CHIP, ...commands()].find(([c]) => c === cmd);
  chatChip.textContent = cmd || '';
  chatChip.hidden = !cmd;
  chatText.placeholder = spec ? spec[2] : convHint();
}

// a command picked from outside the box, its words typed next
function startCommand(cmd) {
  if (!joined()) { chatName.focus(); return; }
  setChatChip(cmd);
  chatText.value = '';
  autoGrowChatText();
  chatText.focus();
}

// while the first word is a command in the making, the ones it could be,
// one lit for tab or enter
function renderChatCmds() {
  const m = chatText.value.match(/^(\/\S*)$/);
  const hits = editing ? []
    : chatChip.textContent ? argHints()
      : m ? commands().filter(([c]) => c.startsWith(m[1].toLowerCase())).map(([c, what]) => ({ label: c, what, cmd: true, pick: () => pickChatCmd(c) })) : [];
  if (hits.map((h) => h.label).join() !== chatHits.map((h) => h.label).join()) chatHit = 0;
  chatHits = hits;
  chatCmds.hidden = !hits.length;
  chatCmds.replaceChildren(...hits.map((h, i) => {
    const li = el('li', i === chatHit ? 'on' : '');
    li.append(el('span', h.cmd ? 'cmd' : 'cmd hint', h.label), el('span', 'cmd-what', h.what));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keeps the box focused
      h.pick();
    });
    return li;
  }));
}

// a command taking words as the chip, one taking none run
function pickChatCmd(cmd) {
  const spec = commands().find(([c]) => c === cmd);
  if (spec && !spec[2]) {
    chatText.value = cmd;
    chatForm.requestSubmit();
    return;
  }
  setChatChip(cmd);
  chatText.value = '';
  chatText.dispatchEvent(new Event('input'));
}

const uploading = () => atts.some((a) => a.state === 'up');
function syncSend() {
  chatSend.disabled = !chatText.value.trim() && !chatChip.textContent && !atts.some((a) => a.state === 'done');
}

// the box grown to its text, the arrow lit only once there is something to send
function autoGrowChatText() {
  chatText.style.height = 'auto';
  chatText.style.height = `${chatText.scrollHeight}px`;
  syncSend();
  renderChatCmds();
}

chatText.addEventListener('input', () => {
  // a command typed out in full, then a space: into the chip
  const typed = !chatChip.textContent && !editing && chatText.value.match(/^(\/\S+)\s/);
  const spec = typed && commands().find(([c, , takes]) => c === typed[1].toLowerCase() && takes);
  if (spec) {
    setChatChip(spec[0]);
    chatText.value = chatText.value.slice(typed[0].length);
  }
  autoGrowChatText();
  typingTick();
});
chatText.addEventListener('blur', () => { if (typingSent) { typingSent = ''; send({ type: 'typing', conv: '' }); } });
chatName.addEventListener('input', () => { chatJoinGo.disabled = !chatName.value.trim(); });

chatText.addEventListener('keydown', (e) => {
  if (chatHits.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    chatHit = (chatHit + (e.key === 'ArrowDown' ? 1 : chatHits.length - 1)) % chatHits.length;
    renderChatCmds();
    return;
  }
  if (chatHits.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
    e.preventDefault();
    chatHits[chatHit].pick();
    return;
  }
  if (e.key === 'Escape' && chatHits.length) {
    e.preventDefault();
    chatHits = [];
    chatCmds.hidden = true;
    return;
  }
  // esc: a reply or edit dropped first, the box left only after
  if (e.key === 'Escape' && (replyTo || editing)) {
    e.preventDefault();
    cancelCompose();
    return;
  }
  // ↑ in an empty box: your last line here, to edit
  if (e.key === 'ArrowUp' && !chatText.value && !chatChip.textContent && !isAgent(conv)) {
    const m = (convLines.get(conv) || []).findLast((x) => x.name === name && (!x.kind || x.kind === 'dm') && !x.gone);
    if (m) { e.preventDefault(); startEdit(m); }
    return;
  }
  // backspace at the very start: the chip back as text
  if (e.key === 'Backspace' && chatChip.textContent && chatText.selectionStart === 0 && chatText.selectionEnd === 0) {
    e.preventDefault();
    const cmd = chatChip.textContent;
    setChatChip('');
    chatText.value = `${cmd}${chatText.value}`;
    chatText.setSelectionRange(cmd.length, cmd.length);
    autoGrowChatText();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = `${chatChip.textContent} ${chatText.value}`.trim();
  if (!wsOpen()) { chatNote('offline, reconnecting'); return; }
  if (editing) {
    if (text) send({ type: 'edit', ref: keyOf(editing), text });
    cancelCompose();
    chatText.value = '';
    autoGrowChatText();
    return;
  }
  const files = atts.filter((a) => a.state === 'done').map((a) => a.meta);
  if (!text && !files.length) return;
  if (uploading()) { chatNote('still uploading, send once it lands'); return; }
  chatText.value = '';
  setChatChip('');
  autoGrowChatText();
  typingTick();
  if (text.startsWith(`${CHANNEL_CHIP[0]} `) && !files.length) {
    joinChannel(text.slice(CHANNEL_CHIP[0].length));
    return;
  }
  if (text.startsWith('/') && !files.length) {
    runCommand(text);
    return;
  }
  const agent = isAgent(conv) && conv;
  // easter egg: the mesh's apes answering, the main chat brought up
  if (!agent && /^\s*ape apart weak\W*$/i.test(text)) {
    send({ type: 'message', text });
    openConv('mesh');
    return;
  }
  const re = replyTo ? keyOf(replyTo) : undefined;
  replyTo = null;
  paintBar();
  atts = [];
  paintAtts();
  if (agent) { sendAgent(agent, text); return; }
  const files1 = files.length ? files : undefined;
  if (dmWith(conv)) {
    send({ type: 'dm', to: dmWith(conv), text, files, re });
    putSending({ kind: 'dm', dm: dmWith(conv), text, files: files1, re });
  } else {
    send({ type: 'message', text, files, re, ch: chOf(conv) || undefined, open: /^\/chimp(?=\s|$)/i.test(text) ? seenFile() : undefined });
    putSending({ text, files: files1, re, ch: chOf(conv) || undefined });
  }
});

chatJoin.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = chatName.value.trim().slice(0, 32);
  if (!v) return;
  name = v;
  localStorage.setItem('phosphorus-chat-name', name);
  chatJoin.hidden = true;
  chatCompose.hidden = false;
  connectChat();
});

// joined as the logged in user, never before
function chatAs(user) {
  if (user === name && ws && ws.readyState <= WebSocket.OPEN) return;
  name = user;
  try { if (user) localStorage.setItem('phosphorus-chat-name', user); } catch {}
  chatJoin.hidden = !!user;
  chatCompose.hidden = !user;
  if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  else if (user) connectChat();
}
setConv('mesh');

// --- code editor ------------------------------------------------------------------
// a share's text or code file in a tab of its own, joined to the file's live
// session on its host, so everyone with it open edits the same text: highlighted
// as it's typed (a textarea over its highlighted copy), indents kept, pairs
// closed, syntax errors marked by a parse alone, saved once typing pauses;
// nothing in it ever runs

// by extension: highlight.js's language, the parser checking it, the line comment
const CODE_EXT = {
  js: ['javascript', 'javascript', '//'], mjs: ['javascript', 'javascript', '//'], cjs: ['javascript', 'javascript', '//'], jsx: ['javascript', 'javascript:jsx', '//'],
  ts: ['typescript', 'javascript:ts', '//'], mts: ['typescript', 'javascript:ts', '//'], tsx: ['typescript', 'javascript:jsx ts', '//'],
  py: ['python', 'python', '#'], sh: ['bash', '', '#'], bash: ['bash', '', '#'], zsh: ['bash', '', '#'],
  c: ['c', 'cpp', '//'], h: ['c', 'cpp', '//'], cpp: ['cpp', 'cpp', '//'], cc: ['cpp', 'cpp', '//'], cxx: ['cpp', 'cpp', '//'], hpp: ['cpp', 'cpp', '//'],
  go: ['go', 'go', '//'], rs: ['rust', 'rust', '//'], java: ['java', 'java', '//'], rb: ['ruby', '', '#'], lua: ['lua', '', '--'],
  cs: ['csharp', '', '//'], kt: ['kotlin', '', '//'], swift: ['swift', '', '//'], php: ['php', 'php', '//'], r: ['r', '', '#'],
  scala: ['scala', '', '//'], dart: ['dart', '', '//'], ex: ['elixir', '', '#'], exs: ['elixir', '', '#'], hs: ['haskell', '', '--'],
  jl: ['julia', '', '#'], nix: ['nix', '', '#'], ps1: ['powershell', '', '#'], sql: ['sql', '', '--'], proto: ['protobuf', '', '//'],
  css: ['css', 'css', ''], scss: ['scss', '', '//'], html: ['xml', 'html', ''], htm: ['xml', 'html', ''], xml: ['xml', 'xml', ''], svg: ['xml', 'xml', ''],
  json: ['json', 'json', ''], yml: ['yaml', 'yaml', '#'], yaml: ['yaml', 'yaml', '#'], toml: ['ini', '', '#'], ini: ['ini', '', ';'], conf: ['ini', '', '#'],
  cfg: ['ini', '', '#'], env: ['bash', '', '#'], md: ['markdown', '', ''], tex: ['latex', '', '%'], cmake: ['cmake', '', '#'],
  txt: ['plaintext', '', ''], log: ['plaintext', '', ''], csv: ['plaintext', '', ''],
};
const CODE_NAMES = { dockerfile: ['dockerfile', '', '#'], makefile: ['makefile', '', '#'], 'cmakelists.txt': ['cmake', '', '#'] };
function codeLang(p) {
  const base = String(p || '').split('/').pop().toLowerCase();
  const hit = CODE_NAMES[base] || (base.includes('.') && CODE_EXT[base.split('.').pop()]);
  return hit ? { hl: hit[0], check: hit[1], comment: hit[2] } : null;
}
// any text kind the editor knows, code or prose: what a double click opens in it
const isCode = (p) => !!codeLang(p);

// --- the text operations the session speaks (collab.js's, here for the tab's end) ---

const opIns = (o) => typeof o === 'string';
const opDel = (o) => typeof o === 'number' && o < 0;
function opBuilder() {
  const ops = [];
  const add = (o) => {
    if (o === 0 || o === '') return;
    const last = ops[ops.length - 1];
    if (opIns(o) && opDel(last)) {
      const before = ops[ops.length - 2];
      if (opIns(before)) ops[ops.length - 2] = before + o; else ops.splice(ops.length - 1, 0, o);
    } else if (last !== undefined && typeof last === typeof o && (opIns(o) || (o > 0) === (last > 0))) ops[ops.length - 1] = last + o;
    else ops.push(o);
  };
  return { ops, retain: (n) => add(n), insert: (s) => add(s), del: (n) => add(-n) };
}
function opApply(doc, ops) {
  let out = '';
  let at = 0;
  for (const o of ops) {
    if (opIns(o)) out += o;
    else if (o > 0) { out += doc.slice(at, at + o); at += o; } else at -= o;
  }
  return out;
}
function opTransform(a, b) {
  const a1 = opBuilder();
  const b1 = opBuilder();
  let i = 0;
  let j = 0;
  let x = a[i++];
  let y = b[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if (opIns(x)) { a1.insert(x); b1.retain(x.length); x = a[i++]; continue; }
    if (opIns(y)) { a1.retain(y.length); b1.insert(y); y = b[j++]; continue; }
    if (x === undefined || y === undefined) throw new Error('operations of different lengths');
    const n = Math.min(Math.abs(x), Math.abs(y));
    if (x > 0 && y > 0) { a1.retain(n); b1.retain(n); } else if (x < 0 && y > 0) a1.del(n); else if (x > 0 && y < 0) b1.del(n);
    x = Math.abs(x) === n ? a[i++] : x > 0 ? x - n : x + n;
    y = Math.abs(y) === n ? b[j++] : y > 0 ? y - n : y + n;
  }
  return [a1.ops, b1.ops];
}
// one replace: what changed between two texts, by their common ends
function opDiff(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e += 1;
  const o = opBuilder();
  o.retain(s);
  o.insert(b.slice(s, b.length - e));
  o.del(a.length - s - e);
  o.retain(e);
  return o.ops;
}
// where a place in the text lands after an edit
function opMap(ops, pos) {
  let i = 0;
  let j = 0;
  for (const o of ops) {
    if (opIns(o)) { j += o.length; continue; }
    const n = Math.abs(o);
    if (pos <= i + n) return o > 0 ? j + (pos - i) : j;
    i += n;
    if (o > 0) j += n;
  }
  return j;
}

// --- editors ---------------------------------------------------------------------

// tab id -> its editor, host\nshare\npath -> its id
const editors = new Map();
const codeTabs = new Map();
let codeSeq = 0;
const codeKey = (f) => `${f.host}\n${f.share}\n${f.path}`;
const codeName = (f) => f.path.split('/').pop() || f.path;

// a file as the files tab names it: host, then the share's root, then the path
const fileLabel = (host, root, rel) => filesPath(host, root, rel);

const anyCodeDirty = () => [...editors.values()].some((ed) => ed.dirty());
window.addEventListener('beforeunload', (e) => { if (anyCodeDirty()) e.preventDefault(); });

function codeEditor(view, file, btn, id) {
  const lang = codeLang(file.path) || { hl: 'plaintext', check: '', comment: '' };
  const bar = el('div', 'code-bar');
  const pathEl = el('span', 'code-path', file.label);
  const whoEl = el('span', 'code-who');
  const stateEl = el('span', 'code-state', 'connecting');
  const errEl = Object.assign(el('button', 'code-errs-btn'), { type: 'button', title: 'show the syntax errors', hidden: true });
  const saveBtn = Object.assign(el('button', 'code-btn', 'save'), { type: 'button', title: 'save to the share now' });
  const isMd = lang.hl === 'markdown';
  const viewBtn = Object.assign(el('button', 'code-btn'), { type: 'button', hidden: !isMd });
  const shareBtn = Object.assign(el('button', 'code-btn', 'share'), { type: 'button', title: 'invite someone to work on it with you' });
  bar.append(pathEl, el('span', 'code-lang', lang.hl), whoEl, errEl, stateEl, viewBtn, shareBtn, saveBtn);

  const scroller = el('div', 'code-ed');
  const gutter = el('div', 'code-gutter');
  const nums = el('pre', 'code-nums');
  gutter.append(nums);
  const body = el('div', 'code-body');
  const pre = el('pre', 'code-hl');
  const code = el('code', `hljs language-${lang.hl}`);
  pre.append(code);
  const squig = el('pre', 'code-hl code-squig');
  const ta = Object.assign(document.createElement('textarea'), { className: 'code-ta', spellcheck: false, autocomplete: 'off', wrap: 'off' });
  ta.setAttribute('autocapitalize', 'off');
  ta.setAttribute('aria-label', file.label);
  body.append(pre, squig, ta);
  scroller.append(gutter, body);

  const out = el('div', 'code-out');
  out.hidden = true;
  const outHead = el('div', 'code-out-head');
  const outTitle = el('span', 'code-out-title');
  const outClose = Object.assign(el('button', 'code-btn', '×'), { type: 'button', title: 'hide errors' });
  outHead.append(outTitle, outClose);
  const outList = el('div', 'code-out-text');
  out.append(outHead, outList);
  // markdown rendered, each block its source again on a double click
  const mdView = Object.assign(el('div', 'code-md'), { hidden: true, tabIndex: -1 });
  view.append(bar, scroller, mdView, out);

  // the session: the server's text and version, the edit in flight to it
  let S = '';
  let V = 0;
  let saved = -1;
  // the text as last saved, when this tab knows it, so an undo back to it is clean
  let savedText = null;
  let perms = '';
  let ready = false;
  let inflight = null;
  let wantSave = false;
  let sock = null;
  let closed = false;
  let retry = 1000;
  let people = [];
  // this tab's own id in the session, its own caret never drawn
  let me = 0;
  let opSeq = 0;
  const canWrite = () => perms.includes('w');
  const say = (body) => sock && sock.readyState === WebSocket.OPEN && sock.send(JSON.stringify(body));

  // --- drawing ---
  let drawFrame = 0;
  let hlText = null;
  const HL_MAX = 200 * 1024;
  function draw() {
    drawFrame = 0;
    const text = ta.value;
    // a tab shown again with the same text: its highlight kept
    if (text === hlText) { paintMarks(); return; }
    hlText = text;
    const parser = text.length <= HL_MAX && parserNow(lang.check);
    if (parser) code.innerHTML = `${highlight(parser, text)}\n`;
    else {
      code.textContent = `${text}\n`;
      if (lang.check && text.length <= HL_MAX) parserFor(lang.check).then((p) => { if (p) { hlText = null; redraw(); } });
      else if (lang.hl !== 'plaintext' && text.length <= HL_MAX) serverHighlight(text);
    }
    const lines = text.split('\n').length;
    if (nums.dataset.n !== String(lines)) {
      nums.dataset.n = String(lines);
      nums.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }
    paintMarks();
    checkSoon();
  }
  const redraw = () => { drawFrame ||= requestAnimationFrame(draw); mdSoon(); };
  // a grammar the page has no parser for: chroma's, once typing pauses
  let hlTimer = 0;
  function serverHighlight(text) {
    clearTimeout(hlTimer);
    hlTimer = setTimeout(async () => {
      try {
        const r = await fetch('/api/md', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ highlight: lang.hl, text }) });
        const { html } = r.ok ? await r.json() : {};
        if (typeof html === 'string' && ta.value === text) code.innerHTML = `${html}\n`;
      } catch {}
    }, 150);
  }

  // --- markdown rendered: the source's blocks drawn, one edited at a time in place ---
  const MD_KEY = 'phosphorus-md-rendered';
  let rendered = false;
  let mdEditing = null;
  let mdTimer = 0;
  const mdSoon = () => { if (rendered) { clearTimeout(mdTimer); mdTimer = setTimeout(paintMd, 120); } };
  function setRendered(on) {
    rendered = isMd && on;
    scroller.hidden = rendered;
    mdView.hidden = !rendered;
    viewBtn.textContent = rendered ? 'source' : 'view';
    viewBtn.title = rendered ? 'back to the markdown source' : 'show it rendered, a block edited on a double click';
    if (isMd) try { localStorage.setItem(MD_KEY, rendered ? '1' : ''); } catch {}
    if (rendered) paintMd(); else if (mdEditing) mdEditing.box.blur();
  }
  let mdSeq = 0;
  async function paintMd() {
    if (!rendered || mdEditing) return;
    const text = ta.value;
    const seq = mdSeq += 1;
    const blocks = await mdBlocks(text);
    if (seq !== mdSeq || !rendered || mdEditing || ta.value !== text) return;
    const top = mdView.scrollTop;
    const edit = canWrite();
    mdView.replaceChildren(...blocks.map((b) => {
      const d = el('div', 'md-block');
      renderMd(d, b.raw.replace(/\n+$/, ''), false, b.html);
      if (edit) {
        d.title = 'double click to edit';
        d.addEventListener('dblclick', (e) => { if (!e.target.closest('input, a, summary')) editBlock(d, b); });
        d.querySelectorAll('li.task input').forEach((box, i) => {
          box.disabled = false;
          box.addEventListener('change', () => tickTask(b, i, box.checked));
        });
      }
      return d;
    }));
    if (!blocks.length) mdView.append(el('div', 'md-empty', 'empty'));
    if (edit) {
      const add = Object.assign(el('button', 'md-add', '+ add a block'), { type: 'button' });
      add.addEventListener('click', () => {
        const t = ta.value;
        const gap = !t || t.endsWith('\n\n') ? '' : t.endsWith('\n') ? '\n' : '\n\n';
        editBlock(add, { from: t.length, raw: '', gap });
      });
      mdView.append(add);
    }
    mdView.scrollTop = top;
  }
  // a task's [ ] or [x] flipped in the source, its block found again if it moved
  function tickTask(b, i, on) {
    const marks = [...b.raw.matchAll(/^[ \t>]*(?:[-*+]|\d+[.)])[ \t]+\[([ xX])\]/gm)];
    const now = ta.value;
    const from = now.slice(b.from, b.from + b.raw.length) === b.raw ? b.from : now.indexOf(b.raw);
    if (!marks[i] || from < 0) { paintMd(); return; }
    const at = from + marks[i].index + marks[i][0].length - 2;
    ta.setRangeText(on ? 'x' : ' ', at, at + 1);
    ta.dispatchEvent(new Event('input'));
  }
  function editBlock(d, b) {
    if (mdEditing) return;
    const src = b.raw.replace(/\n+$/, '');
    const tail = b.raw.slice(src.length) || (b.raw ? '' : '\n');
    const box = Object.assign(document.createElement('textarea'), { className: 'md-edit', value: src, spellcheck: true });
    const grow = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };
    d.replaceWith(box);
    mdEditing = { box };
    grow();
    box.focus();
    const done = (keep) => {
      if (mdEditing?.box !== box) return;
      mdEditing = null;
      if (keep && box.value !== src) {
        // found again if others' edits moved it meanwhile
        const now = ta.value;
        const from = now.slice(b.from, b.from + b.raw.length) === b.raw ? b.from : b.raw ? now.indexOf(b.raw) : now.length;
        if (from < 0) paintState('that block changed under you, your edit was not kept');
        else {
          const put = box.value.trim() ? `${b.gap || ''}${box.value.replace(/\n+$/, '')}${tail}` : '';
          ta.setRangeText(put, from, from + b.raw.length, 'end');
          ta.dispatchEvent(new Event('input'));
        }
      }
      paintMd();
    };
    box.addEventListener('input', grow);
    box.addEventListener('blur', () => done(true));
    box.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); mdView.focus(); }
      else if (mod && e.key === 'Enter') { e.preventDefault(); done(true); mdView.focus(); }
      // a tab character typed in, focus staying in the block
      else if (e.key === 'Tab' && !mod && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        if (!document.execCommand('insertText', false, '\t')) {
          box.setRangeText('\t', box.selectionStart, box.selectionEnd, 'end');
          grow();
        }
      }
    });
  }
  viewBtn.addEventListener('click', () => setRendered(!rendered));

  // --- syntax errors: a squiggle under each, a mark in the gutter, a list to jump from ---
  let errs = [];
  let checkTimer = 0;
  const checkSoon = () => { clearTimeout(checkTimer); checkTimer = setTimeout(check, 300); };
  async function check() {
    const parser = lang.check && ta.value.length <= HL_MAX && await parserFor(lang.check);
    const text = ta.value;
    errs = parser ? syntaxErrors(parser, text) : [];
    const esc = (t) => t.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    let html = '';
    let at = 0;
    for (const e of errs) {
      const to = Math.max(e.to, Math.min(e.from + 1, text.length));
      if (e.from < at) continue;
      const bit = text.slice(e.from, to).replace(/\n/g, ' \n');
      html += `${esc(text.slice(at, e.from))}<mark>${esc(bit) || ' '}</mark>`;
      at = to;
    }
    squig.innerHTML = `${html}${esc(text.slice(at))}\n`;
    const lineOf = (p) => text.slice(0, p).split('\n').length;
    errEl.hidden = !errs.length;
    errEl.textContent = `${errs.length}${errs.length >= ERR_MAX ? '+' : ''} error${errs.length === 1 ? '' : 's'}`;
    outTitle.textContent = errEl.textContent;
    outList.replaceChildren(...errs.map((e) => {
      const row = Object.assign(el('button', 'code-err-row'), { type: 'button' });
      row.append(el('span', 'code-out-dim', `line ${lineOf(e.from)}`), el('span', 'code-out-err', e.what));
      row.addEventListener('click', () => { ta.focus(); ta.setSelectionRange(e.from, e.from); caretInView(); });
      return row;
    }));
    if (!errs.length) out.hidden = true;
    paintMarks();
  }

  // the others' carets as marks in the gutter, their colour, their name on hover
  function paintMarks() {
    for (const m of gutter.querySelectorAll('.code-mark')) m.remove();
    const lh = parseFloat(getComputedStyle(nums).lineHeight) || 18;
    const padTop = parseFloat(getComputedStyle(nums).paddingTop) || 0;
    for (const line of new Set(errs.map((e) => ta.value.slice(0, Math.min(e.from, ta.value.length)).split('\n').length - 1))) {
      const mk = Object.assign(el('div', 'code-mark code-mark-err'), { title: 'syntax error' });
      mk.style.top = `${padTop + line * lh}px`;
      mk.style.height = `${lh}px`;
      gutter.append(mk);
    }
    for (const c of body.querySelectorAll('.code-caret')) c.remove();
    const cs = getComputedStyle(ta);
    const cw = chWidthIn(ta);
    for (const p of people) {
      if (me ? p.id === me : p.name === name) continue;
      const before = ta.value.slice(0, Math.min(p.pos, ta.value.length));
      const line = before.split('\n').length - 1;
      const col = [...before.slice(before.lastIndexOf('\n') + 1)].reduce((n, ch) => (ch === '\t' ? n + 4 - (n % 4) : n + 1), 0);
      const tint = p.color || colorFor(p.name);
      const mk = Object.assign(el('div', p.agent ? 'code-mark agent' : 'code-mark'), { title: p.name });
      mk.style.top = `${padTop + line * lh}px`;
      mk.style.height = `${lh}px`;
      if (!p.agent) mk.style.background = tint;
      gutter.append(mk);
      // their caret in the text, their name over it
      const caret = el('div', p.agent ? 'code-caret agent' : 'code-caret');
      caret.style.cssText = `top:${parseFloat(cs.paddingTop) + line * lh}px;left:${parseFloat(cs.paddingLeft) + col * cw}px;height:${lh}px;--who:${tint}`;
      const flag = caret.appendChild(el('span', 'code-caret-name', p.agent ? '' : p.name));
      if (p.agent) flag.append(el('span', 'who-model', p.name));
      body.append(caret);
    }
  }

  const dirty = () => ready && !(saved < 0 && !ta.value) && (savedText === null || !!inflight || ta.value !== S || S !== savedText);
  function paintState(note) {
    const d = dirty();
    btn.classList.toggle('dirty', d);
    btn.querySelector('.tab-label').textContent = `${codeName(file)}${d ? ' •' : ''}`;
    stateEl.textContent = note || (!ready ? 'connecting' : !canWrite() ? 'read-only' : saved < 0 && !ta.value ? 'new file' : d ? 'saving' : 'saved');
    stateEl.classList.toggle('bad', !!note);
    saveBtn.disabled = !ready || !canWrite();
    ta.readOnly = !ready || !canWrite();
    const others = people.filter((p) => p.name !== name);
    whoEl.replaceChildren(...others.map((p) => {
      const s = el('span', p.agent ? 'who who-model' : 'who', p.name);
      if (!p.agent) s.style.color = p.color || colorFor(p.name);
      return s;
    }));
    whoEl.hidden = !others.length;
  }

  // the caret kept in view as it moves, the scroller being the editor, not the box
  function caretInView() {
    const before = ta.value.slice(0, ta.selectionEnd);
    const line = before.split('\n').length - 1;
    const col = before.length - before.lastIndexOf('\n') - 1;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight) || 18;
    const cw = chWidthIn(ta);
    const y = parseFloat(cs.paddingTop) + line * lh;
    const x = gutter.offsetWidth + parseFloat(cs.paddingLeft) + col * cw;
    if (y < scroller.scrollTop) scroller.scrollTop = y;
    else if (y + lh > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + lh - scroller.clientHeight + 4;
    if (x < scroller.scrollLeft + gutter.offsetWidth) scroller.scrollLeft = Math.max(0, x - gutter.offsetWidth - cw * 4);
    else if (x > scroller.scrollLeft + scroller.clientWidth - cw * 2) scroller.scrollLeft = x - scroller.clientWidth + cw * 4;
  }

  // --- the session ---
  function flush() {
    if (inflight || !ready || !canWrite() || ta.value === S) return;
    inflight = { id: `${id}-${opSeq += 1}`, ops: opDiff(S, ta.value) };
    say({ type: 'op', base: V, ops: inflight.ops, id: inflight.id });
  }

  function setText(text, keepSel) {
    const [s0, s1] = [ta.selectionStart, ta.selectionEnd];
    ta.value = text;
    if (keepSel) ta.setSelectionRange(Math.min(s0, text.length), Math.min(s1, text.length));
    redraw();
  }

  function remote(ops) {
    const C = ta.value;
    const P = inflight ? opApply(S, inflight.ops) : S;
    let r = ops;
    if (inflight) [inflight.ops, r] = opTransform(inflight.ops, r);
    const [, r2] = opTransform(opDiff(P, C), r);
    const [s0, s1] = [ta.selectionStart, ta.selectionEnd];
    const top = scroller.scrollTop;
    ta.value = opApply(C, r2);
    ta.setSelectionRange(opMap(r2, s0), opMap(r2, s1));
    scroller.scrollTop = top;
    redraw();
  }

  let refused = '';
  function connect() {
    if (closed) return;
    const q = new URLSearchParams({ share: file.share, path: file.path });
    sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/code/${encodeURIComponent(file.host)}?${q}`);
    // the chat's name, else the user this desktop logged into the host as
    const who = name || dk.creds.get(file.host)?.user || 'anon';
    sock.onopen = () => { retry = 1000; say({ type: 'join', name: who, color: color || colorFor(who) }); };
    sock.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'init' || msg.type === 'resync') {
        const lost = ready && ta.value !== S && ta.value !== msg.text;
        S = msg.text;
        V = msg.v;
        saved = msg.saved;
        savedText = saved >= 0 && saved === V ? S : null;
        if (msg.perms !== undefined) perms = msg.perms;
        if (msg.people) people = msg.people;
        if (msg.you) me = msg.you;
        inflight = null;
        ready = true;
        setText(S, true);
        paintState(lost ? 'out of step, your last edit was dropped' : '');
        if (msg.type === 'init' && !view.dataset.seen) { view.dataset.seen = '1'; ta.setSelectionRange(0, 0); }
      } else if (msg.type === 'op') {
        if (inflight && msg.id === inflight.id) {
          S = opApply(S, msg.ops);
          V = msg.v;
          inflight = null;
          flush();
        } else {
          remote(msg.ops);
          S = opApply(S, msg.ops);
          V = msg.v;
        }
        if (wantSave && !inflight && ta.value === S) { wantSave = false; say({ type: 'save' }); }
        paintState();
      } else if (msg.type === 'saved') {
        saved = msg.v;
        if (saved === V) savedText = S;
        paintState();
      } else if (msg.type === 'people') {
        people = Array.isArray(msg.people) ? msg.people : [];
        paintState();
        paintMarks();
      } else if (msg.type === 'error') {
        refused = msg.error;
        paintState(msg.error);
      }
    };
    sock.onclose = () => {
      ready = false;
      inflight = null;
      if (closed) return;
      // the host said why: said once, never retried
      if (refused) { paintState(refused); return; }
      paintState('reconnecting');
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 10000);
    };
  }

  // --- editing ---
  const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
  const CLOSERS = new Set([')', ']', '}']);
  function unit() {
    const t = ta.value;
    if (/^\t/m.test(t) && !/^ {2}/m.test(t)) return '\t';
    if (lang.hl === 'python') return '    ';
    const m = t.slice(0, 20000).match(/^( +)\S/gm) || [];
    const w = Math.min(...m.map((s) => s.length - 1).filter((n) => n > 0), 8);
    return ' '.repeat(Number.isFinite(w) && w <= 8 && w > 0 ? (w >= 4 ? 4 : w) : 2);
  }
  // typed in through the browser's own edit, so ctrl+z undoes it
  function typeIn(from, to, text, selFrom, selTo) {
    ta.setSelectionRange(from, to);
    const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete');
    if (!ok) { ta.setRangeText(text, from, to, 'end'); ta.dispatchEvent(new Event('input')); }
    if (selFrom !== undefined) ta.setSelectionRange(selFrom, selTo ?? selFrom);
  }
  const lineStart = (p) => ta.value.lastIndexOf('\n', p - 1) + 1;
  const lineEnd = (p) => { const e = ta.value.indexOf('\n', p); return e < 0 ? ta.value.length : e; };

  function shiftLines(out) {
    const u = unit();
    const a = lineStart(ta.selectionStart);
    const b = lineEnd(ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && ta.value[ta.selectionEnd - 1] === '\n' ? 1 : 0));
    const lines = ta.value.slice(a, b).split('\n');
    const n = u === '\t' ? 4 : u.length;
    const next = lines.map((l) => (out
      ? (l.startsWith('\t') ? l.slice(1) : l.replace(new RegExp(`^ {1,${n}}`), ''))
      : (l ? u + l : l))).join('\n');
    typeIn(a, b, next, a, a + next.length);
  }

  function toggleComment() {
    if (!lang.comment) return;
    const c = lang.comment;
    const a = lineStart(ta.selectionStart);
    const b = lineEnd(ta.selectionEnd);
    const lines = ta.value.slice(a, b).split('\n');
    const on = lines.filter((l) => l.trim()).every((l) => l.trimStart().startsWith(c));
    const next = lines.map((l) => {
      if (!l.trim()) return l;
      if (on) return l.replace(new RegExp(`^(\\s*)${c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} ?`), '$1');
      const ind = l.match(/^\s*/)[0];
      return `${ind}${c} ${l.slice(ind.length)}`;
    }).join('\n');
    typeIn(a, b, next, a, a + next.length);
  }

  // ctrl+s the file's save, never the browser's save page
  view.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); save(); }
  });

  ta.addEventListener('keydown', (e) => {
    const s = ta.selectionStart;
    const t = ta.selectionEnd;
    const v = ta.value;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') { e.preventDefault(); ta.blur(); return; }
    if (mod && e.key === '/') { e.preventDefault(); toggleComment(); return; }
    if (ta.readOnly || mod || e.altKey) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      if (e.shiftKey || v.slice(s, t).includes('\n')) shiftLines(e.shiftKey);
      else typeIn(s, t, unit());
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const ls = lineStart(s);
      const ind = v.slice(ls, s).match(/^[ \t]*/)[0];
      const before = v.slice(ls, s).trimEnd();
      const opens = /[{[(]$/.test(before) || (lang.hl === 'python' && before.endsWith(':'));
      const u = unit();
      if (opens && CLOSERS.has(v[t])) {
        typeIn(s, t, `\n${ind}${u}\n${ind}`, s + 1 + ind.length + u.length);
      } else typeIn(s, t, `\n${ind}${opens ? u : ''}`);
      return;
    }
    if (e.key === 'Backspace' && s === t && s > 0) {
      if (PAIRS[v[s - 1]] && PAIRS[v[s - 1]] === v[s]) { e.preventDefault(); typeIn(s - 1, s + 1, ''); return; }
      const ls = lineStart(s);
      const u = unit();
      if (u !== '\t' && /^ +$/.test(v.slice(ls, s))) {
        e.preventDefault();
        const n = (s - ls) % u.length || u.length;
        typeIn(s - n, s, '');
      }
      return;
    }
    if (e.key.length !== 1) return;
    // a closer already there stepped over
    if ((CLOSERS.has(e.key) || `"'\``.includes(e.key)) && s === t && v[s] === e.key) {
      e.preventDefault();
      ta.setSelectionRange(s + 1, s + 1);
      return;
    }
    if (PAIRS[e.key]) {
      const quote = `"'\``.includes(e.key);
      if (s !== t) { e.preventDefault(); typeIn(s, t, `${e.key}${v.slice(s, t)}${PAIRS[e.key]}`, s + 1, t + 1); return; }
      const next = v[s] || '';
      const prev = v[s - 1] || '';
      const free = !next || /\s/.test(next) || CLOSERS.has(next) || next === ',' || next === ';';
      if (free && (!quote || !/[\w"'`]/.test(prev))) { e.preventDefault(); typeIn(s, t, `${e.key}${PAIRS[e.key]}`, s + 1); }
    }
  });

  let cursorTimer = 0;
  const sendCursor = () => {
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => say({ type: 'cursor', pos: ta.selectionStart }), 250);
  };
  ta.addEventListener('input', () => { redraw(); flush(); paintState(); caretInView(); sendCursor(); });
  for (const ev of ['keyup', 'click', 'select']) ta.addEventListener(ev, () => { caretInView(); sendCursor(); });

  function save() {
    if (!ready || !canWrite()) return;
    if (inflight || ta.value !== S) { wantSave = true; flush(); return; }
    say({ type: 'save' });
  }

  errEl.addEventListener('click', () => { out.hidden = !out.hidden; });
  saveBtn.addEventListener('click', save);
  shareBtn.addEventListener('click', () => shareMenu(shareBtn, file, (said) => {
    stateEl.textContent = said;
    setTimeout(() => paintState(), 3000);
  }));
  if (isMd) { let on = false; try { on = localStorage.getItem(MD_KEY) === '1'; } catch {} setRendered(on); }
  outClose.addEventListener('click', () => { out.hidden = true; });
  // the gutter scrolled with the text, kept at the left edge
  scroller.addEventListener('click', (e) => { if (e.target === scroller || e.target === body) ta.focus(); });

  // a close with unsaved edits held once: the label says so, a second close goes
  let armed = 0;
  function holdClose() {
    if (!dirty() || armed) return false;
    btn.querySelector('.tab-label').textContent = `${codeName(file)} unsaved, close again`;
    armed = setTimeout(() => { armed = 0; paintState(); }, 3000);
    return true;
  }

  connect();
  redraw();
  paintState();
  return {
    file,
    dirty,
    save,
    holdClose,
    focus: () => ta.focus(),
    show: () => { redraw(); },
    text: () => ta.value,
    close: () => {
      closed = true;
      if (sock) sock.close();
      if (codeTabs.get(codeKey(file)) === id) codeTabs.delete(codeKey(file));
      editors.delete(id);
      if (seenEditor === id) { seenEditor = ''; paintSeen(); }
    },
  };
}

// a monospace advance, measured once per element's font
const chWidths = new Map();
function chWidthIn(node) {
  const font = getComputedStyle(node).font;
  if (chWidths.has(font)) return chWidths.get(font);
  const probe = Object.assign(document.createElement('span'), { textContent: '0'.repeat(50) });
  probe.style.cssText = `font:${font};position:absolute;visibility:hidden;white-space:pre`;
  document.body.append(probe);
  const w = probe.getBoundingClientRect().width / 50;
  probe.remove();
  if (w) chWidths.set(font, w);
  return w || 8;
}
document.fonts.addEventListener('loadingdone', () => chWidths.clear());

// the editor tabs from the last visit, back on their sessions
function loadJsonSafe(key) { try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch { return []; } }

// --- projects -----------------------------------------------------------------
// the orangutan's long projects, every host's: the list, one's live state, or a
// new one, pushed over a socket while the window is up

const pjList = document.getElementById('pj-list');
// a project's longest, as the server holds it
const PJ_MAX_HOURS = 14 * 24;
const pjHead = document.getElementById('pj-head');
const pjBody = document.getElementById('pj-body');
// a project's folder in its host's home
const pjWork = (p) => `shared/projects/${p.workspace || p.id}`;
// the workspace's files listed again at most this often, on news only
const PJ_FILES_MS = 3000;
const PJ_PHASES = ['plan', 'execute', 'test', 'refine'];
const PJ_ENDED = { done: 'done', blocked: 'blocked', expired: 'out of time', stopped: 'stopped', failed: 'failed' };
let pjAll = [];
let pjSelf = '';
// host/id, or 'new'
let pjPick = '';
let pjOne = null;
let pjSig = '';
let pjListSig = '';
let pjFiles = { key: '', at: 0, sig: '', list: [] };
let pjCmds = false;
// a stop or delete pressed once, waiting on the second press
let pjArmed = '';

const pjKey = (p) => `${p.host}/${p.id}`;
const pjFind = () => pjAll.find((p) => pjKey(p) === pjPick) || null;
const pjSpan = (ms) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const pjBar = (frac, n = 30) => {
  const k = Math.max(0, Math.min(n, Math.round(frac * n)));
  return `[<span class="pj-cells">${'█'.repeat(k)}<i>${'░'.repeat(n - k)}</i></span>]`;
};
const pjState = (p) => (p.status === 'running' ? (p.paused ? `paused, ${p.waiting || 'its model is away'}` : p.working ? 'working' : 'between rounds')
  : PJ_ENDED[p.status] || p.status);
const pjClock = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function pjGet(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `status ${r.status}`);
  return body;
}
async function pjPost(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `status ${r.status}`);
  return out;
}

// the list as pushed or fetched, the pick settled on it
function pjTakeList(r) {
  pjSelf = r.self;
  pjAll = (r.projects || []).sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.started - a.started);
  if (!pjPick && pjAll.length) pjPick = pjKey(pjAll[0]);
  if (!pjPick && !pjAll.length) pjPick = 'new';
  pjPaintList();
}

function pjTakeOne(p) {
  if (!p || pjKey(p) !== pjPick) return;
  pjOne = p;
  pjPaintOne();
  pjLoadFiles();
}

// pushed while the window is up; a press's answer asked for at once
let pjWs = null;
let pjWsRetry = 0;
let pjTick = 0;
const pjWsOpen = () => pjWs?.readyState === WebSocket.OPEN;
const pjSendPick = (fresh) => pjWsOpen() && pjWs.send(JSON.stringify({ pick: pjPick === 'new' ? '' : pjPick, fresh }));

function pjConnect() {
  const ws = new WebSocket(`${wsBase()}/api/projects/ws`);
  pjWs = ws;
  ws.onopen = () => { pjWsRetry = 0; pjSendPick(false); };
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'list') {
      const was = pjPick;
      pjTakeList(m);
      if (pjPick !== was) pjSendPick(false);
      if (pjPick === 'new') pjPaintNew();
      else if (!pjFind() && pjPick) { pjOne = null; pjGo(pjAll.length ? pjKey(pjAll[0]) : 'new'); }
    } else if (m.type === 'one') pjTakeOne(m.project);
  };
  ws.onclose = () => {
    if (pjWs !== ws) return;
    pjWs = null;
    pjWsRetry = Math.min(10000, (pjWsRetry || 500) * 2);
    setTimeout(() => { if (deskApps.has('projects') && !pjWs) pjConnect(); }, pjWsRetry);
  };
}

async function pjPoll() {
  if (pjWsOpen()) { pjSendPick(true); return; }
  try {
    pjTakeList(await pjGet('/api/projects'));
    const p = pjFind();
    if (p) {
      pjOne = await pjGet(`/api/projects/${encodeURIComponent(p.host)}/${p.id}`).catch(() => pjOne);
      if (pjOne && pjKey(pjOne) !== pjPick) pjOne = null;
      pjPaintOne();
      pjLoadFiles();
    } else if (pjPick === 'new') pjPaintNew();
    else { pjOne = null; pjPick = pjAll.length ? pjKey(pjAll[0]) : 'new'; }
  } catch (e) {
    pjList.replaceChildren(el('div', 'cw-empty', `can't list projects: ${e.message}`));
  }
}

function pjWatch(on) {
  clearInterval(pjTick);
  pjTick = 0;
  if (!on) {
    const ws = pjWs;
    pjWs = null;
    ws?.close();
    return;
  }
  if (!pjWs) pjConnect();
  // times on screen kept current without asking anyone
  pjTick = setInterval(() => { pjPaintList(); pjPaintOne(); }, 30000);
}

function pjPaintList() {
  const sig = JSON.stringify([pjAll, pjPick, Math.floor(Date.now() / 60000)]);
  if (sig === pjListSig) return;
  pjListSig = sig;
  const head = el('div', 'cw-head');
  head.append(el('span', 'who-model', 'orangutan'));
  const add = Object.assign(el('button', 'cw-add', '+'), { type: 'button', title: 'new project (n)' });
  add.addEventListener('click', () => pjGo('new'));
  head.append(add);
  const rows = [head];
  if (!pjAll.length) rows.push(el('div', 'cw-empty', 'no projects yet'));
  for (const p of pjAll) {
    const b = Object.assign(el('button', `cw-item pj-item${pjKey(p) === pjPick ? ' on' : ''}`), { type: 'button' });
    b.dataset.pj = pjKey(p);
    const top = el('span', 'pj-item-top');
    top.append(el('span', 'cw-name', p.title), el('span', `cw-sub pj-st-${p.paused ? 'paused' : p.status}${p.working ? ' pj-working' : ''}`,
      p.paused ? 'paused' : p.status === 'running' ? `${p.progress}%` : PJ_ENDED[p.status] || p.status));
    const sub = el('span', 'pj-item-sub', `${p.host} · ${p.status === 'running' ? `${pjSpan(p.deadline - Date.now())} left` : pjClock(p.ended || p.started)}`);
    b.append(top, sub);
    b.addEventListener('click', () => pjGo(pjKey(p)));
    rows.push(b);
  }
  const focused = document.activeElement?.dataset?.pj;
  pjList.replaceChildren(...rows);
  if (focused) pjList.querySelector(`[data-pj="${CSS.escape(focused)}"]`)?.focus();
}

function pjGo(key) {
  if (key === pjPick) return;
  pjPick = key;
  pjOne = null;
  pjSig = '';
  pjArmed = '';
  pjFiles = { key: '', at: 0, sig: '', list: [] };
  pjListSig = '';
  pjPaintList();
  if (key === 'new') { pjPaintNew(); pjSendPick(false); } else { pjBody.replaceChildren(el('div', 'st-wait', 'loading')); pjPoll(); }
}

// --- one project ---

function pjPaintOne() {
  const p = pjOne;
  if (!p) return;
  const now = Date.now();
  const sig = JSON.stringify([p, pjFiles.list, pjCmds, pjArmed, Math.floor(now / 30000)]);
  if (sig === pjSig) return;
  pjSig = sig;
  pjHead.textContent = p.title;
  const live = p.status === 'running';
  const total = p.deadline - p.started;
  const used = (live ? now : p.ended || now) - p.started;
  const cycle = PJ_PHASES.map((ph) => `<span class="pj-ph${ph === p.phase && live ? ` on${p.working ? ' pj-working' : ''}` : ''}">${ph}</span>`).join('<span class="st-dim"> › </span>');
  const tasks = p.tasks.length ? p.tasks.map((t) => `<li class="${t.done ? 'done' : ''}"><span class="pj-box">${t.done ? '[x]' : '[ ]'}</span> ${esc(t.text)}</li>`).join('')
    : '<li class="st-dim">no tasks reported yet</li>';
  const events = p.events.filter((e) => pjCmds || e.kind !== 'exec').slice().reverse();
  const timeline = events.map((e) => {
    const tag = e.kind === 'report' ? (e.phase || 'report') : e.kind === 'said' ? 'orangutan' : e.kind;
    const text = e.kind === 'exec' ? `$ ${e.text}` : e.text;
    return `<li class="pj-ev pj-ev-${esc(e.kind)}"><span class="pj-ev-at">${esc(pjClock(e.at))}</span><span class="pj-ev-tag${e.kind === 'said' ? ' who-model' : ''}">${esc(tag)}</span>`
      + `<span class="pj-ev-text">${esc(text)}${e.n > 1 ? ` <span class="st-dim">×${e.n}</span>` : ''}</span></li>`;
  }).join('');
  const files = pjFiles.list.length ? pjFiles.list.map((f) => `<li><button type="button" class="pj-file" data-path="${esc(f.path)}"${f.dir ? ' disabled' : ''}>`
    + `${esc(f.path.slice(pjWork(p).length + 1))}</button></li>`).join('') : '<li class="st-dim">empty</li>';
  const row = (k, v) => `<div class="pj-row"><span class="st-key">${k}</span><span>${v}</span></div>`;
  const detail = el('div', 'pj-detail');
  detail.innerHTML = `<div class="pj-top">`
    + row('state', `<span class="pj-st-${p.paused ? 'paused' : p.status}${p.working && live ? ' pj-working' : ''}">${esc(pjState(p))}</span>${live ? ` <span class="st-dim">· round ${p.round}</span>` : ''}`)
    + row('where', `${esc(p.host)}${p.model ? ` <span class="st-dim">· ${esc(p.model)}</span>` : ''}${p.execs ? ` <span class="st-dim">· ${p.execs} commands</span>` : ''}`)
    + row('by', `${esc(p.by || 'someone')} <span class="st-dim">· ${esc(pjClock(p.started))}</span>`)
    + row('cycle', cycle)
    + row('done', `${pjBar(p.progress / 100)} ${p.progress}%`)
    + row('time', `${pjBar(total ? used / total : 1)} ${live ? `${pjSpan(p.deadline - now)} left of ${pjSpan(total)}${p.paused ? ', held while paused' : ''}` : `${pjSpan(used)} of ${pjSpan(total)}`}`)
    + (p.note ? row('now', esc(p.note)) : '')
    + `</div>`
    + (p.final ? `<div class="pj-sec"><div class="pj-sec-head">summary</div><div class="pj-final md"></div></div>` : '')
    + `<div class="pj-cols"><div class="pj-sec"><div class="pj-sec-head">tasks ${p.tasks.length ? `<span class="st-dim">${p.tasks.filter((t) => t.done).length}/${p.tasks.length}</span>` : ''}</div><ul class="pj-tasks">${tasks}</ul></div>`
    + `<div class="pj-sec"><div class="pj-sec-head">workspace <span class="st-dim">${esc(p.host)}/${esc(pjWork(p))}</span></div><ul class="pj-files">${files}</ul></div></div>`
    + `<div class="pj-sec"><div class="pj-sec-head">timeline <button type="button" class="st-clear pj-cmds">${pjCmds ? 'hide commands' : 'show commands'}</button></div><ul class="pj-events">${timeline}</ul></div>`
    + `<div class="pj-sec"><div class="pj-sec-head">brief</div><div class="pj-brief"></div></div>`;
  detail.querySelector('.pj-brief').textContent = p.brief;
  const fin = detail.querySelector('.pj-final');
  if (fin) renderMd(fin, p.final);
  const scroll = pjBody.querySelector('.pj-detail')?.scrollTop || 0;
  // the note box kept, never redrawn under a typing hand
  const had = pjBody.querySelector('.pj-acts');
  const acts = had && had.dataset.key === pjKey(p) ? had : pjActs(p);
  pjActsState(acts, p);
  const was = pjBody.querySelector('.pj-detail');
  if (was && acts === had) was.replaceWith(detail); else pjBody.replaceChildren(detail, acts);
  detail.scrollTop = scroll;
}

function pjActs(p) {
  const acts = el('form', 'pj-acts');
  acts.dataset.key = pjKey(p);
  const input = Object.assign(el('input', 'update-pass pj-note'), { type: 'text', placeholder: 'leave the orangutan a note for its next round', maxLength: 2000, autocomplete: 'off' });
  const send = Object.assign(el('button', 'primary pj-send', 'note'), { type: 'submit' });
  const stop = Object.assign(el('button', 'danger pj-stop', 'stop'), { type: 'button' });
  const del = Object.assign(el('button', 'danger pj-del', 'delete'), { type: 'button' });
  const more = Object.assign(el('button', 'pj-more', '+24h'), { type: 'button', title: 'give it another day' });
  const again = Object.assign(el('button', 'primary pj-again', 'restart'), { type: 'button', title: 'back to work in the same workspace, 72h' });
  const msg = el('span', 'pj-msg');
  const btns = el('div', 'update-actions');
  btns.append(msg, more, stop, del, again, send);
  acts.append(input, btns);
  acts.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    pjPost(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/note`, { by: name, text })
      .then(() => { input.value = ''; msg.textContent = 'noted, read next round'; pjPoll(); }, (err) => { msg.textContent = err.message; });
  });
  stop.addEventListener('click', () => pjStop());
  del.addEventListener('click', () => pjDelete());
  const call = (op, body) => pjPost(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/${op}`, { by: name, ...body }).then(pjPoll, (err) => { msg.textContent = err.message; });
  more.addEventListener('click', () => call('extend', { hours: 24 }));
  again.addEventListener('click', () => call('restart', { brief: input.value.trim() }));
  return acts;
}

function pjActsState(acts, p) {
  const live = p.status === 'running';
  acts.querySelector('.pj-note').hidden = !live;
  acts.querySelector('.pj-send').hidden = !live;
  acts.querySelector('.pj-stop').hidden = !live;
  acts.querySelector('.pj-del').hidden = live;
  acts.querySelector('.pj-more').hidden = !live;
  acts.querySelector('.pj-again').hidden = live;
  acts.querySelector('.pj-stop').textContent = pjArmed === 'stop' ? 'really stop?' : 'stop';
  acts.querySelector('.pj-del').textContent = pjArmed === 'delete' ? 'delete it and its workspace?' : 'delete';
}

// twice to confirm, the first press arming it a few seconds
function pjArm(what) {
  if (pjArmed === what) { pjArmed = ''; return true; }
  pjArmed = what;
  pjSig = '';
  pjPaintOne();
  setTimeout(() => { if (pjArmed === what) { pjArmed = ''; pjSig = ''; pjPaintOne(); } }, 4000);
  return false;
}

function pjStop() {
  const p = pjOne;
  if (!p || p.status !== 'running' || !pjArm('stop')) return;
  pjPost(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/stop`, { by: name }).then(pjPoll, (e) => pjSay(e.message));
}

function pjDelete() {
  const p = pjOne;
  if (!p || p.status === 'running' || !pjArm('delete')) return;
  pjPost(`/api/projects/${encodeURIComponent(p.host)}/${p.id}/delete`, {}).then(() => { pjPick = ''; pjOne = null; pjPoll(); }, (e) => pjSay(e.message));
}

function pjSay(text) {
  const m = pjBody.querySelector('.pj-msg');
  if (m) m.textContent = text;
}

pjBody.addEventListener('click', (e) => {
  if (e.target.closest('.pj-cmds')) { pjCmds = !pjCmds; pjSig = ''; pjPaintOne(); return; }
  const f = e.target.closest('.pj-file');
  if (f && pjOne) dkCode({ host: pjOne.host, share: 'home', path: f.dataset.path, label: `${pjOne.host}/${f.dataset.path}` });
});

// the workspace's files, again only once something happened there
function pjLoadFiles() {
  const p = pjOne;
  if (!p) return;
  const key = pjKey(p);
  const news = `${p.events.length}:${p.events.at(-1)?.at || 0}`;
  if (pjFiles.key === key && (pjFiles.sig === news || Date.now() - pjFiles.at < PJ_FILES_MS)) return;
  pjFiles = { ...pjFiles, key, at: Date.now(), sig: news };
  pjGet(`/api/files/${encodeURIComponent(p.host)}/tree?share=home&path=${encodeURIComponent(pjWork(p))}&depth=4`).then((r) => {
    if (pjFiles.key !== key) return;
    pjFiles.list = (r.entries || []).filter((x) => !/(^|\/)(\.git|node_modules|__pycache__|\.venv)(\/|$)/.test(x.path))
      .map((x) => ({ path: x.path.replace(/\/$/, ''), dir: x.path.endsWith('/') })).filter((x) => !x.dir).slice(0, 200);
    pjPaintOne();
  }, () => {});
}

// --- a new one ---

function pjPaintNew() {
  if (pjBody.querySelector('.pj-new')) return;
  pjHead.textContent = 'new project';
  const form = el('form', 'pj-new');
  // one project a host: a busy one listed, not pickable
  const busy = new Set(pjAll.filter((p) => p.status === 'running').map((p) => p.host));
  const hosts = [...new Set([pjSelf, ...phosphorusHosts()].filter(Boolean))].sort((x, y) => (y === pjSelf) - (x === pjSelf) || x.localeCompare(y));
  const first = hosts.find((h) => !busy.has(h)) || hosts[0] || '';
  form.innerHTML = '<p class="pj-intro">The <span class="who-model">orangutan</span> works on it alone in a sandbox on the host picked, in rounds of plan, execute, test and refine, '
    + 'until it says it is done or the time runs out. It reports as it goes; its files land in shared/projects on that host.</p>'
    + '<input class="update-pass pj-title" type="text" placeholder="title" maxlength="120" autocomplete="off" required>'
    + '<textarea class="update-pass pj-brief-in" rows="12" placeholder="the brief: what to make, what done looks like, any constraints" maxlength="20000" required></textarea>'
    + '<div class="pj-opts"><label class="pj-host">host <select class="update-pass">'
    + hosts.map((h) => `<option value="${esc(h)}"${busy.has(h) ? ' disabled' : ''}${h === first ? ' selected' : ''}>${esc(h)}${busy.has(h) ? ' · busy' : ''}</option>`).join('')
    + '</select></label>'
    + `<label class="pj-hours">hours <input class="update-pass" type="number" min="0.1" max="${PJ_MAX_HOURS}" step="any" value="72"></label>`
    + `<span class="pj-ends st-dim"></span></div>`
    + '<div class="update-actions"><span class="pj-msg"></span><button type="submit" class="primary" disabled>start</button></div>';
  const title = form.querySelector('.pj-title');
  const brief = form.querySelector('.pj-brief-in');
  const hours = form.querySelector('.pj-hours input');
  const host = form.querySelector('.pj-host select');
  const go = form.querySelector('button[type="submit"]');
  // the deadline it would land on, and start only with a title, a brief and a free host
  const paint = () => {
    const h = Number(hours.value);
    const ok = h > 0 && h <= PJ_MAX_HOURS;
    form.querySelector('.pj-ends').textContent = ok
      ? `up to ${PJ_MAX_HOURS}, ends ${new Date(Date.now() + h * 3600000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).toLowerCase()}`
      : `0.1 to ${PJ_MAX_HOURS} hours`;
    go.disabled = !title.value.trim() || !brief.value.trim() || !ok || !host.value || busy.has(host.value);
  };
  form.addEventListener('input', paint);
  paint();
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (go.disabled) return;
    const msg = form.querySelector('.pj-msg');
    msg.textContent = 'starting';
    pjPost('/api/projects', {
      title: title.value, brief: brief.value, hours: Number(hours.value) || 72, by: name, host: host.value,
    }).then((p) => { pjPick = pjKey(p); pjBody.replaceChildren(); pjPoll(); }, (err) => { msg.textContent = err.message; });
  });
  pjBody.replaceChildren(form);
}

// --- phosphorus's presses on this page ----------------------------------------------
// the page moved for whoever asked, as a button would: an app, a terminal, a host

function phosphorusPressed(a) {
  if (a) dkPressed(a);
}

// --- credential boxes ---------------------------------------------------------
// a model's ask_credentials: a box over the chat's own, what's typed carried
// straight to the action from here, only whether it went through told back

const chatCreds = document.getElementById('chat-creds');
// fields as [name, masked]; run: {retry} keeps the box up, {error} ends it
const CRED_ACTIONS = {
  update: {
    title: 'update the mesh',
    fields: [['password', true]],
    run: async ({ password }) => {
      const res = await chainAction('start', password);
      if (res.status === 401) return { retry: 'wrong password' };
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        return { error: `already updating, started by ${body.by || 'another host'}` };
      }
      if (!res.ok) return { error: `the update didn't start (status ${res.status})` };
      openUpdateModal();
      return {};
    },
  },
};

let credsId = '';
function credsClose(id) {
  if (!credsId || (id && id !== credsId)) return;
  credsId = '';
  chatCreds.hidden = true;
  chatCreds.replaceChildren();
}

function credsAsk(a) {
  const spec = CRED_ACTIONS[a.action];
  if (!spec || !a.id) return;
  if (credsId) send({ type: 'creds-done', id: credsId, ok: false, error: 'another box took its place' });
  credsId = a.id;
  const done = (ok, error) => { send({ type: 'creds-done', id: a.id, ok, error }); credsClose(a.id); };
  const fields = spec.fields.map(([key, masked]) => {
    const input = Object.assign(el('input', 'creds-input'), { type: 'text', placeholder: key, autocomplete: 'off', spellcheck: false });
    for (const k of ['autocapitalize', 'data-1p-ignore', 'data-lpignore', 'data-bwignore']) input.setAttribute(k, k === 'autocapitalize' ? 'off' : '');
    const unbad = () => { input.classList.remove('bad'); input.placeholder = key; };
    const field = masked ? maskField(input, unbad) : { get: () => input.value, set: (t) => { input.value = t; } };
    if (!masked) input.addEventListener('input', unbad);
    return { input, field, key };
  });
  const go = Object.assign(el('button', 'code-btn', 'enter'), { type: 'button' });
  const cancel = Object.assign(el('button', 'code-btn', 'cancel'), { type: 'button' });
  async function submit() {
    const empty = fields.find((f) => !f.field.get());
    if (empty) { empty.input.focus(); return; }
    go.disabled = true;
    let out;
    try { out = await spec.run(Object.fromEntries(fields.map((f) => [f.key, f.field.get()]))); } catch { out = { error: 'this host could not be reached' }; }
    go.disabled = false;
    if (!out.retry) { done(!out.error, out.error); return; }
    const f = fields.at(-1);
    f.field.set('');
    f.input.placeholder = out.retry;
    f.input.classList.add('bad');
    f.input.focus();
  }
  fields.forEach((f, i) => f.input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); done(false, 'they cancelled'); chatText.focus(); }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (fields[i + 1]) fields[i + 1].input.focus(); else submit();
  }));
  go.addEventListener('click', submit);
  cancel.addEventListener('click', () => { done(false, 'they cancelled'); chatText.focus(); });
  const head = el('div', 'creds-head');
  head.append(el('span', 'creds-title', spec.title), el('span', 'creds-why', a.why || 'asked by the model, never shown to it'));
  const acts = el('div', 'creds-acts');
  acts.append(cancel, go);
  chatCreds.replaceChildren(head, ...fields.map((f) => f.input), acts);
  chatCreds.hidden = false;
  fields[0].input.focus();
}

// --- mesh update ----------------------------------------------------------

// one chain at a time, mesh-wide, its state on the host that started it,
// this pane only ever talking to its own frontend

const updateBtn = document.getElementById('mesh-update');
const updateModal = document.getElementById('update-modal');
const updateTitle = document.getElementById('update-title');
const updateConfirm = document.getElementById('update-confirm');
const updateConfirmText = document.getElementById('update-confirm-text');
const updateConfirmCancel = document.getElementById('update-confirm-cancel');
const updateConfirmGo = document.getElementById('update-confirm-go');
const updatePass = document.getElementById('update-pass');
const updateFoot = document.getElementById('update-foot');
const updateContinue = document.getElementById('update-continue');
const updateProgress = document.getElementById('update-progress');
const updateProgressCells = document.getElementById('update-progress-cells');
const updateProgressLabel = document.getElementById('update-progress-label');

const updateMesh = document.getElementById('update-mesh');
const updateStart = document.getElementById('update-start');
const updateVersions = document.getElementById('update-versions');

// meshLock: whatever chain this host can see, own, or a peer's via the mesh poll
let meshLock = null;
// what the list draws from: the last poll's hosts, and a chain while one runs
let updateSeen = { tailnet: [], selfVersion: '' };
let updateChain = null;
let paneOpenedFor = '';

// the initiator's own swap taking its walk offline a while, the last view held
const CHAIN_HOLD_MS = 180000;
let heldChain = null;
function holdChain(chain) {
  if (chain) {
    heldChain = chain.done ? null : { chain, at: Date.now() };
    return chain;
  }
  if (heldChain && Date.now() - heldChain.at < CHAIN_HOLD_MS) return heldChain.chain;
  heldChain = null;
  return null;
}

const UPDATE_LABEL = {
  pending: 'waiting', running: 'updating', ok: 'success', current: 'up to date',
  fail: 'failed', unreachable: 'unreachable', skipped: 'skipped',
};

// a failure's short cause, when the chain named one
const stepLabel = (chain, host, step) => (!step ? ''
  : ((step === 'fail' || step === 'unreachable' || step === 'skipped') && chain.errors && chain.errors[host]) || UPDATE_LABEL[step] || step);

// nothing new while a chain is in flight, its own continue and cancel above
function renderUpdateButton() {
  updateBtn.disabled = !!meshLock;
  updateBtn.textContent = !meshLock ? 'update' : meshLock.paused ? 'paused' : 'updating';
  updateBtn.title = meshLock ? `started by ${meshLock.initiator}` : 'update every host on the mesh, one at a time';
}

// every phosphorus host and the version it answered with, ours from
// /api/state itself, while a chain runs, in its order, each with its step
function renderVersions() {
  const { tailnet, selfVersion } = updateSeen;
  // one that answered before listed too, as not answering, ours always,
  // even before this host is in its own tailnet view
  const names = tailnet.filter((d) => d.phosphorus || d.phosphorusSeen).map((d) => d.name);
  if (selfHost && !names.includes(selfHost)) names.push(selfHost);
  const order = updateChain ? [...updateChain.order, ...names.filter((n) => !updateChain.order.includes(n))] : names;
  const isQuiet = (host) => {
    const d = tailnet.find((x) => x.name === host);
    return host !== selfHost && !!d && !!d.phosphorusSeen && !d.phosphorus;
  };
  const rows = order.map((host) => {
    const d = tailnet.find((x) => x.name === host) || {};
    const quiet = isQuiet(host);
    const version = host === selfHost ? selfVersion : d.version || '';
    const step = updateChain ? updateChain.results[host] || (updateChain.order.includes(host) ? 'pending' : '') : '';
    const li = document.createElement('li');
    li.className = `update-row${step ? ` ${step}` : ''}${quiet ? ' unreachable' : ''}${!updateChain && version && selfVersion && version !== selfVersion ? ' differs' : ''}`;
    const name = document.createElement('span');
    name.className = 'update-host';
    name.textContent = host;
    name.classList.toggle('is-self', host === selfHost);
    const os = d.os || hostPlatform.get(host);
    if (os) name.appendChild(Object.assign(document.createElement('span'), { className: 'update-os', textContent: os }));
    li.append(name,
      Object.assign(document.createElement('span'), { className: 'update-ver', textContent: version ? `v${version}` : '?' }),
      Object.assign(document.createElement('span'), { className: 'update-state', textContent: stepLabel(updateChain, host, step) || (quiet ? 'not answering' : '') }));
    return li;
  });
  if (!rows.length) rows.push(Object.assign(document.createElement('li'), { className: 'empty', textContent: 'no hosts in view' }));
  // column heads in the rows' own grid, so they line up with them
  const head = document.createElement('li');
  head.className = 'update-row update-head';
  const stateHead = updateChain || order.some(isQuiet) ? 'status' : '';
  for (const [cls, text] of [['update-host', 'host'], ['update-ver', 'version'], ['update-state', stateHead]]) {
    head.appendChild(Object.assign(document.createElement('span'), { className: cls, textContent: text }));
  }
  rows.unshift(head);
  const sig = rows.map((li) => `${li.className}|${li.textContent}|${li.querySelector('.is-self') ? 1 : 0}`).join('\n');
  if (sig === updateVersions.dataset.sig) return;
  updateVersions.dataset.sig = sig;
  updateVersions.replaceChildren(...rows);
}

// cells that fit the track, so the bar spans the pane at any width
function updateCells() {
  const probe = document.createElement('span');
  probe.textContent = '█'.repeat(10);
  updateProgressCells.replaceChildren(probe);
  return Math.max(1, Math.floor(updateProgressCells.clientWidth / (probe.getBoundingClientRect().width / 10)));
}

let progressStatus = null;

// one step per host, half done mid-rebuild so the bar still creeps
function renderProgress(status) {
  progressStatus = status;
  const total = status.order.length;
  if (!total) { updateProgress.hidden = true; return; }
  let done = 0;
  for (const host of status.order) {
    const state = status.results[host] || 'pending';
    if (state === 'running') done += 0.5;
    else if (state !== 'pending') done += 1;
  }
  // block cells, as the files transfer bar
  updateProgress.hidden = false;
  const cells = updateCells();
  const full = Math.round((done / total) * cells);
  updateProgressCells.replaceChildren('█'.repeat(full), Object.assign(document.createElement('i'), { textContent: '░'.repeat(cells - full) }));
  updateProgressLabel.textContent = `${Math.floor(done)}/${total} hosts`;
}
new ResizeObserver(() => { if (progressStatus && !updateProgress.hidden) renderProgress(progressStatus); }).observe(updateProgressCells);

// the version list as the walk while one runs, its results kept while the
// server still has them: each host's step, and why one failed
function applyChain(status, mine) {
  updateChain = status || null;
  const live = status && !status.done ? status : null;
  updateProgress.hidden = !live;
  if (live) renderProgress(live);
  updateStart.hidden = !!live;
  updateFoot.hidden = !live || !mine;
  updateContinue.hidden = !live || !live.paused;
  const clean = status && status.order.every((m) => ['ok', 'current'].includes(status.results[m]));
  updateTitle.textContent = live ? (live.paused ? 'mesh update paused' : 'updating the mesh')
    : status ? (clean ? 'mesh update done' : 'mesh update ended') : 'mesh update';
  renderVersions();
}

function openUpdateModal() {
  if (!acct?.admin) return;
  updateConfirm.hidden = true;
  updateMesh.hidden = false;
  updateModal.hidden = false;
  pollState();
}

function closeUpdateModal() {
  // the chain outliving the pane, nothing decided by closing it
  if (updateModal.contains(document.activeElement)) topUpdate.focus();
  updateModal.hidden = true;
}

// one/two-button prompt inside the pane itself instead of confirm()/alert(),
// those outside the page, unstyleable, and flagged by some hosts
function openConfirm(message, { title, hideCancel, actionLabel, onAction, password }) {
  updateModal.hidden = false;
  updateTitle.textContent = title;
  updateConfirmText.textContent = message;
  updateConfirmCancel.hidden = !!hideCancel;
  updateConfirmGo.textContent = actionLabel;
  updateConfirmGo.onclick = onAction;
  updateConfirm.hidden = false;
  updatePass.hidden = !password;
  setPass('');
  updatePass.classList.remove('bad');
  updatePass.placeholder = 'password';
  updateMesh.hidden = true;
  updateProgress.hidden = true;
  if (password) updatePass.focus();
}

// a chain start taking the mesh down a while, the password held by the
// frontend, only what was typed carried by this box
// the release feed first, the walk only with a host behind it
async function askToStart() {
  updateBtn.disabled = true;
  updateBtn.textContent = 'checking';
  let c = {};
  try {
    const r = await fetch('/api/update/check?fresh=1');
    c = r.ok ? await r.json() : { error: `${r.status} ${(await r.text()).slice(0, 80)}`.trim() };
  } catch (err) { c = { error: err.message }; }
  renderUpdateButton();
  const versions = [updateSeen.selfVersion, ...updateSeen.tailnet.filter((d) => d.phosphorus).map((d) => d.version)]
    .filter(Boolean);
  const behind = c.latest ? versions.filter((v) => newerVersion(c.latest, v)).length : 0;
  if (!c.latest) {
    openConfirm(`couldn't reach the release feed${c.error ? ` (${c.error})` : ''}. update anyway?`, {
      title: 'update the mesh', actionLabel: 'update',
      onAction: () => startChain(),
    });
    return;
  }
  if (!behind) {
    openConfirm(`every host is on v${c.latest}, the newest release.`, {
      title: 'up to date', hideCancel: true, actionLabel: 'ok', onAction: openUpdateModal,
    });
    return;
  }
  openConfirm(`v${c.latest} is out, ${behind} host${behind === 1 ? '' : 's'} behind. network down for a while. continue?`, {
    title: 'update the mesh', actionLabel: 'update',
    onAction: () => startChain(),
  });
}

function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

function passwordRejected() {
  setPass('');
  updatePass.placeholder = 'wrong password';
  updatePass.classList.add('bad');
  updatePass.focus();
}

// masked here, not by the browser: only bullets in the field, so no password
// manager takes it for a password and offers to save it
function maskField(input, onEdit) {
  let text = '';
  const set = (t, caret = t.length) => {
    text = t;
    input.value = '•'.repeat(t.length);
    if (document.activeElement === input) input.setSelectionRange(caret, caret);
  };
  input.addEventListener('beforeinput', (e) => {
    // IME composition can't be cancelled, left to the input handler
    if (e.inputType === 'insertCompositionText') return;
    e.preventDefault();
    let start = input.selectionStart;
    let end = input.selectionEnd;
    let ins = '';
    if (e.inputType.startsWith('insert')) {
      ins = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    } else if (start === end) {
      if (e.inputType.includes('Backward')) start = e.inputType === 'deleteContentBackward' ? Math.max(0, start - 1) : 0;
      else end = e.inputType === 'deleteContentForward' ? end + 1 : text.length;
    }
    ins = ins.replace(/[\r\n]/g, '');
    set(text.slice(0, start) + ins + text.slice(end), start + ins.length);
    onEdit?.();
  });
  // a composition's committed text, re-masked
  input.addEventListener('input', (e) => {
    if (e.inputType !== 'insertCompositionText' || e.isComposing) return;
    const typed = input.value.replace(/•/g, '');
    const at = input.value.indexOf(typed);
    set(text.slice(0, at) + typed + text.slice(at), at + typed.length);
  });
  return { get: () => text, set };
}
const updatePassField = maskField(updatePass, () => {
  updatePass.classList.remove('bad');
  updatePass.placeholder = 'password';
});
const setPass = updatePassField.set;

// enter, the obvious key in a password box
updatePass.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  updateConfirmGo.click();
});

function showLockedInfo(by) {
  openConfirm(`already updating, started by ${by}.`, {
    title: 'update the mesh',
    hideCancel: true,
    actionLabel: 'ok',
    onAction: closeUpdateModal,
  });
}

// start / cancel / continue, all one endpoint on this host's own frontend
function chainAction(action, password) {
  const sent = fetch('/api/update/chain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(password === undefined ? { action } : { action, password }),
  });
  sent.then(pollState, pollState);
  return sent;
}

async function startChain(password) {
  const res = await chainAction('start', password);
  if (res.status === 401) { passwordRejected(); return; }
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    showLockedInfo(body.by || 'another host');
    return;
  }
  openUpdateModal();
}

updateBtn.addEventListener('click', askToStart);
// a popup under its icon, as the theme's, a second tap to close; the side
// column never touched
const toggleUpdatePane = () => {
  if (!updateModal.hidden) { closeUpdateModal(); return; }
  closeMenus();
  openUpdateModal();
};
topUpdate.addEventListener('click', toggleUpdatePane);
document.getElementById('update-close').addEventListener('click', closeUpdateModal);
// closed by a click outside it, never by the one that opened it
const updateWrap = topUpdate.parentElement;
let updateWasOpen = false;
document.addEventListener('pointerdown', () => { updateWasOpen = !updateModal.hidden; }, true);
document.addEventListener('click', (e) => {
  if (updateWasOpen && !updateModal.hidden && !updateWrap.contains(e.target) && !e.target.closest?.('.modal, .keybar')) closeUpdateModal();
});

new MutationObserver(() => topUpdate.setAttribute('aria-expanded', String(!updateModal.hidden))).observe(updateModal, { attributes: true, attributeFilter: ['hidden'] });

// back to the host list, not out of the pane
updateConfirmCancel.addEventListener('click', openUpdateModal);

document.getElementById('update-cancel').addEventListener('click', () => {
  chainAction('cancel').then(pollState);
});

updateContinue.addEventListener('click', () => {
  updateContinue.hidden = true;
  chainAction('continue').then(pollState);
});

// cap on one read, so a hung fetch can't stall a caller for good
const POLL_GIVEUP_MS = 5000;

// one read, right after the user's own action, the socket carrying the rest
async function pollState() {
  try {
    applyState(await fetch('/api/state', { signal: AbortSignal.timeout(POLL_GIVEUP_MS) }).then((r) => r.json()));
  } catch {
    // left to the next push
  }
}

// the server's push, each change as it lands, reopened after a drop, at once
// for a host switch or a tab coming back
let stateWs = null;
let stateRetry = null;
let stateRetryMs = 300;

function connectState() {
  clearTimeout(stateRetry);
  const old = stateWs;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const sock = new WebSocket(`${proto}//${location.host}/api/state`);
  stateWs = sock;
  old?.close();
  sock.onopen = () => { stateRetryMs = 300; };
  sock.onmessage = (ev) => {
    let state;
    try { state = JSON.parse(ev.data); } catch { return; }
    applyState(state);
  };
  sock.onclose = () => {
    if (stateWs !== sock) return;
    acctCheck();
    stateRetry = setTimeout(connectState, stateRetryMs);
    stateRetryMs = Math.min(stateRetryMs * 1.5, 5000);
  };
  sock.onerror = () => sock.close();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && acct && !acct.boot && stateWs?.readyState === WebSocket.CLOSED) connectState();
});
setInterval(pruneConnections, 1000);

// --- themes -----------------------------------------------------------------

// the browser's scheme unless one is picked, picking the browser's own drops
// the override, applied before paint by index.html

const THEMES = ['dark', 'light', 'oled'];
const themeToggles = document.querySelectorAll('.theme-toggle');
const themeMenus = [...document.querySelectorAll('.theme-menu')];
const systemLight = matchMedia('(prefers-color-scheme: light)');

const currentTheme = () => document.documentElement.dataset.theme || 'dark';
const openMenu = () => themeMenus.find((m) => !m.hidden);
function closeMenus() { for (const m of themeMenus) m.hidden = true; }

function applyTheme(theme) {
  if (theme === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const b of themeToggles) {
    b.title = `theme: ${theme}`;
  }
  for (const li of document.querySelectorAll('.theme-menu li')) li.classList.toggle('current', li.dataset.theme === theme);
  for (const t of liveTerms) t.options.theme = termTheme();
}

function themePick() {
  try { return localStorage.getItem('phosphorus-theme'); } catch { return null; }
}

function setTheme(theme) {
  // a cross-fade for the switch only, never for ordinary hovers
  document.documentElement.classList.add('theme-fade');
  setTimeout(() => document.documentElement.classList.remove('theme-fade'), 350);
  try {
    if (theme === (systemLight.matches ? 'light' : 'dark')) localStorage.removeItem('phosphorus-theme');
    else localStorage.setItem('phosphorus-theme', theme);
  } catch {}
  applyTheme(theme);
}


// each pick led by its button's own icon
const THEME_ICON = { dark: 'moon', light: 'sun', oled: 'moon-thin' };

for (const menu of themeMenus) {
  const list = menu.querySelector('ul');
  const toggle = menu.parentElement.querySelector('.theme-toggle');
  for (const theme of THEMES) {
    const li = document.createElement('li');
    li.append(toggle.querySelector(`.${THEME_ICON[theme]}`).cloneNode(true), theme);
    li.dataset.theme = theme;
    li.tabIndex = 0;
    li.addEventListener('click', () => { setTheme(theme); closeMenus(); });
    list.appendChild(li);
  }
  menu.addEventListener('click', (e) => e.stopPropagation());
}
for (const b of themeToggles) {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = b.parentElement.querySelector('.theme-menu');
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
    if (open && b.closest('.dk-bar')) { menu.classList.add('dk-pop'); dkAnchor(menu, b); }
  });
}
systemLight.addEventListener('change', (e) => { if (!themePick()) applyTheme(e.matches ? 'light' : 'dark'); });
applyTheme(currentTheme());

// --- keys and popups ------------------------------------------------------------

function isMobile() { return mobileQuery.matches; }
const modalOpen = () => !!document.querySelector('.modal:not([hidden])');

// swipe down on a popup: dismissed, as by its ×
for (const box of document.querySelectorAll('.modal-box')) {
  let drag = null;
  box.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' || e.target.closest('input, select, textarea, button')) return;
    drag = { id: e.pointerId, y: e.clientY, on: false };
  });
  box.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = Math.max(0, e.clientY - drag.y);
    if (!drag.on && dy > 8) { drag.on = true; box.setPointerCapture(e.pointerId); box.classList.add('dragging'); }
    if (drag.on) box.style.transform = `translateY(${dy}px)`;
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const gone = drag.on && e.type === 'pointerup' && e.clientY - drag.y > 60;
    drag = null;
    box.classList.remove('dragging');
    box.classList.add('settling');
    box.addEventListener('transitionend', () => box.classList.remove('settling'), { once: true });
    box.style.transform = '';
    if (gone) box.querySelector('.modal-close').click();
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
}

// ctrl+↑↓ through the chats, from the chat or anywhere not typing; ahead of
// the chat box's own ↑, an editor's and a terminal's left alone
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
  const t = e.target;
  const inChat = chatPanel.contains(t) || cwList.contains(t);
  if (modalOpen() || (!inChat && t.closest?.('input, textarea, select, [contenteditable], .xterm'))) return;
  e.preventDefault();
  e.stopPropagation();
  stepConv(e.key === 'ArrowDown' ? 1 : -1);
}, true);

// a press outside a popup and its button closing it, as the mesh's and the menus'
document.addEventListener('pointerdown', (e) => {
  const t = e.target;
  for (const m of themeMenus) if (!m.hidden && !m.contains(t) && !m.previousElementSibling?.contains(t)) m.hidden = true;
  if (!updateModal.hidden && !updateModal.parentElement.contains(t)) closeUpdateModal();
}, true);

// shift+esc only ever unfocusing a terminal, esc the menus and the update pane
document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.key !== 'Escape') return;
  const t = e.target;
  if (e.shiftKey) {
    if (t.closest?.('.xterm')) t.blur();
    e.preventDefault();
    return;
  }
  if (t.closest?.('.chat-panel') && t.closest('input, textarea')) t.blur();
  if (!updateModal.hidden) closeUpdateModal();
  closeMenus();
});

// --- desktop: a pretend remote desktop, every window one of the
// mesh's own terminals, files or services, drawn here

const dkView = document.getElementById('view-desktop');
const DK_USERS_KEY = 'phosphorus-dk-users';
const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
// creds: host -> {user, pass}, this page's memory only
const dk = { creds: new Map(), rows: new Map(), wins: new Map(), services: [], deskFiles: [], z: 10, n: 0, desk: null, sig: '' };

function dkUsers() {
  try { return JSON.parse(localStorage.getItem(DK_USERS_KEY)) || {}; } catch { return {}; }
}

// null once the host's shell answers, else why not, the session ended either way
function dkProbe(host, user, pass) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase()}/api/term/${encodeURIComponent(host)}?${new URLSearchParams({ sid: newSid(), since: 0 })}`);
    ws.binaryType = 'arraybuffer';
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let text = '';
    let step = 0;
    let settle = null;
    const lastLine = () => text.trim().split(/\r?\n/).filter(Boolean)[0];
    const done = (why) => {
      if (step === 3) return;
      step = 3;
      clearTimeout(settle);
      clearTimeout(limit);
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
      ws.close();
      resolve(why);
    };
    const limit = setTimeout(() => done('no answer'), 15000);
    ws.onmessage = (e) => {
      text += dec.decode(e.data, { stream: true });
      if (step === 0 && /login: $/.test(text)) { step = 1; text = ''; ws.send(enc.encode(`${user}\r`)); }
      else if (step === 1 && /password: $/.test(text)) { step = 2; text = ''; ws.send(enc.encode(`${pass}\r`)); }
      else if (step === 2) {
        if (/login: $/.test(text)) return done(lastLine() || 'access denied');
        // the shell's first words, unless a refusal's prompt follows close behind
        if (text.trim()) { clearTimeout(settle); settle = setTimeout(() => done(null), 250); }
      }
    };
    ws.onclose = () => done(lastLine() || `${host} didn't answer`);
  });
}

// --- login: every host's user and password, any that answer enough

// masked by css, never a password field, so password managers skip it
function noFill(input, secret) {
  Object.assign(input, { type: 'text', autocomplete: 'off', name: `nf-${Math.random().toString(36).slice(2)}` });
  for (const [k, v] of [['data-1p-ignore', ''], ['data-lpignore', 'true'], ['data-bwignore', ''], ['data-form-type', 'other']]) input.setAttribute(k, v);
  if (secret) input.classList.add('no-fill-secret');
  return input;
}

function dkLoginRow(host) {
  const user = noFill(Object.assign(el('input'), { placeholder: 'user', spellcheck: false, value: dkUsers()[host] || '' }));
  const pass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
  const state = el('span', 'dk-state');
  const li = el('li', 'dk-row');
  li.append(el('span', 'dk-host', host), user, pass, state);
  for (const input of [user, pass]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); dkConnect(); } });
  return { li, user, pass, state, host };
}

function dkLogin() {
  const list = el('ul', 'dk-rows');
  const go = Object.assign(el('button', 'primary', 'connect'), { type: 'button' });
  const box = el('div', 'dk-login');
  const actions = el('div', 'update-actions');
  actions.append(go);
  const skip = Object.assign(el('button', '', 'skip'), { type: 'button', title: 'log in to hosts later from their locks in the task bar' });
  const out = Object.assign(el('button', '', 'log out'), { type: 'button' });
  actions.prepend(out, skip);
  box.append(el('div', 'home-col-head', acct ? `desktop, ${acct.user}` : 'desktop'),
    el('p', 'dk-note', 'ssh into one or more hosts, saved to your profile for next time'), list, actions);
  go.addEventListener('click', dkConnect);
  skip.addEventListener('click', dkDesktop);
  out.addEventListener('click', acctLogout);
  const stage = el('div', 'dk-stage');
  stage.appendChild(box);
  const desk = el('div', 'dk-desk');
  desk.append(dkArt(), stage, dkBar());
  dkView.replaceChildren(desk);
  dk.login = { list, go };
  dk.rows.clear();
  dkLoginHosts();
}

// rows kept as typed across a state push, only new hosts added
function dkLoginHosts() {
  if (!dk.login) return;
  const hosts = [...terminalHosts].sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b));
  for (const h of hosts) if (!dk.rows.has(h)) dk.rows.set(h, dkLoginRow(h));
  const shown = hosts.map((h) => dk.rows.get(h).li);
  if (shown.length !== dk.login.list.children.length || shown.some((li, i) => dk.login.list.children[i] !== li)) {
    dk.login.list.replaceChildren(...(shown.length ? shown : [el('li', 'empty', 'no hosts yet')]));
  }
}

async function dkConnect() {
  const tries = [...dk.rows.values()].filter((r) => r.user.value.trim() && r.pass.value && !dk.creds.has(r.host));
  if (!tries.length) {
    const first = [...dk.rows.values()].find((r) => !r.user.value.trim() || !r.pass.value);
    (first && !first.user.value.trim() ? first.user : first?.pass)?.focus();
    return;
  }
  dk.login.go.disabled = true;
  const users = dkUsers();
  await Promise.all(tries.map(async (r) => {
    const user = r.user.value.trim();
    const pass = r.pass.value;
    r.state.className = 'dk-state busy';
    r.state.textContent = '…';
    const why = await dkProbe(r.host, user, pass);
    r.state.className = `dk-state ${why ? 'bad' : 'ok'}`;
    r.state.textContent = why || 'ok';
    r.state.title = why || '';
    if (why) { r.pass.value = ''; return; }
    dk.creds.set(r.host, { user, pass });
    users[r.host] = user;
    if (acct) acct.vault.hosts[r.host] = { user, pass };
  }));
  acctSave();
  try { localStorage.setItem(DK_USERS_KEY, JSON.stringify(users)); } catch {}
  if (!dk.login) return;
  dk.login.go.disabled = false;
  if (dk.creds.size) dkDesktop();
}

// --- the desktop: icons, windows and a task bar

function dkDesktop() {
  dk.login = null;
  const icons = el('div', 'dk-icons');
  const wins = el('div', 'dk-wins');
  const tasks = el('div', 'dk-tasks');
  const hosts = el('span', 'dk-hosts');
  const note = Object.assign(el('span', 'dk-host-note'), { hidden: true });
  const desk = el('div', 'dk-desk');
  const bar = dkBar(tasks, hosts, dkProfileTray());
  hosts.after(note);
  bar.insertBefore(dkMeshTray(), dkTray);
  desk.append(dkArt(), icons, wins, bar);
  dkView.replaceChildren(desk);
  dkBand(icons);
  dkDeskMenu(icons);
  dk.desk = { el: desk, icons, wins, tasks, hosts };
  dk.chips = '';
  dkChips();
  new ResizeObserver(() => dkLayout()).observe(icons);
  // the desk resized, floating windows kept on it
  new ResizeObserver(() => {
    const W = wins.clientWidth;
    const H = wins.clientHeight;
    if (!W || !H) return;
    for (const w of dk.wins.values()) {
      if (w.snap) continue;
      const nw = Math.min(w.w, W);
      const nh = Math.min(w.h, H);
      const nx = Math.max(0, Math.min(W - nw, w.x));
      const ny = Math.max(0, Math.min(H - nh, w.y));
      if (nw === w.w && nh === w.h && nx === w.x && ny === w.y) continue;
      Object.assign(w, { w: nw, h: nh, x: nx, y: ny });
      dkPlace(w);
    }
  }).observe(wins);
  dk.sig = '';
  dkClock();
  dkIcons();
}

// the page's update and theme buttons, moved into whichever bar is up
const dkTray = document.querySelector('.top-mesh-wide');
function dkBar(...before) {
  const bar = el('div', 'dk-bar');
  dk.clock = el('span', 'dk-clock');
  if (!before.length) bar.appendChild(el('span', 'dk-tasks'));
  bar.append(...before.slice(0, 2), dkTray, dk.clock, ...before.slice(2));
  dkTray.querySelector('.update-wrap').hidden = !acct?.admin;
  updateModal.classList.add('dk-pop');
  dkAnchor(updateModal, topUpdate);
  if (!acct?.admin) closeUpdateModal();
  dkClock();
  return bar;
}

function dkArt() {
  dkWallPaint();
  const art = el('div', 'dk-art');
  art.appendChild(document.querySelector('.about-art').cloneNode(true));
  return art;
}

function dkClock() {
  if (!dk.clock) return;
  dk.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(dkClock, 5000);

function dkLogout() {
  dk.meshTray?.show(false);
  dk.profileTray?.show(false);
  for (const w of [...dk.wins.values()]) dkClose(w, true);
  dk.creds.clear();
  dk.desk = null;
}

const DK_GLYPHS = {
  doc: ICONS.file,
  app: 'M2.5 2.5h11v11h-11zM2.5 5.5h11M4.25 4h.01M5.75 4h.01M6 8.5l-1.5 1.5L6 11.5M10 8.5l1.5 1.5-1.5 1.5',
  files: ICONS.folder,
  editor: 'M3 1.5h7l3 3v10H3zM10 1.5v3h3M5 7.5h6M5 10h6M5 12.5h3.5',
  service: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c-2.2 2.4-2.2 10.6 0 13M8 1.5c2.2 2.4 2.2 10.6 0 13',
  chat: 'M2 2.5h12v8H6.5L3.5 13v-2.5H2zM4.5 5.5h7M4.5 8h4.5',
  status: 'M1.5 8h3l1.5-4 3 8 1.5-4h4',
  projects: 'M2 3.5h12v10H2zM2 6.5h12M5 3.5v-2M11 3.5v-2M4.5 9h3M4.5 11h5',
  git: 'M4.5 2v8M4.5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11.5 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11.5 6c0 3-7 2-7 4',
  games: 'M2.5 5h11a1 1 0 0 1 1 1v5a2 2 0 0 1-3.5 1.3L9.5 11h-3L5 12.3A2 2 0 0 1 1.5 11V6a1 1 0 0 1 1-1zM4.5 7v2.5M3.25 8.25h2.5M10.5 7.5h.01M12 9h.01',
  about: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM8 7v4.5M8 4.75h.01',
  mesh: 'M6.5 1.5h3v3h-3zM1.5 11.5h3v3h-3zM11.5 11.5h3v3h-3zM7.2 4.5l-3.4 7M8.8 4.5l3.4 7M4.5 13h7',
  lock: 'M4 7.5h8v6H4zM5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5',
  crown: 'M5.6 3.9L5 1.2l1.7 1.3L8 .6l1.3 1.9L11 1.2l-.6 2.7z',
  user: 'M8 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5',
  users: 'M6 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM1.5 13.5c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4M11 3a2 2 0 0 1 0 4M12.5 9.8c1.2.5 1.9 1.7 2 3.7',
  key: 'M10 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM7.2 8.8L2 14v1.5h2.5V14H6v-1.5h1.5L9 11',
};

// the frontend's own stroked glyphs, a phrase of path data each
function dkGlyph(d, cls = '') {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: `ic ${cls}`, 'aria-hidden': 'true' });
  svg.appendChild(svgEl('path', { d }));
  return svg;
}
const DK_UI = {
  min: 'M4 11.5h8', max: 'M3.5 3.5h9v9h-9z', close: 'M4 4l8 8M12 4l-8 8',
  pop: 'M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9.5v4H2.5V4h4',
  back: 'M10 3L5 8l5 5', fwd: 'M6 3l5 5-5 5', up: 'M3 10.5l5-5 5 5',
  list: 'M2.5 4h11M2.5 8h11M2.5 12h11', grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
};

// icons on a grid, any cell, kept per browser; a press selects, a drag moves
// the selection, a double click (a tap on touch) opens
const DK_POS_KEY = 'phosphorus-dk-icons';
const DK_GX = 92;
const DK_GY = 86;
const DK_PAD = 8;
dk.sel = new Set();

// a service with no icon of its own: its initial in a square
function dkMono(label) {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: 'ic dk-mono', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('rect', { x: 1.5, y: 1.5, width: 13, height: 13 }));
  const t = svgEl('text', { x: 8, y: 8.6, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  t.textContent = (String(label).match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  svg.appendChild(t);
  return svg;
}

// the first of icons that loads, the glyph kept when none does
function dkTryIcons(tile, icons) {
  const [first, ...rest] = icons.filter(Boolean);
  if (!first) return;
  const img = Object.assign(el('img', 'dk-favicon'), { alt: '', decoding: 'async', draggable: false });
  img.addEventListener('load', () => { tile.replaceChildren(img); tile.classList.add('dk-tile-img'); }, { once: true });
  img.addEventListener('error', () => dkTryIcons(tile, rest), { once: true });
  img.src = first;
}

function dkIcon(kind, label, sub, open, icon = '') {
  const b = Object.assign(el('button', `dk-icon dk-${kind}`), { type: 'button', title: sub ? `${label} on ${sub}` : label });
  const tile = el('span', 'dk-tile');
  tile.appendChild(kind === 'service' ? dkMono(label) : dkGlyph(DK_GLYPHS[kind]));
  if (kind === 'chat') tile.appendChild(dkBadge());
  // a site's own icon once it loads
  dkTryIcons(tile, [].concat(icon));
  b.append(tile, el('span', 'dk-label', label));
  if (sub) b.appendChild(el('span', 'dk-sub', sub));
  b.dataset.id = `${kind}\n${label}\n${sub}`;
  b.addEventListener('dblclick', open);
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } });
  b.addEventListener('pointerdown', (e) => dkGrab(e, b, open));
  return b;
}

// rebuilt only when the hosts or services change
function dkIcons() {
  if (!dk.desk) return;
  dkDeskWatch();
  const hosts = [...dk.creds.keys()];
  const git = !!gitRoute;
  const sig = JSON.stringify([hosts, git, !!acct?.admin, dk.services.map((r) => [r.host, r.name]), dk.deskFiles.map((e) => [e.at, e.name, e.dir, e.mtime, e.hosts, e.stale, e.all])]);
  if (sig === dk.sig) return;
  dk.sig = sig;
  dk.desk.icons.replaceChildren(
    dkIcon('files', 'files', '', () => dkFiles()),
    dkIcon('editor', 'editor', '', dkEditorPick),
    dkIcon('chat', 'chat', '', () => dkOpenApp('chat')),
    dkIcon('status', 'status', '', () => dkOpenApp('status')),
    dkIcon('projects', 'projects', '', () => dkOpenApp('projects')),
    ...(git ? [dkIcon('git', 'git', '', () => dkOpenApp('git'))] : []),
    dkIcon('games', 'games', '', () => dkOpenApp('games')),
    dkIcon('about', 'about', '', () => dkOpenApp('about')),
    ...(acct?.admin ? [dkIcon('users', 'users', '', dkUsersWin)] : []),
    ...dk.services.map((r) => dkIcon('service', r.name, r.host, () => dkService(r),
      `/api/favicon/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}`)),
    ...dk.deskFiles.map(dkFileIcon),
  );
  dkLayout();
}

function dkSaved() {
  try { const v = JSON.parse(localStorage.getItem(DK_POS_KEY)); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
const dkIconEls = () => (dk.desk ? [...dk.desk.icons.querySelectorAll('.dk-icon')] : []);
const dkGrid = () => {
  const { icons } = dk.desk;
  return {
    cols: Math.max(1, Math.floor((icons.clientWidth - DK_PAD) / DK_GX)),
    rows: Math.max(1, Math.floor((icons.clientHeight - DK_PAD) / DK_GY)),
  };
};
const dkCell = (c, r) => `${c},${r}`;

// saved cells first, the rest down then across into the free ones
function dkLayout() {
  // unmeasured (not on the page yet, or hidden): placed once it has a size,
  // never squeezed into one row and sprung back
  if (!dk.desk || !dk.desk.icons.clientHeight) return;
  const { cols, rows } = dkGrid();
  const saved = dkSaved();
  const taken = new Set();
  const rest = [];
  for (const b of dkIconEls()) {
    const p = saved[b.dataset.id];
    if (Array.isArray(p) && p[0] < cols && p[1] < rows && !taken.has(dkCell(...p))) {
      taken.add(dkCell(...p));
      dkPut(b, p[0], p[1]);
    } else rest.push(b);
  }
  let i = 0;
  let placed = false;
  for (const b of rest) {
    while (taken.has(dkCell(Math.floor(i / rows), i % rows)) && i < cols * rows) i += 1;
    const c = Math.floor(i / rows);
    const r = i % rows;
    taken.add(dkCell(c, r));
    dkPut(b, c, r);
    // an icon's first cell kept, so one blinking out never reflows the rest
    if (!(b.dataset.id in saved)) { saved[b.dataset.id] = [c, r]; placed = true; }
  }
  if (placed) try { localStorage.setItem(DK_POS_KEY, JSON.stringify(saved)); } catch {}
  for (const id of [...dk.sel]) if (!dkIconEls().some((b) => b.dataset.id === id)) dk.sel.delete(id);
  dkPaintSel();
}

function dkPut(b, c, r) {
  b.dataset.c = c;
  b.dataset.r = r;
  b.style.transform = `translate(${DK_PAD + c * DK_GX}px, ${DK_PAD + r * DK_GY}px)`;
}

function dkSave() {
  const saved = dkSaved();
  for (const b of dkIconEls()) saved[b.dataset.id] = [Number(b.dataset.c), Number(b.dataset.r)];
  try { localStorage.setItem(DK_POS_KEY, JSON.stringify(saved)); } catch {}
}

function dkPaintSel() {
  for (const b of dkIconEls()) b.classList.toggle('sel', dk.sel.has(b.dataset.id));
}

function dkGrab(e, b, open) {
  if (e.button !== 0) return;
  e.preventDefault();
  dkFocus(null);
  b.focus({ preventScroll: true });
  const id = b.dataset.id;
  const add = e.ctrlKey || e.metaKey;
  const was = dk.sel.has(id);
  if (add) { if (!was) dk.sel.add(id); } else if (!was) dk.sel = new Set([id]);
  dkPaintSel();
  b.setPointerCapture(e.pointerId);
  const moving = dkIconEls().filter((x) => dk.sel.has(x.dataset.id));
  let dx = 0;
  let dy = 0;
  let dragged = false;
  let frame = 0;
  // files on the desktop carried into a files window: its folder under the pointer
  const files = moving.filter((x) => x.dataset.file);
  let zone = null;
  let px = e.clientX;
  let py = e.clientY;
  const aim = () => {
    let z = null;
    for (const n of document.elementsFromPoint(px, py)) {
      if (n.closest('.dk-icons')) continue;
      z = n.closest('[data-fm-drop]');
      break;
    }
    const got = z && fmZones.get(z);
    const t = got?.where();
    if (zone && zone !== z) { zone.classList.remove('drop'); fmUnspring(fmZones.get(zone).fm, zone); }
    zone = got && t && may(t.loc, 'w') ? z : null;
    if (zone) { fmMark(got.fm, zone); fmSpring(got.fm, zone, t); }
  };
  // a copy riding the pointer above every window
  let ghost = null;
  const paint = () => {
    frame = 0;
    for (const x of moving) x.style.transform = `translate(${DK_PAD + x.dataset.c * DK_GX + dx}px, ${DK_PAD + x.dataset.r * DK_GY + dy}px)`;
    if (!files.length) return;
    if (!ghost) {
      ghost = el('div', 'dk-ghost');
      ghost.appendChild(b.cloneNode(true));
      if (moving.length > 1) ghost.appendChild(el('span', 'dk-ghost-n', String(moving.length)));
      document.body.appendChild(ghost);
    }
    const r = b.getBoundingClientRect();
    ghost.style.transform = `translate(${r.left}px, ${r.top}px)`;
    aim();
  };
  const onMove = (ev) => {
    dx = ev.clientX - e.clientX;
    dy = ev.clientY - e.clientY;
    px = ev.clientX;
    py = ev.clientY;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) { dragged = true; dk.desk.el.classList.add('dk-moving'); for (const x of moving) x.classList.add('dk-lift'); }
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const onUp = (ev) => {
    b.removeEventListener('pointermove', onMove);
    b.removeEventListener('pointerup', onUp);
    b.removeEventListener('pointercancel', onUp);
    cancelAnimationFrame(frame);
    if (!dragged) {
      if (add && was) { dk.sel.delete(id); dkPaintSel(); }
      else if (!add && ev.type === 'pointerup') {
        dk.sel = new Set([id]);
        dkPaintSel();
        if (e.pointerType !== 'mouse') open();
      }
      return;
    }
    dk.desk?.el.classList.remove('dk-moving');
    ghost?.remove();
    for (const x of moving) x.classList.remove('dk-lift');
    if (zone) {
      // into the window: the icons back in their cells, the files sent
      const { fm, where } = fmZones.get(zone);
      const t = where();
      zone.classList.remove('drop');
      fmUnspring(fm);
      for (const x of moving) dkPut(x, Number(x.dataset.c), Number(x.dataset.r));
      const items = files.map((x) => dk.deskFiles.find((f) => filesJoin(f.at, f.name) === x.dataset.file))
        .filter(Boolean).map((f) => ({ rel: filesJoin(f.at, f.name), dir: !!f.dir, name: f.name }))
        .filter((it) => !(fmSame(HOME, t.loc) && filesParent(it.rel) === t.dir));
      if (items.length) fmTransfer(fm, HOME, items, t.loc, t.dir, fmSame(HOME, t.loc) && !ev.ctrlKey && !ev.altKey);
      return;
    }
    dkDrop(moving, Math.round(dx / DK_GX), Math.round(dy / DK_GY));
  };
  b.addEventListener('pointermove', onMove);
  b.addEventListener('pointerup', onUp);
  b.addEventListener('pointercancel', onUp);
}

// each moved icon its own cell, else the nearest free one
function dkDrop(moving, dc, dr) {
  const { cols, rows } = dkGrid();
  const taken = new Set(dkIconEls().filter((x) => !moving.includes(x)).map((x) => dkCell(x.dataset.c, x.dataset.r)));
  for (const x of moving) {
    const c0 = Math.max(0, Math.min(cols - 1, Number(x.dataset.c) + dc));
    const r0 = Math.max(0, Math.min(rows - 1, Number(x.dataset.r) + dr));
    let best = null;
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        if (taken.has(dkCell(c, r))) continue;
        const d = (c - c0) ** 2 + (r - r0) ** 2;
        if (!best || d < best.d) best = { c, r, d };
      }
    }
    const at = best || { c: c0, r: r0 };
    taken.add(dkCell(at.c, at.r));
    dkPut(x, at.c, at.r);
  }
  dkSave();
}

// a drag on bare desk: a band selecting every icon it touches, ctrl adding
function dkBand(icons) {
  icons.addEventListener('pointerdown', (e) => {
    if (e.target !== icons || e.button !== 0) return;
    e.preventDefault();
    dkFocus(null);
    document.activeElement?.blur?.();
    const keep = e.ctrlKey || e.metaKey ? new Set(dk.sel) : new Set();
    dk.sel = new Set(keep);
    dkPaintSel();
    icons.setPointerCapture(e.pointerId);
    const box = icons.getBoundingClientRect();
    const x0 = e.clientX - box.left;
    const y0 = e.clientY - box.top;
    const band = el('div', 'dk-band');
    let frame = 0;
    let at = null;
    const paint = () => {
      frame = 0;
      const x1 = Math.max(0, Math.min(box.width, at.clientX - box.left));
      const y1 = Math.max(0, Math.min(box.height, at.clientY - box.top));
      const l = Math.min(x0, x1);
      const t = Math.min(y0, y1);
      const r = Math.max(x0, x1);
      const bt = Math.max(y0, y1);
      Object.assign(band.style, { left: `${l}px`, top: `${t}px`, width: `${r - l}px`, height: `${bt - t}px` });
      dk.sel = new Set(keep);
      for (const b of dkIconEls()) {
        const i = b.getBoundingClientRect();
        const il = i.left - box.left;
        const it = i.top - box.top;
        if (il < r && il + i.width > l && it < bt && it + i.height > t) dk.sel.add(b.dataset.id);
      }
      dkPaintSel();
    };
    const onMove = (ev) => {
      if (!band.isConnected) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return;
        icons.appendChild(band);
      }
      at = ev;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const onUp = () => {
      icons.removeEventListener('pointermove', onMove);
      icons.removeEventListener('pointerup', onUp);
      icons.removeEventListener('pointercancel', onUp);
      cancelAnimationFrame(frame);
      if (at) paint();
      band.remove();
    };
    icons.addEventListener('pointermove', onMove);
    icons.addEventListener('pointerup', onUp);
    icons.addEventListener('pointercancel', onUp);
  });
}

// esc and ctrl+a for the icons, a window's own keys left alone
document.addEventListener('keydown', (e) => {
  if (!dk.desk || e.defaultPrevented) return;
  const t = e.target;
  if (t !== document.body && !dk.desk.icons.contains(t)) return;
  if (e.key === 'Escape') { dk.sel.clear(); dkPaintSel(); }
  else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    dk.sel = new Set(dkIconEls().map((b) => b.dataset.id));
    dkPaintSel();
  }
});

function dkRoutes(services) {
  dk.services = services;
  dkIcons();
  dkChips();
  dkGitFrame();
  dkLoginHosts();
}

// the logged in hosts, the one serving this page purple, a press moving it there
function dkChips() {
  const hosts = dk.desk?.hosts;
  if (!hosts) return;
  const here = hostSwitch?.to || selfHost;
  const names = [...new Set([...dk.creds.keys(), ...terminalHosts])]
    .sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b));
  const up = new Set([...terminalHosts, selfHost]);
  const sig = JSON.stringify([here, names, [...dk.creds.keys()], names.filter((h) => !up.has(h))]);
  if (sig === dk.chips) return;
  dk.chips = sig;
  hosts.replaceChildren(...names.map((h) => {
    if (!dk.creds.has(h)) {
      const b = Object.assign(el('button', 'dk-chip locked', h), { type: 'button', title: `log in to ${h}` });
      b.prepend(dkGlyph(DK_GLYPHS.lock));
      b.addEventListener('click', () => dkUnlock(h, b));
      return b;
    }
    if (!up.has(h)) return Object.assign(el('button', 'dk-chip down', h), { type: 'button', title: `${h} dropped off the mesh` });
    const b = Object.assign(el('button', `dk-chip${h === here ? ' here' : ''}`, h), { type: 'button' });
    b.title = h === here ? `this page is served by ${h}` : `serve this page from ${h}`;
    b.setAttribute('aria-pressed', String(h === here));
    b.addEventListener('click', () => switchHost(h));
    return b;
  }));
}

// one window, key: a single instance's, else a fresh one per open
function dkWin(key, title, sub, kind) {
  if (key && dk.wins.has(key)) { dkFocus(dk.wins.get(key)); return null; }
  const { wins, tasks } = dk.desk;
  const node = el('div', `dk-win dk-${kind}`);
  const head = el('div', 'dk-head');
  const name = el('span', 'dk-title');
  name.appendChild(el('span', 'tab-label', title));
  if (sub) name.appendChild(el('span', 'dk-sub', ` ${sub}`));
  const btns = el('span', 'dk-btns');
  const btn = (cls, d, label) => {
    const b = Object.assign(el('button', cls), { type: 'button', title: label, ariaLabel: label });
    b.appendChild(dkGlyph(d));
    return b;
  };
  const min = btn('dk-min', DK_UI.min, 'minimize');
  const max = btn('dk-max', DK_UI.max, 'maximize');
  const close = btn('dk-close', DK_UI.close, 'close');
  btns.append(min, max, close);
  head.append(name, btns);
  const body = el('div', 'dk-body');
  // every side and corner a resize handle
  const edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((e) => {
    const d = el('div', 'dk-edge');
    d.dataset.e = e;
    return d;
  });
  node.append(head, body, ...edges);
  const task = Object.assign(el('button', 'dk-task', title), { type: 'button', title: sub ? `${title} ${sub}` : title });
  const w = { key: key || `w${++dk.n}`, node, body, head, task, kind, onFocus: null, onClose: null };
  // cascaded from the icons, a phone's filling the desk
  const step = (dk.n++ % 8) * 24;
  const W = wins.clientWidth;
  const H = wins.clientHeight;
  w.w = Math.min(760, W - 24);
  w.h = Math.min(460, H - 24);
  w.x = Math.max(0, Math.min(W - w.w, 120 + step));
  w.y = Math.max(0, Math.min(H - w.h, 16 + step));
  dkPlace(w);
  w.snap = '';
  if (isMobile()) dkSnap(w, 'max');
  min.addEventListener('click', () => dkMin(w));
  max.addEventListener('click', () => dkMax(w));
  close.addEventListener('click', () => dkClose(w));
  head.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) dkMax(w); });
  task.addEventListener('click', () => {
    if (node.hidden) { node.hidden = false; dkFocus(w); } else if (node.classList.contains('focused')) dkMin(w); else dkFocus(w);
  });
  node.addEventListener('pointerdown', () => dkFocus(w), true);
  dkMove(w, head);
  for (const edge of edges) dkDrag(w, edge, (dx, dy, o) => dkResize(w, edge.dataset.e, dx, dy, o));
  wins.appendChild(node);
  tasks.appendChild(task);
  dk.wins.set(w.key, w);
  return w;
}

// a side's drag: its own edge moved, the opposite one held, never under the minimum
const DK_MIN_W = 280;
const DK_MIN_H = 160;
function dkResize(w, e, dx, dy, o) {
  if (e.includes('e')) w.w = Math.max(DK_MIN_W, o.w + dx);
  if (e.includes('s')) w.h = Math.max(DK_MIN_H, o.h + dy);
  if (e.includes('w')) {
    const nx = Math.min(o.x + dx, o.x + o.w - DK_MIN_W);
    w.w = o.w + o.x - nx;
    w.x = nx;
  }
  if (e.includes('n')) {
    const ny = Math.max(0, Math.min(o.y + dy, o.y + o.h - DK_MIN_H));
    w.h = o.h + o.y - ny;
    w.y = ny;
  }
}

function dkPlace(w) {
  w.node.style.transform = `translate3d(${w.x}px, ${w.y}px, 0)`;
  w.node.style.width = `${w.w}px`;
  w.node.style.height = `${w.h}px`;
}

// pointer captured from press to release, one write per frame
function dkDrag(w, handle, move) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button') || w.snap) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const o = { x: w.x, y: w.y, w: w.w, h: w.h, px: e.clientX, py: e.clientY };
    let frame = 0;
    dk.desk.el.classList.add('dk-moving');
    const onMove = (ev) => {
      move(ev.clientX - o.px, ev.clientY - o.py, o);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; dkPlace(w); });
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      dk.desk?.el.classList.remove('dk-moving');
      cancelAnimationFrame(frame);
      dkPlace(w);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
}

// where letting go snaps: the top edge maximized, a side its half, a side's
// end its quarter
const DK_EDGE = 14;
function dkZone(x, y, W, H) {
  if (y < DK_EDGE && x > DK_EDGE * 3 && x < W - DK_EDGE * 3) return 'max';
  const side = x < DK_EDGE ? 'l' : x > W - DK_EDGE ? 'r' : '';
  if (!side) return y < DK_EDGE ? (x < W / 2 ? 'tl' : 'tr') : '';
  return y < H * 0.25 ? `t${side}` : y > H * 0.75 ? `b${side}` : side;
}

function dkSnap(w, zone) {
  w.snap = zone || '';
  if (zone) w.node.dataset.snap = zone; else delete w.node.dataset.snap;
  w.node.querySelector('.dk-max').title = zone === 'max' ? 'restore' : 'maximize';
}

// a title bar's drag: a snapped window let go of its snap first, under the
// pointer where it was held, a dashed outline showing the snap to come
function dkMove(w, head) {
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const { wins } = dk.desk;
    const box = wins.getBoundingClientRect();
    const at = w.node.getBoundingClientRect();
    const grab = (e.clientX - at.left) / at.width;
    let o = null;
    let zone = '';
    let frame = 0;
    const preview = el('div', 'dk-snap');
    const onMove = (ev) => {
      if (!o) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        if (w.snap) {
          w.x = e.clientX - box.left - grab * w.w;
          w.y = Math.max(0, e.clientY - box.top - 12);
          dkSnap(w, '');
        }
        o = { x: w.x, y: w.y };
        dk.desk.el.classList.add('dk-moving');
        wins.appendChild(preview);
      }
      w.x = o.x + ev.clientX - e.clientX;
      w.y = Math.max(0, o.y + ev.clientY - e.clientY);
      const next = dkZone(ev.clientX - box.left, ev.clientY - box.top, box.width, box.height);
      if (next !== zone) {
        zone = next;
        if (zone) preview.dataset.snap = zone; else delete preview.dataset.snap;
      }
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; dkPlace(w); });
    };
    const onUp = () => {
      head.removeEventListener('pointermove', onMove);
      preview.remove();
      if (!o) return;
      dk.desk?.el.classList.remove('dk-moving');
      cancelAnimationFrame(frame);
      // never lost under the task bar or off either side
      w.x = Math.max(48 - w.w, Math.min(box.width - 48, w.x));
      w.y = Math.max(0, Math.min(box.height - 28, w.y));
      dkPlace(w);
      if (zone) { dkTween(w); dkSnap(w, zone); }
    };
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp, { once: true });
    head.addEventListener('pointercancel', onUp, { once: true });
  });
}

// a class played out before done, cut short by a refocus
function dkLeave(w, done, cls = 'dk-leaving') {
  const n = w.node;
  const end = () => {
    if (w.leaving !== t) return;
    clearTimeout(t);
    w.leaving = 0;
    n.removeEventListener('animationend', onEnd);
    n.classList.remove(cls);
    done();
  };
  const onEnd = (e) => { if (e.target === n) end(); };
  const t = setTimeout(end, 300);
  w.leaving = t;
  n.classList.add(cls);
  n.addEventListener('animationend', onEnd);
}

// a geometry change eased, never a drag's
function dkTween(w) {
  w.node.classList.add('dk-tween');
  clearTimeout(w.tween);
  w.tween = setTimeout(() => w.node.classList.remove('dk-tween'), 220);
}

function dkFocus(w) {
  if (w?.leaving) {
    clearTimeout(w.leaving);
    w.leaving = 0;
    w.node.classList.remove('dk-leaving', 'dk-minimizing');
  }
  for (const o of dk.wins.values()) {
    o.node.classList.toggle('focused', o === w);
    o.task.classList.toggle('active', o === w);
  }
  if (!w) return;
  w.node.hidden = false;
  if (w.node.style.zIndex !== String(dk.z)) w.node.style.zIndex = ++dk.z;
  w.onFocus?.();
  dkAppsChanged();
}

// shrunk into its task bar button; the scale also pulls the window's own
// offset in, made up for in the translate
const DK_MIN_SCALE = 0.1;
function dkMin(w) {
  const a = w.node.getBoundingClientRect();
  const b = w.task.getBoundingClientRect();
  const k = 1 - DK_MIN_SCALE;
  const mx = w.snap ? 0 : w.x;
  const my = w.snap ? 0 : w.y;
  w.node.style.setProperty('--min-x', `${b.left + b.width / 2 - (a.left + a.width / 2) + k * mx}px`);
  w.node.style.setProperty('--min-y', `${b.top + b.height / 2 - (a.top + a.height / 2) + k * my}px`);
  dkLeave(w, () => { w.node.hidden = true; }, 'dk-minimizing');
  w.node.classList.remove('focused');
  w.task.classList.remove('active');
  const top = [...dk.wins.values()].filter((o) => !o.node.hidden && !o.leaving).sort((a, b) => b.node.style.zIndex - a.node.style.zIndex)[0];
  if (top) dkFocus(top);
  dkAppsChanged();
}

function dkMax(w) {
  dkTween(w);
  dkSnap(w, w.snap === 'max' ? '' : 'max');
  dkFocus(w);
}

// force: past an editor's unsaved hold
function dkClose(w, force) {
  if (!force && w.holdClose?.()) return;
  w.onClose?.();
  if (force) w.node.remove(); else dkLeave(w, () => w.node.remove());
  w.task.remove();
  dk.wins.delete(w.key);
  dkAppsChanged();
}

// --- the apps

function dkTerminal(host, run = '') {
  const c = dk.creds.get(host);
  const w = dkWin(null, 'terminal', host, 'term');
  if (!w || !c) return;
  w.host = host;
  const t = startTerminal(w.body, host, newSid(), false, false, { ...c, run });
  w.onFocus = () => t.focus();
  w.onClose = () => t.close();
  dkFocus(w);
}

// --- the wallpaper: a picture of the user's, kept in their home on the mesh

const DK_WALL_MAX = 2560;

function dkWallPaint() {
  const at = acct?.wallpaper || 0;
  dkView.classList.toggle('dk-walled', !!at);
  if (at) dkView.style.setProperty('--dk-wall', `url("/api/me/wallpaper?v=${at}")`);
  else dkView.style.removeProperty('--dk-wall');
}

// shrunk to the screen's size at most, a jpeg; '' once set, else why not
async function dkWallSet(blob) {
  let url;
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, DK_WALL_MAX / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    url = c.toDataURL('image/jpeg', 0.85);
  } catch { return 'not a picture this browser can read'; }
  const r = await acctCall('/api/me/wallpaper', { data: url });
  if (!r.ok) return r.error || 'not saved';
  acct.wallpaper = r.wallpaper;
  dkWallPaint();
  return '';
}

async function dkWallClear() {
  const r = await acctCall('/api/me/wallpaper', { data: '' });
  if (!r.ok) return;
  acct.wallpaper = 0;
  dkWallPaint();
}

const dkPick = (accept, multiple, then) => {
  const input = Object.assign(el('input'), { type: 'file', accept, multiple });
  input.addEventListener('change', () => { if (input.files.length) then([...input.files]); });
  input.click();
};

// files about to land on the desktop held to the cell at x, y (else the
// nearest free ones after it), their icons placed there once they show
function dkPlaceAt(x, y, names, dir = dkDeskAt()?.dir) {
  if (!dk.desk || !dir || !names.length) return;
  const box = dk.desk.icons.getBoundingClientRect();
  const { cols, rows } = dkGrid();
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor((x - box.left - DK_PAD) / DK_GX)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor((y - box.top - DK_PAD) / DK_GY)));
  const ids = new Set(names.map((n) => `doc\n${filesJoin(dir, n)}`));
  const taken = new Set(dkIconEls().filter((b) => !ids.has(b.dataset.id)).map((b) => dkCell(b.dataset.c, b.dataset.r)));
  const saved = dkSaved();
  let i = c0 * rows + r0;
  for (const id of ids) {
    while (i < cols * rows && taken.has(dkCell(Math.floor(i / rows), i % rows))) i += 1;
    const at = i < cols * rows ? [Math.floor(i / rows), i % rows] : [c0, r0];
    taken.add(dkCell(...at));
    saved[id] = at;
  }
  try { localStorage.setItem(DK_POS_KEY, JSON.stringify(saved)); } catch {}
}

// a new empty file on the desktop at x, y, on this host, opened to edit
function dkNewFile(x, y) {
  const d = dkDeskAt();
  if (!d) return;
  const pop = el('form', 'acct-unlock dk-newfile');
  const name = Object.assign(el('input'), { value: 'untitled.txt', spellcheck: false, autocomplete: 'off' });
  const why = el('span', 'dk-state');
  const go = Object.assign(el('button', 'primary', 'create'), { type: 'submit' });
  pop.append(el('div', 'home-col-head', 'add file'), name, why, go);
  pop.style.left = `${Math.max(4, Math.min(x, innerWidth - 260))}px`;
  pop.style.top = `${Math.max(4, Math.min(y, innerHeight - 140))}px`;
  const close = () => { pop.remove(); pop.dkRelease?.(); document.removeEventListener('pointerdown', away, true); };
  const away = (e) => { if (!pop.contains(e.target)) close(); };
  document.addEventListener('pointerdown', away, true);
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  pop.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n || /[\\/]/.test(n)) { why.textContent = 'a name, no slashes'; return; }
    if (dk.deskFiles.some((f) => f.at === d.dir && f.name === n)) { why.textContent = `${n} is already there`; return; }
    const loc = homeAt(selfHost);
    const rel = filesJoin(d.dir, n);
    go.disabled = true;
    try { await putFile(loc, rel, new Blob([])); } catch (err) { go.disabled = false; why.textContent = err.message; return; }
    close();
    dkPlaceAt(x, y, [n], d.dir);
    fmChanged(HOME, d.dir);
    dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, 'home', rel) });
  });
  document.body.appendChild(pop);
  name.focus();
  // the name picked, its extension left
  name.setSelectionRange(0, name.value.lastIndexOf('.'));
}

// computer files onto the desktop, else a files window's first folder,
// a files window showing the upload either way
function dkAddFiles(list) {
  const fm = dk.desk && dkFiles(dkDeskAt() || undefined);
  if (fm && list.length) fm.pendingUpload = list;
}

// a right click on the desk or an icon, a drop of the computer's files
function dkDeskMenu(icons) {
  icons.addEventListener('contextmenu', (e) => {
    const b = e.target.closest('.dk-icon');
    if (e.target !== icons && !b) return;
    e.preventDefault();
    if (b && !dk.sel.has(b.dataset.id)) { dk.sel = new Set([b.dataset.id]); dkPaintSel(); }
    const hosts = [...dk.creds.keys()];
    const f = b && dk.deskFiles.find((x) => filesJoin(x.at, x.name) === b.dataset.file);
    if (f) { dkMenu(e.clientX, e.clientY, dkFileMenu(f)); return; }
    const items = [
      ...(b ? [['open', () => b.dispatchEvent(new MouseEvent('dblclick')), true], null] : []),
      ['add file…', () => dkNewFile(e.clientX, e.clientY), !!dkDeskAt()],
      ['upload files…', () => dkPick('', true, (list) => { dkPlaceAt(e.clientX, e.clientY, list.map((f) => f.name)); dkAddFiles(list); }), hosts.length > 0],
      null,
      ['change wallpaper…', () => dkPick('image/*', false, ([f]) => dkWallSet(f).then((why) => why && dkMenuNote(why))), !!acct && !acct.boot],
      ['remove wallpaper', dkWallClear, !!acct?.wallpaper],
      null,
      ['select all', () => { dk.sel = new Set(dkIconEls().map((x) => x.dataset.id)); dkPaintSel(); }, true],
      ['arrange icons', dkArrange, true],
    ];
    dkMenu(e.clientX, e.clientY, items);
  });
  icons.addEventListener('dragover', (e) => {
    if (!(dragsFiles(e) || (dk.drag && dkDeskAt())) || !dk.creds.size) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  icons.addEventListener('drop', (e) => {
    const drag = dk.drag;
    const d = dkDeskAt();
    // a files window's picks copied onto the desktop
    if (drag && d) {
      e.preventDefault();
      dk.drag = null;
      const items = drag.items.filter((it) => !(fmSame(drag.loc, d.loc) && filesParent(it.rel) === d.dir));
      dkPlaceAt(e.clientX, e.clientY, items.map((it) => it.name), d.dir);
      if (items.length) fmTransfer(drag.fm, drag.loc, items, d.loc, d.dir, false);
      return;
    }
    if (!dragsFiles(e)) return;
    e.preventDefault();
    const list = [...e.dataTransfer.files];
    dkPlaceAt(e.clientX, e.clientY, list.map((f) => f.name));
    dkAddFiles(list);
  });
}

// a word in the clock's place a moment
function dkMenuNote(text) {
  if (!dk.clock) return;
  dk.clock.textContent = text;
  setTimeout(dkClock, 4000);
}

// every icon back in the default order
function dkArrange() {
  try { localStorage.setItem(DK_POS_KEY, '{}'); } catch {}
  dkLayout();
}

// --- files: a file manager over the hosts' shares, places, a path bar, list
// or icons, a right click's menu, cut, copy and paste across hosts

const FM_KINDS = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus'],
  archive: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'zst'],
  pdf: ['pdf'],
};
const FM_GLYPHS = {
  dir: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  file: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3',
  code: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M6.5 8l-1.5 1.5 1.5 1.5M9.5 8l1.5 1.5-1.5 1.5',
  image: 'M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2 3.5 3.5M10.5 5.5h.01',
  video: 'M2 3.5h12v9H2zM6.5 6v4l3.5-2z',
  audio: 'M6 12.5a1.5 1.5 0 1 1-1.5-1.5H6V3l7-1.5v9a1.5 1.5 0 1 1-1.5-1.5H13',
  archive: 'M3.5 1.5h9v13h-9zM8 1.5v2M8 4.5v1M8 6.5v1M7 8.5h2v2H7z',
  pdf: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 9.5h5M5.5 12h3.5',
  host: ICONS.host,
};
const fmExt = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');
function fmKind(e) {
  if (e.dir) return 'dir';
  const x = fmExt(e.name);
  for (const k in FM_KINDS) if (FM_KINDS[k].includes(x)) return k;
  return isCode(e.name) ? 'code' : 'file';
}
const fmKindLabel = (e) => (e.dir ? 'folder' : fmExt(e.name) ? `${fmExt(e.name)} file` : 'file');
const fmIcon = (kind) => dkGlyph(FM_GLYPHS[kind], `fm-${kind}`);
const fmDate = (ms) => (ms ? new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const fmSame = (a, b) => a && b && a.host === b.host && a.share === b.share;
// every file manager open, for a change one makes shown in the rest
const dkFms = new Set();

function dkFiles(at) {
  const w = dkWin(null, 'files', '', 'fm');
  if (!w) return;
  const fm = {
    w, loc: null, dir: '', back: [], fwd: [], entries: [], shown: [], sel: new Set(), anchor: null,
    sort: { key: 'name', dir: 1 }, mode: 'list', filter: '', shares: new Map(), busy: '',
  };
  const btn = (cls, glyph, label) => {
    const b = Object.assign(el('button', `fm-btn ${cls}`), { type: 'button', title: label, ariaLabel: label });
    if (glyph) b.append(glyph);
    return b;
  };
  fm.backBtn = btn('', dkGlyph(DK_UI.back), 'back (alt+←)');
  fm.fwdBtn = btn('', dkGlyph(DK_UI.fwd), 'forward (alt+→)');
  fm.upBtn = btn('', dkGlyph(DK_UI.up), 'up (alt+↑)');
  const refresh = btn('', icon('refresh'), 'refresh (f5)');
  fm.crumbs = el('div', 'fm-crumbs');
  fm.find = Object.assign(el('input', 'fm-find'), { placeholder: 'search', spellcheck: false, autocomplete: 'off' });
  const mkdir = btn('', icon('mkdir'), 'new folder (ctrl+shift+n)');
  const upload = btn('', icon('upload'), 'upload here');
  fm.modeBtn = btn('', null, 'list or icons');
  const tools = el('div', 'fm-tools');
  tools.append(fm.backBtn, fm.fwdBtn, fm.upBtn, refresh, fm.crumbs, mkdir, upload, fm.modeBtn, fm.find);
  fm.side = el('nav', 'fm-side');
  fm.main = Object.assign(el('div', 'fm-main'), { tabIndex: 0 });
  fm.status = el('div', 'fm-status');
  fm.count = el('span', 'fm-count');
  fm.note = el('span', 'fm-note');
  fm.status.append(fm.count, fm.note);
  const split = el('div', 'fm-split');
  split.append(fm.side, fm.main);
  fm.input = Object.assign(el('input'), { type: 'file', multiple: true, hidden: true });
  w.body.append(tools, split, fm.status, fm.input);

  fm.backBtn.addEventListener('click', () => fmHistory(fm, -1));
  fm.fwdBtn.addEventListener('click', () => fmHistory(fm, 1));
  fm.upBtn.addEventListener('click', () => fmUp(fm));
  refresh.addEventListener('click', () => fmLoad(fm));
  mkdir.addEventListener('click', () => fmMkdir(fm));
  upload.addEventListener('click', () => fmCan(fm, 'w') && fm.input.click());
  fm.input.addEventListener('change', () => { fmUpload(fm, fm.loc, fm.dir, fm.input.files); fm.input.value = ''; });
  fm.modeBtn.addEventListener('click', () => { fm.mode = fm.mode === 'list' ? 'grid' : 'list'; fmRender(fm); });
  fm.find.addEventListener('input', () => { fm.filter = fm.find.value.trim().toLowerCase(); fmRender(fm); });
  fm.find.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { fm.find.value = ''; fm.filter = ''; fmRender(fm); fm.main.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); fm.main.focus(); fmStep(fm, 0); }
  });
  fm.main.addEventListener('keydown', (e) => fmKeys(fm, e));
  fm.main.addEventListener('pointerdown', (e) => {
    if (e.target === fm.main || e.target.classList.contains('fm-items')) { fm.sel.clear(); fmPaintSel(fm); }
  });
  fm.main.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = e.target.closest('[data-name]');
    if (row && !fm.sel.has(row.dataset.name)) { fm.sel = new Set([row.dataset.name]); fm.anchor = row.dataset.name; fmPaintSel(fm); }
    if (!row) { fm.sel.clear(); fmPaintSel(fm); }
    fmMenu(fm, e.clientX, e.clientY, !!row);
  });
  fmDropZone(fm, fm.main, () => (fm.loc ? { loc: fm.loc, dir: fm.dir } : null));
  w.onFocus = () => { if (!w.node.contains(document.activeElement)) fm.main.focus({ preventScroll: true }); };
  w.onClose = () => dkFms.delete(fm);
  dkFms.add(fm);
  fmSide(fm);
  if (at) fmGo(fm, at.loc, at.dir); else fmRender(fm);
  dkFocus(w);
  return fm;
}

// each connected host's shares, asked once a window
async function fmSide(fm) {
  const hosts = [...dk.creds.keys()];
  const render = () => {
    const home = el('div', `fm-place fm-share${fmSame(HOME, fm.loc) ? ' here' : ''}`);
    home.append(fmIcon('dir'), el('span', '', 'home'));
    home.title = 'every host\'s home as one';
    home.addEventListener('click', () => fmGo(fm, HOME, ''));
    fmDropZone(fm, home, () => ({ loc: HOME, dir: '' }));
    const out = [home, el('div', 'fm-side-head', 'hosts')];
    for (const h of hosts) {
      const info = fm.shares.get(h);
      const hostRow = el('div', 'fm-place fm-hostrow');
      hostRow.append(fmIcon('host'), el('span', '', h));
      out.push(hostRow);
      if (!info) { out.push(el('div', 'fm-place-note', '…')); continue; }
      if (info.error) { out.push(Object.assign(el('div', 'fm-place-note bad', info.error), { title: info.error })); continue; }
      for (const loc of info.shares) {
        const row = el('div', `fm-place fm-share${fmSame(loc, fm.loc) ? ' here' : ''}`);
        row.append(fmIcon('dir'), el('span', '', loc.root));
        row.title = `${h}/${loc.root}`;
        row.addEventListener('click', () => fmGo(fm, loc, ''));
        fmDropZone(fm, row, () => ({ loc, dir: '' }));
        out.push(row);
      }
    }
    fm.side.replaceChildren(...out);
  };
  fm.renderSide = render;
  render();
  await Promise.all(hosts.map(async (h) => {
    try {
      // what the host published in sys, else asked
      const info = hostsInfo[h.toLowerCase()]?.files || await filesCall({ host: h }, 'info');
      // the home only as the merged one above
      fm.shares.set(h, info.enabled
        ? { shares: info.shares.filter((sh) => sh.id !== 'home').map((sh) => ({ host: h, share: sh.id, root: sh.label, perms: sh.perms })) }
        : { error: 'no files directory' });
    } catch (err) { fm.shares.set(h, { error: err.message }); }
    render();
  }));
  // no place yet: the home, the boot admin's first share
  if (!fm.loc) {
    const first = [...fm.shares.values()].find((i) => i.shares?.length);
    if (acct && !acct.boot) fmGo(fm, HOME, '');
    else if (first) fmGo(fm, first.shares[0], '');
  }
}

function fmGo(fm, loc, dir, how) {
  if (how !== 'history' && fm.loc) { fm.back.push({ loc: fm.loc, dir: fm.dir }); fm.fwd = []; }
  const from = fmSame(fm.loc, loc) ? fm.dir : null;
  fm.loc = loc;
  fm.dir = dir;
  fm.sel.clear();
  fm.find.value = '';
  fm.filter = '';
  // back up a level: the folder left, picked
  if (from != null && filesParent(from) === dir && from !== dir) { fm.sel.add(from.split('/').pop()); fm.anchor = from.split('/').pop(); }
  fm.entries = [];
  fm.renderSide?.();
  fmLoad(fm);
}

function fmHistory(fm, step) {
  const from = step < 0 ? fm.back : fm.fwd;
  const to = step < 0 ? fm.fwd : fm.back;
  const at = from.pop();
  if (!at) return;
  to.push({ loc: fm.loc, dir: fm.dir });
  fmGo(fm, at.loc, at.dir, 'history');
}

const fmUp = (fm) => fm.loc && fm.dir && fmGo(fm, fm.loc, filesParent(fm.dir));

async function fmLoad(fm) {
  if (!fm.loc) return fmRender(fm);
  const want = `${fm.loc.host}\n${fm.loc.share}\n${fm.dir}`;
  fm.loading = want;
  fmRender(fm);
  try {
    const body = await filesCall(fm.loc, 'list', undefined, { path: fm.dir });
    if (fm.loading !== want) return;
    fm.entries = body.entries;
    fm.error = body.truncated ? 'more entries than shown' : '';
  } catch (err) {
    if (fm.loading !== want) return;
    fm.entries = [];
    fm.error = err.message;
  }
  fm.loading = '';
  fmRender(fm);
  // files added from the desktop, into the first folder shown
  const up = fm.pendingUpload;
  if (up) { fm.pendingUpload = null; fmUpload(fm, fm.loc, fm.dir, up); }
}

// every window showing that folder, read again
function fmChanged(loc, ...dirs) {
  const same = (a) => fmSame(a, loc) || (isHome(a) && isHome(loc));
  for (const fm of dkFms) if (same(fm.loc) && dirs.includes(fm.dir)) fmLoad(fm);
  if (isHome(loc) && dkDeskDirs().some((d) => dirs.includes(d))) dkDeskLoad();
}

const fmCan = (fm, perm) => !!fm.loc && may(fm.loc, perm);

function fmSorted(fm) {
  const { key, dir } = fm.sort;
  const val = (e) => (key === 'size' ? e.size ?? -1 : key === 'mtime' ? e.mtime ?? 0 : key === 'kind' ? fmKindLabel(e) : e.name.toLowerCase());
  return fm.entries
    .filter((e) => !fm.filter || e.name.toLowerCase().includes(fm.filter))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir));
}

function fmRender(fm) {
  fm.backBtn.disabled = !fm.back.length;
  fm.fwdBtn.disabled = !fm.fwd.length;
  fm.upBtn.disabled = !fm.dir;
  fm.modeBtn.replaceChildren(dkGlyph(fm.mode === 'list' ? DK_UI.grid : DK_UI.list));
  // the path bar: host, the share, then each folder, any one a jump
  const crumbs = [];
  if (fm.loc) {
    if (fm.loc.host !== '*') crumbs.push(el('span', 'fm-crumb-host', fm.loc.host));
    const parts = fm.dir ? fm.dir.split('/') : [];
    [fm.loc.root, ...parts].forEach((name, i) => {
      const c = Object.assign(el('button', 'fm-crumb', name), { type: 'button' });
      const to = parts.slice(0, i).join('/');
      c.addEventListener('click', () => to !== fm.dir && fmGo(fm, fm.loc, to));
      fmDropZone(fm, c, () => ({ loc: fm.loc, dir: to }));
      crumbs.push(...(crumbs.length ? [el('span', 'fm-crumb-sep', '›')] : []), c);
    });
  }
  fm.crumbs.replaceChildren(...crumbs);
  fm.w.task.textContent = fm.loc ? (fm.dir.split('/').pop() || fm.loc.root) : 'files';
  fm.w.head.querySelector('.tab-label').textContent = fm.w.task.textContent;

  fm.shown = fmSorted(fm);
  const items = el('div', `fm-items fm-${fm.mode}`);
  if (fm.mode === 'list') {
    const head = el('div', 'fm-row fm-cols');
    for (const [key, label] of [['name', 'name'], ['mtime', 'modified'], ['size', 'size'], ['kind', 'kind']]) {
      const c = Object.assign(el('button', `fm-col fm-c-${key}`, label), { type: 'button' });
      if (fm.sort.key === key) c.append(el('span', 'fm-arrow', fm.sort.dir > 0 ? ' ▴' : ' ▾'));
      c.addEventListener('click', () => { fm.sort = { key, dir: fm.sort.key === key ? -fm.sort.dir : 1 }; fmRender(fm); });
      head.appendChild(c);
    }
    items.appendChild(head);
  }
  for (const e of fm.shown) items.appendChild(fmItem(fm, e));
  const note = !fm.loc ? 'pick a place' : fm.loading && !fm.entries.length ? 'loading…'
    : fm.error && !fm.entries.length ? fm.error : !fm.shown.length ? (fm.filter ? 'no match' : 'this folder is empty') : '';
  if (note) items.appendChild(el('div', 'fm-empty', note));
  fm.main.replaceChildren(items);
  fmPaintSel(fm);
}

function fmItem(fm, e) {
  const kind = fmKind(e);
  const row = el('div', fm.mode === 'list' ? 'fm-row fm-item' : 'fm-tile fm-item');
  row.dataset.name = e.name;
  row.draggable = true;
  const name = el('span', 'fm-name');
  name.append(fmIcon(kind), el('span', 'fm-label', e.name));
  // the merged home: where it lives, greyed while only an offline host has it
  if (e.hosts) {
    name.append(el('span', 'fm-where', e.all ? 'all hosts' : e.hosts.join(', ')));
    if (e.stale) { row.classList.add('fm-stale'); row.title = `on ${e.hosts.join(', ')}, offline`; }
  }
  if (fm.mode === 'list') {
    row.append(name, el('span', 'fm-c-mtime', fmDate(e.mtime)), el('span', 'fm-c-size', e.dir ? '' : humanSize(e.size || 0)), el('span', 'fm-c-kind', fmKindLabel(e)));
  } else {
    row.append(name);
    row.title = `${e.name}\n${e.dir ? 'folder' : humanSize(e.size || 0)}\n${fmDate(e.mtime)}`;
  }
  row.addEventListener('click', (ev) => fmClick(fm, e.name, ev));
  row.addEventListener('dblclick', () => fmOpen(fm, e));
  row.addEventListener('dragstart', (ev) => {
    if (!fm.sel.has(e.name)) { fm.sel = new Set([e.name]); fmPaintSel(fm); }
    dk.drag = { fm, loc: fm.loc, items: fmPicked(fm) };
    ev.dataTransfer.effectAllowed = 'copyMove';
    ev.dataTransfer.setData('text/plain', fmPicked(fm).map((p) => p.rel).join('\n'));
  });
  row.addEventListener('dragend', () => { dk.drag = null; });
  if (e.dir) fmDropZone(fm, row, () => ({ loc: fm.loc, dir: filesJoin(fm.dir, e.name) }));
  return row;
}

function fmPaintSel(fm) {
  for (const r of fm.main.querySelectorAll('.fm-item')) r.classList.toggle('sel', fm.sel.has(r.dataset.name));
  const n = fm.shown.length;
  const picked = fm.shown.filter((e) => fm.sel.has(e.name));
  const bytes = picked.reduce((t, e) => t + (e.size || 0), 0);
  fm.count.textContent = `${n} item${n === 1 ? '' : 's'}${picked.length ? `, ${picked.length} selected${bytes ? ` (${humanSize(bytes)})` : ''}` : ''}`;
}

function fmClick(fm, name, e) {
  const names = fm.shown.map((x) => x.name);
  if (e.shiftKey && fm.anchor != null && names.includes(fm.anchor)) {
    const [a, b] = [names.indexOf(fm.anchor), names.indexOf(name)].sort((x, y) => x - y);
    if (!(e.ctrlKey || e.metaKey)) fm.sel.clear();
    for (const n of names.slice(a, b + 1)) fm.sel.add(n);
  } else if (e.ctrlKey || e.metaKey) {
    if (fm.sel.has(name)) fm.sel.delete(name); else fm.sel.add(name);
    fm.anchor = name;
  } else {
    fm.sel = new Set([name]);
    fm.anchor = name;
  }
  fmPaintSel(fm);
}

// the picked entries as {rel, dir, name}
const fmPicked = (fm) => fm.shown.filter((e) => fm.sel.has(e.name)).map((e) => ({ rel: filesJoin(fm.dir, e.name), dir: e.dir, name: e.name }));

function fmOpen(fm, e) {
  const rel = filesJoin(fm.dir, e.name);
  if (e.dir && !runnable(e)) return fmGo(fm, fm.loc, rel);
  fileOpen(fm.loc, rel, e);
}

// pages, wasm and NAME.app folders run, text edits, the rest shown
const runnable = (e) => (e.dir ? /\.app$/i.test(e.name) : ['html', 'htm', 'wasm'].includes(fmExt(e.name)));
function fileOpen(loc, rel, e) {
  if (loc.host === '*' && !(e.dir && !runnable(e))) loc = homeAt(homePick(rel));
  if (runnable(e)) return dkRun(loc, rel);
  if (e.dir) return dkFiles({ loc, dir: rel });
  if (isCode(e.name)) return dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, loc.root, rel) });
  dkViewer(loc, rel);
}

// keys as a file manager's: arrows, enter, delete, f2, and the clipboard's
function fmKeys(fm, e) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  const one = fm.shown.find((x) => x.name === fm.anchor && fm.sel.has(x.name)) || fm.shown.find((x) => fm.sel.has(x.name));
  if (k === 'ArrowDown' || k === 'ArrowUp' || ((k === 'ArrowLeft' || k === 'ArrowRight') && fm.mode === 'grid' && !e.altKey)) {
    const cols = fm.mode === 'grid' ? Math.max(1, Math.floor(fm.main.clientWidth / (fm.main.querySelector('.fm-tile')?.offsetWidth || 1))) : 1;
    fmStep(fm, { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[k], e.shiftKey);
  } else if (e.altKey && k === 'ArrowLeft') fmHistory(fm, -1);
  else if (e.altKey && k === 'ArrowRight') fmHistory(fm, 1);
  else if ((e.altKey && k === 'ArrowUp') || k === 'Backspace') fmUp(fm);
  else if (k === 'Enter' && one) fmOpen(fm, one);
  else if ((k === 'Delete' || (e.metaKey && k === 'Backspace')) && fm.sel.size) fmDelete(fm);
  else if (k === 'F2' && one) fmRename(fm, one);
  else if (k === 'F5') fmLoad(fm);
  else if (mod && e.shiftKey && k.toLowerCase() === 'n') fmMkdir(fm);
  else if (mod && k.toLowerCase() === 'a') { fm.sel = new Set(fm.shown.map((x) => x.name)); fmPaintSel(fm); }
  else if (mod && k.toLowerCase() === 'c' && fm.sel.size) fmClip(fm, 'copy');
  else if (mod && k.toLowerCase() === 'x' && fm.sel.size) fmClip(fm, 'cut');
  else if (mod && k.toLowerCase() === 'v') fmPaste(fm);
  else if (mod && k.toLowerCase() === 'f') fm.find.focus();
  else if (k === 'Escape') { fm.sel.clear(); fmPaintSel(fm); }
  else if (k.length === 1 && !mod && !e.altKey) {
    // typed letters jump to the next name starting with them
    const names = fm.shown.map((x) => x.name);
    const at = names.indexOf(fm.anchor);
    const hit = [...names.slice(at + 1), ...names.slice(0, at + 1)].find((n) => n.toLowerCase().startsWith(k.toLowerCase()));
    if (hit) { fm.sel = new Set([hit]); fm.anchor = hit; fmPaintSel(fm); fmReveal(fm, hit); }
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

function fmStep(fm, by, extend) {
  const names = fm.shown.map((x) => x.name);
  if (!names.length) return;
  const at = names.indexOf(fm.anchor);
  const to = names[Math.max(0, Math.min(names.length - 1, at < 0 ? 0 : at + by))];
  if (!extend) fm.sel.clear();
  fm.sel.add(to);
  fm.anchor = to;
  fmPaintSel(fm);
  fmReveal(fm, to);
}

const fmReveal = (fm, name) => [...fm.main.querySelectorAll('.fm-item')].find((r) => r.dataset.name === name)?.scrollIntoView({ block: 'nearest' });

async function fmWallpaper(fm, rel) {
  fmSay(fm, 'setting the wallpaper…');
  try {
    const r = await fetch(filesApi(fm.loc, 'download', { path: rel }));
    if (!r.ok) throw new Error(`${r.status}`);
    const why = await dkWallSet(await r.blob());
    fmSay(fm, why || 'wallpaper set', !!why);
  } catch (err) { fmSay(fm, `wallpaper: ${err.message}`, true); }
}

// a right click's menu, on the page so no window's transform shifts it
function fmMenu(fm, x, y, onItem) {
  const picked = fmPicked(fm);
  const one = picked.length === 1 ? fm.shown.find((e) => e.name === picked[0].name) : null;
  const w = fmCan(fm, 'w');
  const items = onItem ? [
    ['open', () => one && fmOpen(fm, one), !!one],
    one && one.dir && runnable(one) && ['browse inside', () => fmGo(fm, fm.loc, picked[0].rel), true],
    one && !one.dir && ['open in editor', () => dkCode({ host: fm.loc.host, share: fm.loc.share, path: picked[0].rel, label: fileLabel(fm.loc.host, fm.loc.root, picked[0].rel) }), true],
    one && !one.dir && ['download', () => fmDownload(fm, picked[0].rel), fmCan(fm, 'r')],
    ...(one && !one.dir && fm.loc.share === 'home' ? dkRunItems(picked[0].rel, fm.loc.host === '*' ? (one.all ? homeOnline() : one.live || []) : [fm.loc.host]) : []),
    one && fmKind(one) === 'image' && ['set as wallpaper', () => fmWallpaper(fm, picked[0].rel), fmCan(fm, 'r')],
    one && !one.dir && one.hosts && ['keep on every host', () => fmMirror(fm, one, !one.all), true, one.all ? 'on' : ''],
    one && !one.dir && one.hosts && !one.all && ['move to host…', () => fmMoveHost(fm, one), homeOnline().length > 1],
    null,
    ['cut', () => fmClip(fm, 'cut'), fmCan(fm, 'd')],
    ['copy', () => fmClip(fm, 'copy'), true],
    ['paste', () => fmPaste(fm, one?.dir ? picked[0].rel : fm.dir), !!dk.clip && w],
    null,
    ['rename', () => fmRename(fm, one), !!one && w],
    ['delete', () => fmDelete(fm), fmCan(fm, 'd'), 'danger'],
  ] : [
    ['new folder', () => fmMkdir(fm), w],
    ['new text file', () => fmTouch(fm), w],
    ['upload here', () => fm.input.click(), w],
    null,
    ['paste', () => fmPaste(fm), !!dk.clip && w],
    ['select all', () => { fm.sel = new Set(fm.shown.map((e) => e.name)); fmPaintSel(fm); }, true],
    ['refresh', () => fmLoad(fm), true],
  ];
  dkMenu(x, y, items.filter((i) => i !== false && i !== undefined), () => fm.main.focus({ preventScroll: true }));
}

// a home file kept on every host, or back to only the one it's read from
async function fmMirror(fm, e, on) {
  const rel = filesJoin(fm.dir, e.name);
  const host = homePick(rel);
  if (!on) {
    const keep = await dkChoose(fm, { title: 'keep it only on', message: e.name, options: homeOnline().map((h) => [h, h]) });
    if (!keep) return;
    try { await filesCall(homeAt(keep), 'mirror', jsonPost({ path: rel, on: false })); } catch (err) { return fmSay(fm, err.message, true); }
    fmSay(fm, `${e.name} kept on ${keep}, the other copies going`);
  } else {
    try { await filesCall(homeAt(host), 'mirror', jsonPost({ path: rel, on: true })); } catch (err) { return fmSay(fm, err.message, true); }
    fmSay(fm, `${e.name} copying to every host`);
  }
  setTimeout(() => fmChanged(HOME, fm.dir), 4000);
  fmChanged(HOME, fm.dir);
}

// the bytes to one host, then off the rest
async function fmMoveHost(fm, e) {
  const rel = filesJoin(fm.dir, e.name);
  const to = await dkChoose(fm, { title: 'move to', message: `${e.name}, now on ${e.hosts.join(', ')}`, options: homeOnline().map((h) => [h, h, e.hosts.includes(h) && e.hosts.length === 1 ? 'already there' : '']) });
  if (!to) return;
  try {
    const from = homePick(rel);
    if (from !== to) await copyFile(homeAt(from), rel, homeAt(to), rel, (f) => fmSay(fm, `moving ${e.name} ${Math.round(f * 100)}%`));
    for (const h of homeHolders(rel)) if (h !== to) await filesCall(homeAt(h), 'delete', jsonPost({ path: rel }));
    fmSay(fm, `${e.name} moved to ${to}`);
  } catch (err) { fmSay(fm, err.message, true); }
  fmChanged(HOME, fm.dir);
}

const dkMenuEl = el('div', 'dk-menu');
dkMenuEl.hidden = true;
dkMenuEl.setAttribute('role', 'menu');
document.body.appendChild(dkMenuEl);
function dkMenu(x, y, items, after, title) {
  if (dkMenuEl.owner && dkMenuEl.hidden) dkMenuEl.owner = null;
  dkMenuEl.classList.remove('dk-pop');
  dkMenuEl.dkAnchor = null;
  dkMenuEl.style.bottom = '';
  dkMenuEl.replaceChildren(...(title ? [el('div', 'dk-menu-title', title)] : []), ...items.map((it) => {
    if (!it) return el('div', 'dk-menu-sep');
    const [label, act, ok, cls] = it;
    const b = Object.assign(el('button', cls || '', label), { type: 'button', disabled: !ok });
    b.addEventListener('click', () => { dkMenuEl.hidden = true; after?.(); act(); });
    return b;
  }));
  dkMenuEl.hidden = false;
  dkMenuEl.style.left = `${Math.min(x, innerWidth - dkMenuEl.offsetWidth - 4)}px`;
  dkMenuEl.style.top = `${Math.min(y, innerHeight - dkMenuEl.offsetHeight - 4)}px`;
}
document.addEventListener('pointerdown', (e) => { if (!dkMenuEl.contains(e.target)) dkMenuEl.hidden = true; }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dkMenuEl.hidden = true; }, true);
addEventListener('blur', () => { dkMenuEl.hidden = true; });

// a question inside the window: text back, true for a yes, null for no
function dkAsk(fm, { title, message, value, action, danger }) {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil');
    const box = el('form', 'fm-ask');
    const input = value != null && Object.assign(el('input'), { value, spellcheck: false, autocomplete: 'off' });
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    const go = Object.assign(el('button', danger ? 'danger' : 'primary', action), { type: 'submit' });
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    box.append(el('div', 'fm-ask-title', title), el('p', '', message), ...(input ? [input] : []), acts);
    veil.appendChild(box);
    fm.w.body.appendChild(veil);
    const end = (v) => { veil.remove(); fm.main.focus({ preventScroll: true }); resolve(v); };
    no.addEventListener('click', () => end(null));
    box.addEventListener('submit', (e) => { e.preventDefault(); end(input ? input.value.trim() || null : true); });
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') end(null); });
    if (input) {
      input.focus();
      // the name picked, not its extension
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    } else go.focus();
  });
}

// one of a few choices inside the window, its value back, null for none;
// [label, value, why disabled]
function dkChoose(fm, { title, message, options }) {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil');
    const box = el('div', 'fm-ask');
    const list = el('div', 'fm-choices');
    const end = (v) => { veil.remove(); fm.main.focus({ preventScroll: true }); resolve(v); };
    for (const [label, value, why] of options) {
      const b = Object.assign(el('button', 'fm-choice', label), { type: 'button', disabled: !!why });
      if (why) b.append(el('span', 'fm-choice-why', why));
      b.addEventListener('click', () => end(value));
      list.appendChild(b);
    }
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    no.addEventListener('click', () => end(null));
    const acts = el('div', 'update-actions');
    acts.append(no);
    box.append(el('div', 'fm-ask-title', title), el('p', '', message), list, acts);
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') end(null); });
    veil.appendChild(box);
    fm.w.body.appendChild(veil);
    list.querySelector('button:not(:disabled)')?.focus();
  });
}

const fmSay = (fm, text, bad) => {
  fm.note.textContent = text || '';
  fm.note.classList.toggle('bad', !!bad);
  clearTimeout(fm.noteTimer);
  if (text && !fm.busy) fm.noteTimer = setTimeout(() => { if (fm.note.textContent === text) fm.note.textContent = ''; }, 6000);
};

async function fmMkdir(fm) {
  if (!fmCan(fm, 'w')) return fmSay(fm, 'this share is read-only', true);
  const name = await dkAsk(fm, { title: 'new folder', message: `in ${filesPath(fm.loc.host, fm.loc.root, fm.dir)}`, value: 'new folder', action: 'create' });
  if (!name) return;
  try {
    await filesCall(fm.loc, 'mkdir', jsonPost({ path: filesJoin(fm.dir, name) }));
    fm.sel = new Set([name]);
    fm.anchor = name;
    fmChanged(fm.loc, fm.dir);
  } catch (err) { fmSay(fm, err.message, true); }
}

// an empty file, then the editor on it
async function fmTouch(fm) {
  const name = await dkAsk(fm, { title: 'new text file', message: `in ${filesPath(fm.loc.host, fm.loc.root, fm.dir)}`, value: 'untitled.txt', action: 'create' });
  if (!name) return;
  const rel = filesJoin(fm.dir, name);
  if (fm.entries.some((e) => e.name === name)) return fmSay(fm, `${name} is already here`, true);
  let loc = fm.loc;
  let all = false;
  if (loc.host === '*') {
    const t = await homeTarget(fm, 0, name);
    if (!t) return;
    loc = homeAt(t.host);
    all = t.all;
  }
  try {
    await putFile(loc, rel, new Blob([]));
    if (all) await filesCall(loc, 'mirror', jsonPost({ path: rel, on: true }));
    fmChanged(loc, fm.dir);
    dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, loc.root, rel) });
  } catch (err) { fmSay(fm, err.message, true); }
}

async function fmRename(fm, e) {
  const name = await dkAsk(fm, { title: 'rename', message: filesPath(fm.loc.host, fm.loc.root, filesJoin(fm.dir, e.name)), value: e.name, action: 'rename' });
  if (!name || name === e.name) return;
  try {
    await filesCall(fm.loc, 'rename', jsonPost({ from: filesJoin(fm.dir, e.name), to: filesJoin(fm.dir, name) }));
    fm.sel = new Set([name]);
    fm.anchor = name;
    fmChanged(fm.loc, fm.dir);
  } catch (err) { fmSay(fm, err.message, true); }
}

async function fmDelete(fm) {
  const picked = fmPicked(fm);
  if (!picked.length) return;
  const what = picked.length === 1 ? `${picked[0].name}${picked[0].dir ? ' and everything in it' : ''}` : `these ${picked.length} items`;
  const ok = await dkAsk(fm, { title: 'delete', message: `delete ${what}? this cannot be undone.`, action: 'delete', danger: true });
  if (!ok) return;
  const loc = fm.loc;
  const dir = fm.dir;
  for (const p of picked) {
    try { await filesCall(loc, 'delete', jsonPost({ path: p.rel })); } catch (err) { fmSay(fm, `${p.name}: ${err.message}`, true); }
  }
  fm.sel.clear();
  fmChanged(loc, dir);
}

function fmDownload(fm, rel) {
  const a = Object.assign(document.createElement('a'), { href: filesApi(fm.loc, 'download', { path: rel }), download: rel.split('/').pop() });
  a.click();
}

function fmClip(fm, op) {
  dk.clip = { op, loc: fm.loc, items: fmPicked(fm) };
  fmSay(fm, `${dk.clip.items.length} ${op === 'cut' ? 'cut' : 'copied'}, paste with ctrl+v`);
}

async function fmPaste(fm, dir = fm.dir) {
  const clip = dk.clip;
  if (!clip || !fm.loc) return;
  if (clip.op === 'cut') dk.clip = null;
  await fmTransfer(fm, clip.loc, clip.items, fm.loc, dir, clip.op === 'cut');
}

// inside one share a move is a rename, anything else bytes through the page,
// a move's source deleted once its copy is whole
async function fmTransfer(fm, from, items, to, dir, move) {
  if (!may(to, 'w')) return fmSay(fm, `${to.root} is read-only`, true);
  // into the home, other than a move inside it: where the copies go; every
  // host's a folder copied to each, a file kept in step
  let all = false;
  let alsoTo = [];
  if (to.host === '*' && !(move && fmSame(from, to))) {
    const t = await homeTarget(fm, items.some((it) => it.dir) ? 0 : 1, items.length === 1 ? items[0].name : `${items.length} items`);
    if (!t) return;
    all = t.all;
    if (all) alsoTo = homeOnline().filter((h) => h !== t.host).map(homeAt);
    to = homeAt(t.host);
  }
  const label = move ? 'moving' : 'copying';
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dst = filesJoin(dir, it.name);
    if (fmSame(from, to) && (dst === it.rel || `${dir}/`.startsWith(`${it.rel}/`))) {
      if (move || it.dir) { failed += 1; fmSay(fm, `${it.name} can't go inside itself`, true); continue; }
    }
    const tick = (f, child) => { fm.busy = 'x'; fmSay(fm, `${label} ${child || it.name} ${Math.round(f * 100)}% (${i + 1}/${items.length})`); };
    try {
      if (move && fmSame(from, to)) {
        await filesCall(to, 'rename', jsonPost({ from: it.rel, to: dst }));
      } else {
        // a copy into its own folder, as a file manager's: "name copy.ext"
        let target = dst;
        if (fmSame(from, to) && filesParent(it.rel) === dir) {
          const x = it.dir ? '' : fmExt(it.name);
          target = filesJoin(dir, x ? `${it.name.slice(0, -x.length - 1)} copy.${x}` : `${it.name} copy`);
        }
        if (it.dir) {
          await copyTree(from, it.rel, to, target, tick);
          for (const other of alsoTo) await copyTree(from, it.rel, other, target, tick);
        } else {
          await copyFile(from, it.rel, to, target, tick);
          if (all) await filesCall(to, 'mirror', jsonPost({ path: target, on: true }));
        }
        if (move) await filesCall(from, 'delete', jsonPost({ path: it.rel }));
      }
    } catch (err) { failed += 1; fm.busy = ''; fmSay(fm, `${it.name}: ${err.message}`, true); }
  }
  fm.busy = '';
  if (!failed) fmSay(fm, `${move ? 'moved' : 'copied'} ${items.length} to ${filesPath(to.host, to.root, dir)}`);
  fmChanged(to, dir);
  if (move) fmChanged(from, ...new Set(items.map((it) => filesParent(it.rel))));
}

async function fmUpload(fm, loc, dir, fileList) {
  const list = [...fileList];
  if (!list.length || !loc) return;
  if (!may(loc, 'w')) return fmSay(fm, `${loc.root} is read-only`, true);
  let all = false;
  if (loc.host === '*') {
    const bytes = list.reduce((t, f) => Math.max(t, f.size), 0);
    const t = await homeTarget(fm, bytes, list.length === 1 ? list[0].name : `${list.length} files`);
    if (!t) return;
    loc = homeAt(t.host);
    all = t.all;
  }
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    try {
      fm.busy = 'x';
      await putFile(loc, filesJoin(dir, f.name), f, (sent) => fmSay(fm, `uploading ${f.name} ${f.size ? Math.round((sent / f.size) * 100) : 100}% (${i + 1}/${list.length})`));
      if (all) await filesCall(loc, 'mirror', jsonPost({ path: filesJoin(dir, f.name), on: true }));
    } catch (err) { fm.busy = ''; fmSay(fm, `${f.name}: ${err.message}`, true); }
  }
  fm.busy = '';
  fmSay(fm, `uploaded ${list.length} to ${filesPath(loc.host, loc.root, dir)}`);
  fmChanged(loc, dir);
}

// a folder or place held under a drag this long: opened, the drag going on
const FM_SPRING_MS = 700;
function fmSpring(fm, node, t) {
  if (fm.spring?.node === node) return;
  clearTimeout(fm.spring?.timer);
  fm.spring = null;
  if (fmSame(t.loc, fm.loc) && t.dir === fm.dir) return;
  fm.spring = { node, timer: setTimeout(() => { fm.spring = null; node.classList.remove('drop'); fmGo(fm, t.loc, t.dir); }, FM_SPRING_MS) };
}
function fmUnspring(fm, node) {
  if (node && fm.spring?.node !== node) return;
  clearTimeout(fm.spring?.timer);
  fm.spring = null;
}

// every drop zone's window and target, for the desktop's own icon drags
const fmZones = new WeakMap();
function fmMark(fm, node) {
  for (const root of [fm.main, fm.side]) root?.querySelectorAll('.drop').forEach((x) => x !== node && x.classList.remove('drop'));
  node?.classList.add('drop');
}

// a folder, a place or blank space taking a drag: the computer's own files
// uploaded, a window's moved inside one share or copied (ctrl) across them
function fmDropZone(fm, node, where) {
  fmZones.set(node, { fm, where });
  node.dataset.fmDrop = '';
  node.addEventListener('dragover', (e) => {
    const t = where();
    if (!t || (!dk.drag && !e.dataTransfer.types.includes('Files'))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dk.drag && fmSame(dk.drag.loc, t.loc) && !e.ctrlKey && !e.altKey ? 'move' : 'copy';
    fmMark(fm, node);
    fmSpring(fm, node, t);
  });
  node.addEventListener('dragleave', (e) => {
    if (node.contains(e.relatedTarget)) return;
    node.classList.remove('drop');
    fmUnspring(fm, node);
  });
  node.addEventListener('drop', (e) => {
    const t = where();
    fmUnspring(fm);
    node.classList.remove('drop');
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const drag = dk.drag;
    dk.drag = null;
    if (drag) {
      const items = drag.items.filter((it) => !(fmSame(drag.loc, t.loc) && it.rel === t.dir));
      if (items.length) fmTransfer(fm, drag.loc, items, t.loc, t.dir, fmSame(drag.loc, t.loc) && !e.ctrlKey && !e.altKey);
    } else fmUpload(fm, t.loc, t.dir, e.dataTransfer.files);
  });
}

// anything the browser shows itself: pictures, video, sound, pdfs, else its text
function dkViewer(loc, rel) {
  const w = dkWin(`view:${loc.host}\n${loc.share}\n${rel}`, rel.split('/').pop(), loc.host, 'svc');
  if (!w) return;
  const src = filesApi(loc, 'download', { path: rel, inline: 1 });
  // a picture fit to the window, a click for its own size and back
  if (fmKind({ name: rel }) === 'image') {
    const box = el('div', 'dk-imgview');
    const img = Object.assign(el('img'), { src, alt: rel, draggable: false });
    box.addEventListener('click', () => box.classList.toggle('full'));
    box.appendChild(img);
    w.body.appendChild(box);
    dkFocus(w);
    return;
  }
  const frame = Object.assign(el('iframe', 'dk-frame'), { src, title: rel });
  w.body.appendChild(frame);
  w.onClose = () => { frame.src = 'about:blank'; };
  dkFocus(w);
}

// --- the desktop's files: the user's own Desktop and shared/Desktop, each
// over the merged home, from every host

const dkDeskDirs = () => (acct && !acct.boot ? [`${acct.user}/Desktop`, 'shared/Desktop'] : []);
// where a drop lands: the user's own
const dkDeskAt = () => (acct && !acct.boot && selfHost ? { loc: HOME, dir: `${acct.user}/Desktop` } : null);

// read again whenever the serving host or the user changes
function dkDeskWatch() {
  const key = dkDeskAt() ? `${selfHost}\n${acct.user}` : '';
  if (key === dk.deskKey) return;
  dk.deskKey = key;
  dk.deskFiles = [];
  if (key) dkDeskLoad();
}

async function dkDeskLoad() {
  if (!dkDeskAt()) return;
  const key = dk.deskKey;
  // a folder no host answered for: its last icons kept, never blinking out
  const lists = await Promise.all(dkDeskDirs().map((dir) => homeList(dir)
    .then((b) => b.entries.map((e) => ({ ...e, at: dir })), () => dk.deskFiles.filter((e) => e.at === dir))));
  if (key !== dk.deskKey) return;
  dk.deskFiles = lists.flat();
  dkIcons();
}

// an .app folder's own icon, the first of these it holds
const DK_APP_ICONS = ['icon.svg', 'icon.png', 'favicon.svg', 'favicon.png', 'favicon.ico'];

// a long name cut in its middle, its extension always shown
const DK_NAME_MAX = 24;
function dkShort(n) {
  if (n.length <= DK_NAME_MAX) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 && n.length - dot <= 8 ? n.slice(dot) : '';
  return `${n.slice(0, DK_NAME_MAX - ext.length - 1)}…${ext}`;
}

function dkFileIcon(e) {
  const rel = filesJoin(e.at, e.name);
  const kind = runnable(e) ? 'app' : fmKind(e);
  const pic = kind === 'image' && !e.stale ? filesApi(HOME, 'download', { path: rel, inline: 1 })
    : kind === 'app' && e.dir && !e.stale ? DK_APP_ICONS.map((n) => filesApi(homeAt(e.live?.includes(selfHost) ? selfHost : e.live?.[0] || selfHost), 'download', { path: `${rel}/${n}`, inline: 1 })) : '';
  // under it: shared, and the host unless it's everywhere or here alone
  const where = e.all ? '' : e.hosts.length === 1 && e.hosts[0] === selfHost ? '' : e.hosts.join(', ');
  const sub = [e.at.startsWith('shared/') ? 'shared' : '', where].filter(Boolean).join(' · ');
  const b = dkIcon('doc', dkShort(e.name.replace(/\.app$/i, '')), sub, () => fileOpen(HOME, rel, e), pic);
  const tile = b.querySelector('.dk-tile');
  if (!pic || kind === 'app') tile.replaceChildren(kind === 'app' ? dkGlyph(DK_GLYPHS.app, 'fm-app') : fmIcon(kind));
  b.classList.add(`dk-doc-${kind}`);
  if (e.stale) b.classList.add('dk-stale');
  b.dataset.file = rel;
  // placed by its path, whatever its label says
  b.dataset.id = `doc\n${rel}`;
  b.title = e.stale ? `${e.name}, on ${e.hosts.join(', ')}, offline` : e.name;
  return b;
}

// a source file built or run in a terminal on a host the user has a login
// for, its build out of the home in a temp dir; $f the file, $o the program
const DK_RUNNERS = {
  c: 'cc "$f" -o "$o" && "$o"', cpp: 'c++ "$f" -o "$o" && "$o"', cc: 'c++ "$f" -o "$o" && "$o"', cxx: 'c++ "$f" -o "$o" && "$o"',
  rs: 'rustc "$f" -o "$o" && "$o"', go: 'go run "$f"', zig: 'zig run "$f"', java: 'java "$f"', swift: 'swift "$f"',
  py: 'python3 "$f"', js: 'node "$f"', mjs: 'node "$f"', ts: 'npx --yes tsx "$f"', sh: 'bash "$f"', bash: 'bash "$f"',
  rb: 'ruby "$f"', pl: 'perl "$f"', php: 'php "$f"', lua: 'lua "$f"', hs: 'runghc "$f"', r: 'Rscript "$f"',
};
const shQuote = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
// the home on a host as its own shell sees it, none on a Windows one
function dkHomeOn(host) {
  const home = hostsInfo[host.toLowerCase()]?.files?.shares?.find((x) => x.home)?.label || '';
  return home.startsWith('/') && !home.startsWith('/run/desktop/') ? home : '';
}
// one "run on" per host holding the file whose login is saved
function dkRunItems(rel, hosts) {
  const runner = DK_RUNNERS[fmExt(rel)];
  if (!runner) return [];
  return hosts.filter((h) => dk.creds.has(h) && dkHomeOn(h)).map((h) => [`run on ${h}`, () => {
    const stem = rel.split('/').pop().replace(/\.[^.]+$/, '') || 'a.out';
    dkTerminal(h, `f=${shQuote(`${dkHomeOn(h)}/${rel}`)}; o="$(mktemp -d)"/${shQuote(stem)}; cd "$(dirname "$f")" && ${runner}`);
  }, true]);
}

function dkFileMenu(e) {
  const rel = filesJoin(e.at, e.name);
  const loc = homeAt(homePick(rel));
  return [
    ['open', () => fileOpen(HOME, rel, e), !e.stale],
    e.dir && ['show in files', () => dkFiles({ loc: HOME, dir: rel }), true],
    !e.dir && ['open in editor', () => dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, 'home', rel) }), !e.stale],
    !e.dir && ['download', () => { location.href = filesApi(loc, 'download', { path: rel }); }, !e.stale],
    ...(e.dir ? [] : dkRunItems(rel, e.all ? homeOnline() : e.live || [])),
    null,
    ['show in files', () => dkFiles({ loc: HOME, dir: e.at }), true],
    ['delete', async () => {
      try { await filesCall(HOME, 'delete', jsonPost({ path: rel })); } catch (err) { dkMenuNote(err.message); }
      fmChanged(HOME, e.at);
    }, !e.stale, 'danger'],
  ].filter((i) => i !== false);
}

// --- running: a page, a NAME.app folder's index.html, or a .wasm, sandboxed
// in a window, off this origin, its files through a sealed run link

const RUN_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';

async function dkRun(loc, rel) {
  const name = rel.split('/').pop();
  let got;
  try { got = await filesCall(loc, 'run', jsonPost({ path: rel })); } catch (err) { dkMenuNote(err.message); return; }
  const w = dkWin(`run:${loc.host}\n${loc.share}\n${rel}`, name.replace(/\.app$/i, ''), loc.host, 'svc');
  if (!w) return;
  const url = new URL(got.url, location.origin).href;
  const frame = Object.assign(el('iframe', 'dk-frame'), { title: name, allow: 'fullscreen; clipboard-write; autoplay; gamepad' });
  frame.setAttribute('sandbox', RUN_SANDBOX);
  if (got.kind === 'wasm') frame.srcdoc = wasiPage(url, name);
  else {
    frame.src = url;
    const pop = Object.assign(el('button', 'dk-pop'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
    pop.appendChild(dkGlyph(DK_UI.pop));
    pop.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    w.head.querySelector('.dk-btns').prepend(pop);
  }
  w.body.appendChild(frame);
  w.onClose = () => { frame.src = 'about:blank'; };
  dkFocus(w);
}

// a console for a wasi command: stdout and stderr shown, a line of stdin
// typed, any import it wants past wasi stubbed
function wasiPage(url, name) {
  const run = (url, name) => {
    const out = document.getElementById('out');
    const say = (t, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = t; out.append(s); scrollTo(0, document.body.scrollHeight); };
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    let mem;
    let stdin = new Uint8Array(0);
    class Exit { constructor(code) { this.code = code; } }
    const dv = () => new DataView(mem.buffer);
    const u8 = () => new Uint8Array(mem.buffer);
    const args = [name];
    const env = ['TERM=dumb'];
    const strs = (list, ptrs, buf) => {
      let at = buf;
      list.forEach((s, i) => { const b = enc.encode(`${s}\0`); dv().setUint32(ptrs + i * 4, at, true); u8().set(b, at); at += b.length; });
      return 0;
    };
    const sizes = (list, n, sz) => { dv().setUint32(n, list.length, true); dv().setUint32(sz, list.reduce((t, s) => t + enc.encode(s).length + 1, 0), true); return 0; };
    const wasi = {
      args_get: (p, b) => strs(args, p, b), args_sizes_get: (n, s) => sizes(args, n, s),
      environ_get: (p, b) => strs(env, p, b), environ_sizes_get: (n, s) => sizes(env, n, s),
      clock_res_get: (id, p) => { dv().setBigUint64(p, 1000n, true); return 0; },
      clock_time_get: (id, prec, p) => { dv().setBigUint64(p, BigInt(Math.round((id === 0 ? Date.now() : performance.now()) * 1e6)), true); return 0; },
      fd_write: (fd, iovs, n, wrote) => {
        let t = 0;
        for (let i = 0; i < n; i++) {
          const p = dv().getUint32(iovs + i * 8, true);
          const l = dv().getUint32(iovs + i * 8 + 4, true);
          if (fd === 1 || fd === 2) say(dec.decode(u8().slice(p, p + l), { stream: true }), fd === 2 ? 'err' : '');
          t += l;
        }
        dv().setUint32(wrote, t, true);
        return fd === 1 || fd === 2 ? 0 : 8;
      },
      fd_read: (fd, iovs, n, read) => {
        if (fd !== 0) return 8;
        let t = 0;
        for (let i = 0; i < n && stdin.length; i++) {
          const p = dv().getUint32(iovs + i * 8, true);
          const l = Math.min(dv().getUint32(iovs + i * 8 + 4, true), stdin.length);
          u8().set(stdin.subarray(0, l), p);
          stdin = stdin.subarray(l);
          t += l;
        }
        dv().setUint32(read, t, true);
        return 0;
      },
      fd_fdstat_get: (fd, p) => { if (fd > 2) return 8; u8().fill(0, p, p + 24); dv().setUint8(p, 2); return 0; },
      fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8, fd_close: () => 0, fd_seek: () => 70, fd_sync: () => 0,
      path_open: () => 76, random_get: (p, l) => { crypto.getRandomValues(u8().subarray(p, p + l)); return 0; },
      sched_yield: () => 0, poll_oneoff: () => 52,
      proc_exit: (code) => { throw new Exit(code); },
    };
    // past wasi: functions answering ENOSYS, a memory or table where one's asked
    const fill = (i) => (i.kind === 'function' ? (i.module === 'wasi_snapshot_preview1' && wasi[i.name]) || (() => 52)
      : i.kind === 'memory' ? new WebAssembly.Memory({ initial: 256, maximum: 32768 })
        : i.kind === 'table' ? new WebAssembly.Table({ initial: 4096, element: 'anyfunc' }) : undefined);
    const start = async () => {
      out.textContent = '';
      try {
        const mod = await WebAssembly.compile(await (await fetch(url)).arrayBuffer());
        const real = {};
        for (const i of WebAssembly.Module.imports(mod)) (real[i.module] ||= {})[i.name] = fill(i);
        const inst = await WebAssembly.instantiate(mod, real);
        mem = inst.exports.memory || Object.values(real).flatMap(Object.values).find((v) => v instanceof WebAssembly.Memory);
        const main = inst.exports._start || inst.exports.main;
        if (!main) { say('no _start or main to run\n', 'err'); return; }
        const r = main();
        say(`\n[exited ${typeof r === 'number' ? r : 0}]\n`, 'dim');
      } catch (e) {
        if (e instanceof Exit) say(`\n[exited ${e.code}]\n`, 'dim');
        else say(`\n${e}\n`, 'err');
      }
    };
    document.getElementById('in').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      stdin = enc.encode(`${e.target.value}\n`);
      e.target.value = '';
      start();
    });
    start();
  };
  const css = getComputedStyle(document.documentElement);
  const fg = css.getPropertyValue('--fg').trim() || '#ddd';
  const bg = css.getPropertyValue('--bg').trim() || '#111';
  const esc = (v) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:.6rem;background:${bg};color:${fg};font:13px ui-monospace,monospace}
#out{white-space:pre-wrap;margin:0 0 2rem}.err{color:#e57373}.dim{opacity:.6}
#in{position:fixed;left:0;right:0;bottom:0;box-sizing:border-box;width:100%;padding:.4rem .6rem;border:0;border-top:1px solid #8884;background:${bg};color:${fg};font:inherit;outline:0}
</style><pre id="out"></pre><input id="in" placeholder="stdin, enter reruns with it" autocomplete="off">
<script>(${run})(${esc(url)}, ${esc(name)});<\/script>`;
}

// --- the editor: the code tab's own editor, in a window

// whether a file is still where it was: its folder listed, it in it
async function fileThere(f) {
  try {
    const body = await filesCall({ host: f.host, share: String(f.share ?? '') }, 'list', undefined, { path: filesParent(f.path) });
    return body.entries.some((e) => e.name === f.path.split('/').pop() && !e.dir);
  } catch { return false; }
}

// a file to edit, refused with a note when it's gone
async function dkCode(f) {
  if (!(await fileThere(f))) { dkMenuNote(`${f.path.split('/').pop()} is gone`); return; }
  dkCodeNow(f);
}

function dkCodeNow(f) {
  const file = { host: f.host, share: String(f.share ?? ''), path: f.path, label: f.label || `${f.host}/${f.path}` };
  rememberFile(file);
  if (!dk.desk) return;
  const w = dkWin(`code:${codeKey(file)}`, codeName(file), file.host, 'code');
  if (!w) return;
  const id = `code-${codeSeq += 1}`;
  const ed = codeEditor(w.body, file, w.node, id);
  editors.set(id, ed);
  codeTabs.set(codeKey(file), id);
  // the file the chat's models take "this file" to mean
  w.onFocus = () => {
    if (!w.body.contains(document.activeElement)) ed.focus();
    seenEditor = id;
    paintSeen();
  };
  w.holdClose = () => ed.holdClose();
  w.onClose = () => ed.close();
  dkFocus(w);
}

// the editor's launcher: recent files, or a file manager to pick one
function dkEditorPick() {
  const w = dkWin('editor', 'editor', '', 'pick');
  if (!w) return;
  const list = el('ul', 'dk-recent');
  const recent = loadJsonSafe(RECENT_FILES_KEY).filter((f) => f && f.host && f.path && dk.creds.has(f.host));
  for (const f of recent) {
    const li = Object.assign(el('li'), { tabIndex: 0 });
    li.append(fmIcon(isCode(f.path) ? 'code' : 'file'), el('span', 'fm-label', f.label || `${f.host}/${f.path}`));
    const open = () => { dkClose(w); dkCode(f); };
    li.addEventListener('click', open);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    list.appendChild(li);
  }
  if (!recent.length) list.appendChild(el('li', 'empty', 'no recent files'));
  const browse = Object.assign(el('button', 'primary', 'browse files'), { type: 'button' });
  browse.addEventListener('click', () => { dkClose(w); dkFiles(); });
  const acts = el('div', 'update-actions');
  acts.appendChild(browse);
  w.body.append(el('div', 'dk-pick-head', 'recent'), list, el('p', 'dk-note', 'double click a text file in files to edit it, or right click a folder for a new one'), acts);
  w.w = Math.min(w.w, 460);
  w.h = Math.min(w.h, 340);
  dkPlace(w);
  dkFocus(w);
}

function dkService(r) {
  const w = dkWin(`svc:${serviceKey(r)}`, r.name, r.host, 'svc');
  if (!w) return;
  const url = serviceUrl(r);
  const pop = Object.assign(el('button', 'dk-pop'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
  pop.appendChild(dkGlyph(DK_UI.pop));
  pop.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  w.head.querySelector('.dk-btns').prepend(pop);
  const frame = Object.assign(el('iframe', 'dk-frame'), { src: url, title: r.name, allow: 'clipboard-read; clipboard-write; fullscreen' });
  w.body.appendChild(frame);
  // lit on the mesh graph as an open tab of it would be
  const conn = { win: { closed: false }, host: r.host, name: r.name };
  activeConnections.set(serviceKey(r), conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
  w.onClose = () => { conn.win.closed = true; frame.src = 'about:blank'; };
  dkFocus(w);
}

// --- the mesh's own apps: each old tab's view moved into a window, back on close

const DK_APPS = {
  chat: { title: 'chat', view: 'view-chat', w: 880, h: 560 },
  status: { title: 'status', view: 'view-status', w: 920, h: 600 },
  projects: { title: 'projects', view: 'view-projects', w: 920, h: 580 },
  about: { title: 'about', view: 'view-about', w: 700, h: 420 },
  games: { title: 'game servers', view: 'view-games', w: 460, h: 420 },
};

// a fresh window's size, centered, a phone's left filling the desk
function dkSize(w, width, height) {
  if (w.snap) return;
  const W = dk.desk.wins.clientWidth;
  const H = dk.desk.wins.clientHeight;
  w.w = Math.min(width, W - 24);
  w.h = Math.min(height, H - 24);
  // centered, each next one stepped down and right
  const step = (dk.n % 6) * 26;
  w.x = Math.max(0, Math.min(W - w.w, Math.round((W - w.w) / 2) - 65 + step));
  w.y = Math.max(0, Math.min(H - w.h, Math.round((H - w.h) / 3) - 65 + step));
  dkPlace(w);
}

function dkOpenApp(id) {
  if (!dk.desk) return;
  if (id === 'git') { dkGit(); return; }
  const app = DK_APPS[id];
  const w = app && dkWin(`app:${id}`, app.title, '', `app dk-app-${id}`);
  if (!w) return;
  const view = document.getElementById(app.view);
  view.classList.add('active');
  w.body.appendChild(view);
  dkSize(w, app.w, app.h);
  const fit = new ResizeObserver(() => { if (id === 'status') statusDraw(); });
  fit.observe(w.body);
  w.onClose = () => {
    fit.disconnect();
    view.classList.remove('active');
    paneContent.appendChild(view);
  };
  if (id === 'chat') {
    w.task.appendChild(dkBadge());
    w.onFocus = () => { if (!w.body.contains(document.activeElement)) (joined() ? chatText : chatName).focus({ preventScroll: true }); };
  }
  dkFocus(w);
}

// which apps are up, each view's watcher told of a change
function dkAppsChanged() {
  const was = new Set(deskApps);
  deskApps.clear();
  for (const id of [...Object.keys(DK_APPS), 'git']) {
    const w = dk.wins.get(`app:${id}`);
    if (w && !w.node.hidden && !w.leaving) deskApps.add(id);
  }
  const up = (id) => deskApps.has(id) && !was.has(id);
  if (deskApps.has('projects') !== was.has('projects')) pjWatch(deskApps.has('projects'));
  if (up('status')) statusWatch();
  // the conversation's news read once it's on screen
  if (up('chat')) setConv(conv);
}

function deskBadge(total) {
  deskNews = total;
  for (const b of document.querySelectorAll('.dk-badge')) {
    b.hidden = !total;
    b.textContent = total > 99 ? '99+' : String(total);
  }
}
function dkBadge() {
  const b = el('span', 'dk-badge', deskNews > 99 ? '99+' : String(deskNews));
  b.hidden = !deskNews;
  return b;
}

// a shell from the chat or phosphorus, on a host this desktop is logged into
function dkOpenTerminal(host) {
  if (dk.desk && dk.creds.has(host)) dkTerminal(host);
}

// phosphorus's presses, each the app it names
const DK_VIEWS = { status: 'status', about: 'about', projects: 'projects', chat: 'chat', git: 'git', games: 'games', home: 'games' };
function dkPressed(a) {
  if (a.kind === 'terminal') dkOpenTerminal(a.host);
  else if (a.kind === 'host' && phosphorusHosts().includes(a.host)) switchHost(a.host);
  else if (a.kind === 'code' && a.host && a.path) { if (dk.desk) dkCode({ host: a.host, share: a.share, path: a.path }); }
  else if (a.kind === 'view') {
    if (a.view === 'chat') openConv('mesh');
    else if (DK_VIEWS[a.view]) dkOpenApp(DK_VIEWS[a.view]);
    else if (a.view === 'files' && dk.desk) dkFiles();
    else if (a.view === 'update' && updateModal.hidden) openUpdateModal();
  } else if (a.kind === 'creds') credsAsk(a);
  else if (a.kind === 'creds-close') credsClose(a.id);
}

// --- git: forgejo itself, the master host in the title

const gitMaster = () => gitHostsList.find((h) => h.role === 'master' && h.reachable)?.host || gitRoute?.host || '';

function dkGit() {
  if (!gitRoute) return;
  const w = dkWin('app:git', 'git', gitMaster(), 'svc dk-git');
  if (!w) return;
  const pop = Object.assign(el('button', 'dk-pop'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
  pop.appendChild(dkGlyph(DK_UI.pop));
  pop.addEventListener('click', () => { if (w.git.url) window.open(w.git.url, '_blank', 'noopener'); });
  w.head.querySelector('.dk-btns').prepend(pop);
  w.git = { url: '', master: '', conn: null };
  dkSize(w, 1040, 640);
  dkGitFrame();
  w.onClose = () => { if (w.git.conn) w.git.conn.win.closed = true; };
  dkFocus(w);
}

// the frame kept while its url holds, the title following the master
function dkGitFrame() {
  const w = dk.wins.get('app:git');
  if (!w) return;
  const master = gitMaster();
  if (master !== w.git.master) {
    w.git.master = master;
    const title = w.head.querySelector('.dk-title');
    let sub = title.querySelector('.dk-sub');
    if (!sub) sub = title.appendChild(el('span', 'dk-sub'));
    sub.textContent = master ? ` ${master}` : '';
    w.task.title = master ? `git ${master}` : 'git';
  }
  const url = gitRoute ? serviceUrl(gitRoute) : '';
  if (url === w.git.url) return;
  w.git.url = url;
  if (w.git.conn) w.git.conn.win.closed = true;
  w.git.conn = null;
  if (!url) {
    w.body.replaceChildren(el('p', 'dk-note', 'no git service answering'));
    return;
  }
  const frame = Object.assign(el('iframe', 'dk-frame'), { src: url, title: 'git', allow: 'clipboard-read; clipboard-write; fullscreen' });
  w.body.replaceChildren(frame);
  // lit on the mesh graph as the service's window is
  w.git.conn = { win: { closed: false }, host: gitRoute.host, name: gitRoute.name };
  activeConnections.set(serviceKey(gitRoute), w.git.conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
}

// --- task bar popups: each grown out of its own button, its bottom on the
// bar's top, its left on the button's left, slid back only as the screen needs

const DK_POP_GAP = 6;
const DK_POP_EDGE = 8;

// fill: a popup as wide as the button's left to the screen's right, at least
// that many px; tall: as tall as the screen allows, at most that many px
function dkAnchor(pop, btn, { fill = 0, tall = 0 } = {}) {
  pop.dkAnchor = { btn, fill, tall };
  if (!pop.dkPlace) {
    const ro = new ResizeObserver(() => pop.dkPlace());
    pop.dkPlace = () => {
      const a = pop.dkAnchor;
      if (!a || pop.hidden || !pop.isConnected || !a.btn.isConnected) return;
      const r = a.btn.getBoundingClientRect();
      const top = (a.btn.closest('.dk-bar') || a.btn).getBoundingClientRect().top;
      pop.style.top = 'auto';
      pop.style.right = 'auto';
      pop.style.bottom = `${innerHeight - top + DK_POP_GAP}px`;
      if (a.tall) pop.style.height = `${Math.min(a.tall, top - DK_POP_GAP - DK_POP_EDGE)}px`;
      if (a.fill) pop.style.width = `${Math.min(innerWidth - 2 * DK_POP_EDGE, Math.max(a.fill, innerWidth - DK_POP_EDGE - r.left))}px`;
      pop.style.left = `${Math.max(DK_POP_EDGE, Math.min(r.left, innerWidth - DK_POP_EDGE - pop.offsetWidth))}px`;
    };
    // shown, grown or the screen resized: placed again
    ro.observe(pop);
    addEventListener('resize', pop.dkPlace);
    pop.dkRelease = () => { ro.disconnect(); removeEventListener('resize', pop.dkPlace); pop.dkPlace = null; };
  }
  pop.dkPlace();
}

// --- the mesh: the tray's icon, its graph and pings in a popup above it

function dkMeshTray() {
  const wrap = el('div', 'dk-tray-wrap');
  const b = Object.assign(el('button', 'dk-tray'), { type: 'button', title: 'mesh', ariaLabel: 'mesh' });
  b.setAttribute('aria-expanded', 'false');
  b.appendChild(dkGlyph(DK_GLYPHS.mesh));
  const pop = Object.assign(el('div', 'dk-mesh-pop dk-pop'), { hidden: true });
  wrap.append(b, pop);
  // a column up the screen's right edge, the button at its bottom left corner
  dkAnchor(pop, b, { fill: 240, tall: 720 });
  const fit = new ResizeObserver(() => { meshDims = null; if (!pop.hidden && !meshAnimFrame) drawMesh(); });
  const show = (on) => {
    pop.hidden = !on;
    b.setAttribute('aria-expanded', String(on));
    if (on) {
      pop.appendChild(meshPanel);
      fit.observe(pop);
      meshDims = null;
      // measured while stashed, 0 tall: measured again now it shows
      meshStatsDirty = true;
      drawMesh();
    } else {
      fit.disconnect();
      stash.prepend(meshPanel);
    }
  };
  b.addEventListener('click', () => show(pop.hidden));
  // a press anywhere else closes it
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !wrap.contains(e.target)) show(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });
  dk.meshTray = { show };
  return wrap;
}

// a press inside a service's frame never reaching the page, its window raised by the page's blur
addEventListener('blur', () => setTimeout(() => {
  const f = document.activeElement;
  const w = f?.classList.contains('dk-frame') && [...dk.wins.values()].find((o) => o.body.contains(f));
  if (w && !w.node.classList.contains('focused')) dkFocus(w);
}));

// shells ended with the page, not left for their grace
addEventListener('pagehide', (e) => { if (!e.persisted) for (const w of [...dk.wins.values()]) if (w.kind === 'term') dkClose(w, true); });

// --- the account: a phosphorus user over the hosts' own logins, its vault
// of host and page logins kept on the mesh, sealed with its password

let acct = null;

async function acctCall(url, body) {
  try {
    const r = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, ...out };
  } catch (err) { return { ok: false, status: 0, error: err.message }; }
}

async function acctStart() {
  const me = await acctCall('/api/me');
  if (me.ok) acctIn(me);
  else acctLogin(me.setup);
}

// a real form, so the browser offers to save and fill it
function acctLogin(setup) {
  acct = null;
  chatAs('');
  clearTimeout(stateRetry);
  const sock = stateWs;
  stateWs = null;
  sock?.close();
  dkLogout();
  const form = Object.assign(el('form', 'dk-login acct-login'), { method: 'post', action: '/api/login' });
  const user = Object.assign(el('input'), { name: 'username', placeholder: 'user', autocomplete: 'username', spellcheck: false, autocapitalize: 'off', required: true });
  const pass = Object.assign(el('input'), { name: 'password', type: 'password', placeholder: 'password', autocomplete: 'current-password' });
  const why = el('span', 'dk-state bad');
  const go = Object.assign(el('button', 'primary', 'log in'), { type: 'submit' });
  const actions = el('div', 'update-actions');
  actions.append(why, go);
  form.append(el('div', 'home-col-head', 'phosphorus'),
    el('p', 'dk-note', setup ? 'first start: log in as admin with ADMIN_PASS from .env to make users' : 'log in'),
    user, pass, actions);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    go.disabled = true;
    why.textContent = '';
    const me = await acctCall('/api/login', { user: user.value.trim(), pass: pass.value });
    go.disabled = false;
    if (!me.ok) { why.textContent = me.error || 'no answer'; pass.value = ''; pass.focus(); return; }
    acctIn(me);
  });
  const stage = el('div', 'dk-stage');
  stage.appendChild(form);
  const desk = el('div', 'dk-desk');
  desk.append(dkArt(), stage, dkBar());
  dkView.replaceChildren(desk);
  user.focus();
}

function acctIn(me) {
  acct = { user: me.user, admin: me.admin, boot: me.boot, wallpaper: me.wallpaper || 0, vault: me.vault || { hosts: {}, pages: {} } };
  acct.vault.hosts ||= {};
  acct.vault.pages ||= {};
  if (acct.boot) { acctSetup(); return; }
  acctPrefs(me.prefs || {}, me.prefsAt || 0);
  chatAs(acct.user);
  if (acctNext()) return;
  if (!stateWs) connectState();
  dk.creds = new Map(Object.entries(acct.vault.hosts).map(([h, c]) => [h, { user: c.user, pass: c.pass }]));
  if (dk.creds.size) dkDesktop(); else dkLogin();
}

async function acctSave() {
  if (!acct || acct.boot) return '';
  const r = await acctCall('/api/me/vault', { vault: acct.vault });
  return r.ok ? '' : r.error || 'not saved';
}

// the page's own settings in localStorage, mirrored to the user's home
const PREF_LS = { icons: 'phosphorus-dk-icons', theme: 'phosphorus-theme', recent: 'phosphorus-recent-files', color: 'phosphorus-chat-color' };
const PREF_OF = Object.fromEntries(Object.entries(PREF_LS).map(([k, v]) => [v, k]));
let prefsTimer = null;
let prefsQuiet = false;

// only the keys this browser changed sent, another's newer ones left be
const prefsDirty = new Set();
function prefsSoon(key) {
  if (prefsQuiet || !acct || acct.boot) return;
  for (const k of key ? [key] : Object.keys(PREF_LS)) prefsDirty.add(k);
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const prefs = {};
    for (const k of prefsDirty) { try { prefs[k] = localStorage.getItem(PREF_LS[k]) || ''; } catch {} }
    prefsDirty.clear();
    acctCall('/api/me/prefs', { prefs }).then((r) => {
      if (r.ok) { prefsSeen = JSON.stringify(r.prefs); prefsAt = Math.max(prefsAt, r.prefsAt || 0); }
      prefsTimer = null;
    });
  }, 800);
}

for (const m of ['setItem', 'removeItem']) {
  const own = Storage.prototype[m];
  Storage.prototype[m] = function (k, ...rest) {
    own.call(this, k, ...rest);
    if (this === window.localStorage && PREF_OF[k]) prefsSoon(PREF_OF[k]);
  };
}

// the user's own settings over this browser's; this browser's sent up where
// the user has none only when this same user left them here
const PREF_OWNER = 'phosphorus-prefs-owner';
let prefsSeen = '';
// the newest settings stamp taken in or written, an older copy (a host not
// yet caught up) never undoing it
let prefsAt = 0;
function acctPrefs(prefs, at = 0) {
  prefsAt = Math.max(prefsAt, at);
  let seed = false;
  let mine = false;
  try { mine = localStorage.getItem(PREF_OWNER) === acct.user; localStorage.setItem(PREF_OWNER, acct.user); } catch {}
  prefsSeen = JSON.stringify(prefs);
  prefsQuiet = true;
  for (const [k, ls] of Object.entries(PREF_LS)) {
    try {
      if (prefs[k]) localStorage.setItem(ls, prefs[k]);
      else if (localStorage.getItem(ls) && mine) seed = true;
      else localStorage.removeItem(ls);
    } catch {}
  }
  prefsQuiet = false;
  if (seed) prefsSoon();
  let theme = null;
  try { theme = localStorage.getItem(PREF_LS.theme); color = localStorage.getItem(PREF_LS.color) || color; } catch {}
  applyTheme(theme || (systemLight.matches ? 'light' : 'dark'));
}

// the session and desktop rechecked, the desktop's lists only once this host
// answers, backing off to 5 minutes while it doesn't
const ACCT_POLL_MS = 30000;
let acctPollMs = ACCT_POLL_MS;
async function acctTick() {
  const up = await acctCheck();
  acctPollMs = up === false ? Math.min(acctPollMs * 2, 300000) : ACCT_POLL_MS;
  if (up !== false) dkDeskLoad();
}
addEventListener('focus', acctTick);
(function acctPoll() { setTimeout(async () => { if (!document.hidden) await acctTick(); acctPoll(); }, acctPollMs); })();

// a session gone (expired, password changed, user deleted): back to the login
let acctChecking = false;
async function acctCheck() {
  if (!acct || acctChecking) return undefined;
  acctChecking = true;
  const me = await acctCall('/api/me');
  acctChecking = false;
  if (me.status === 401 && acct) acctLogin(me.setup);
  // another browser's icon moves, theme or wallpaper, taken in
  if (!me.ok || !acct || acct.boot || me.user !== acct.user) return me.status !== 0;
  if ((me.prefsAt || 0) > prefsAt && JSON.stringify(me.prefs || {}) !== prefsSeen && !prefsTimer) { acctPrefs(me.prefs || {}, me.prefsAt); dkLayout(); }
  if ((me.wallpaper || 0) !== acct.wallpaper) { acct.wallpaper = me.wallpaper || 0; dkWallPaint(); }
  return true;
}

// a service's page sent here to log in first, back to it after
function acctNext() {
  const q = new URLSearchParams(location.search);
  const next = q.get('next');
  if (!next) return false;
  history.replaceState(null, '', '/');
  // the service still refusing: no second bounce back to it
  let last = '';
  try { last = sessionStorage.getItem('phosphorus-next') || ''; sessionStorage.setItem('phosphorus-next', `${Date.now()} ${next}`); } catch {}
  const [at, prev] = [Number(last.split(' ')[0]), last.slice(last.indexOf(' ') + 1)];
  let u;
  try { u = new URL(next); } catch { return false; }
  if (prev === next && Date.now() - at < 15000) {
    const why = q.get('why') === 'none' ? 'no login cookie reached it, log out and in again' : 'the login cookie was refused';
    setTimeout(() => openConfirm(`${u.host} sent you back here${q.get('by') ? ` from ${q.get('by')}` : ''}: ${why}.`, {
      title: 'not logged in there', hideCancel: true, actionLabel: 'ok', onAction: closeUpdateModal,
    }));
    return false;
  }
  const base = baseDomain || location.hostname;
  if (u.protocol !== 'https:' || !(u.hostname === base || u.hostname.endsWith(`.${base}`))) return false;
  location.replace(u.href);
  return true;
}

async function acctLogout() {
  await acctCall('/api/logout', {});
  acctLogin(false);
}

// the setup admin: only the users list, then out
function acctSetup() {
  dkLogout();
  const box = el('div', 'dk-login');
  const out = Object.assign(el('button', '', 'log out'), { type: 'button' });
  out.addEventListener('click', acctLogout);
  const actions = el('div', 'update-actions');
  actions.appendChild(out);
  box.append(el('div', 'home-col-head', 'setup admin'),
    el('p', 'dk-note', 'make an admin user, then log out and in as them; the setup admin is off once an admin exists'),
    acctUsers(), actions);
  const stage = el('div', 'dk-stage');
  stage.appendChild(box);
  const desk = el('div', 'dk-desk');
  desk.append(dkArt(), stage, dkBar());
  dkView.replaceChildren(desk);
}

// the users list and a new user's form, for admins
function acctUsers() {
  const wrap = el('div', 'acct-users');
  const list = el('ul', 'dk-rows');
  const name = noFill(Object.assign(el('input'), { placeholder: 'new user', spellcheck: false, autocapitalize: 'off' }));
  const pass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
  const admin = Object.assign(el('input'), { type: 'checkbox' });
  const adminLabel = el('label', 'acct-check');
  adminLabel.append(admin, ' admin');
  const add = Object.assign(el('button', 'primary', 'add'), { type: 'button' });
  const why = el('div', 'dk-state bad');
  const row = el('div', 'dk-row acct-new');
  row.append(name, pass, adminLabel, add);
  const draw = (r) => {
    why.textContent = r.ok ? '' : r.error || 'no answer';
    if (!r.users) return;
    list.replaceChildren(...(r.users.length ? r.users.map((u) => {
      const li = el('li', 'dk-row acct-user');
      const box = Object.assign(el('input'), { type: 'checkbox', checked: u.admin, disabled: u.name === acct.user });
      const lab = el('label', 'acct-check');
      lab.append(box, ' admin');
      box.addEventListener('change', async () => draw(await acctCall('/api/users/admin', { name: u.name, admin: box.checked })));
      const del = Object.assign(el('button', 'danger', 'delete'), { type: 'button', disabled: u.name === acct.user });
      del.addEventListener('click', async () => {
        if (del.textContent !== 'sure?') { del.textContent = 'sure?'; return; }
        draw(await acctCall('/api/users/delete', { name: u.name }));
      });
      li.append(el('span', 'dk-host', u.name), lab, del);
      return li;
    }) : [el('li', 'empty', 'no users yet')]));
  };
  add.addEventListener('click', async () => {
    const r = await acctCall('/api/users', { name: name.value.trim(), pass: pass.value, admin: admin.checked });
    if (r.ok) { name.value = ''; pass.value = ''; admin.checked = false; }
    draw(r);
  });
  for (const i of [name, pass]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') add.click(); });
  wrap.append(list, row, why);
  acctCall('/api/users').then(draw);
  return wrap;
}

function dkUsersWin() {
  const w = dkWin('app:users', 'users', '', 'app dk-app-users');
  if (!w) return;
  const body = el('div', 'acct-pane');
  body.appendChild(acctUsers());
  w.body.appendChild(body);
  dkSize(w, 560, 420);
  dkFocus(w);
}

// a locked host chip's own login, saved to the vault once the shell answers
function dkUnlock(host, chip) {
  // a second press on its chip closing it
  if (chip.unlockClosed && Date.now() - chip.unlockClosed < 400) { chip.unlockClosed = 0; return; }
  const pop = el('form', 'acct-unlock');
  const user = noFill(Object.assign(el('input'), { placeholder: 'user', spellcheck: false, autocapitalize: 'off', value: dkUsers()[host] || '' }));
  const pass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
  const why = el('span', 'dk-state');
  const go = Object.assign(el('button', 'primary', 'log in'), { type: 'submit' });
  pop.append(el('div', 'home-col-head', host), user, pass, why, go);
  pop.classList.add('dk-pop');
  const close = () => { pop.remove(); pop.dkRelease?.(); document.removeEventListener('pointerdown', away, true); };
  const away = (e) => {
    if (pop.contains(e.target)) return;
    if (chip.contains(e.target)) chip.unlockClosed = Date.now();
    close();
  };
  document.addEventListener('pointerdown', away, true);
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  pop.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!user.value.trim() || !pass.value) return;
    go.disabled = true;
    why.className = 'dk-state busy';
    why.textContent = '…';
    const bad = await dkProbe(host, user.value.trim(), pass.value);
    go.disabled = false;
    if (bad) { why.className = 'dk-state bad'; why.textContent = bad; pass.value = ''; pass.focus(); return; }
    dkRemember(host, user.value.trim(), pass.value);
    close();
  });
  document.body.appendChild(pop);
  dkAnchor(pop, chip);
  (user.value ? pass : user).focus();
}

function dkRemember(host, user, pass) {
  dk.creds.set(host, { user, pass });
  const users = dkUsers();
  users[host] = user;
  try { localStorage.setItem(DK_USERS_KEY, JSON.stringify(users)); } catch {}
  if (acct && !acct.boot) { acct.vault.hosts[host] = { user, pass }; acctSave(); }
  dkChips();
  dkIcons();
}

function dkForget(host) {
  dk.creds.delete(host);
  if (acct) { delete acct.vault.hosts[host]; acctSave(); }
  for (const w of [...dk.wins.values()]) if (w.host === host) dkClose(w, true);
  dkChips();
  dkIcons();
}

// the task bar's profile: a menu of settings, users and log out
function dkProfileTray() {
  const b = Object.assign(el('button', 'dk-tray dk-profile'), { type: 'button', title: acct?.user || 'profile', ariaLabel: 'profile' });
  if (acct?.admin) {
    // the user's head lowered, the crown on it
    const svg = dkGlyph('M8 4.6a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2zM2.5 15c.6-2.8 2.8-4.2 5.5-4.2s4.9 1.4 5.5 4.2');
    svg.appendChild(svgEl('path', { d: DK_GLYPHS.crown, class: 'dk-crown' }));
    b.appendChild(svg);
    b.title += ', admin';
  } else b.appendChild(dkGlyph(DK_GLYPHS.user));
  b.append(el('span', 'dk-profile-name', acct?.user || ''));
  // a second press closing it, the press itself having hidden it already
  let open = false;
  b.addEventListener('pointerdown', () => { open = !dkMenuEl.hidden && dkMenuEl.owner === b; });
  b.addEventListener('click', () => {
    if (open) { open = false; return; }
    dkMenuEl.owner = b;
    dkMenu(0, 0, [
      ['settings', dkProfileWin, true],
      ...(acct?.admin ? [['users', dkUsersWin, true]] : []),
      null,
      ['log out', acctLogout, true, 'danger'],
    ], null, acct?.user || 'profile');
    dkMenuEl.classList.add('dk-pop');
    dkAnchor(dkMenuEl, b);
  });
  return b;
}

// the profile window: saved hosts, page logins and the password
function dkProfileWin() {
  const w = dkWin('app:profile', 'profile', acct?.user || '', 'app dk-app-profile');
  if (!w) return;
  const body = el('div', 'acct-pane');
  w.body.appendChild(body);
  const draw = () => {
    const hosts = el('ul', 'dk-rows');
    const names = [...new Set([...Object.keys(acct.vault.hosts), ...terminalHosts])].sort();
    hosts.replaceChildren(...(names.length ? names.map((h) => {
      const li = el('li', 'dk-row acct-user');
      const saved = acct.vault.hosts[h];
      const act = Object.assign(el('button', saved ? 'danger' : '', saved ? 'forget' : 'log in'), { type: 'button' });
      act.addEventListener('click', () => {
        if (saved) { dkForget(h); draw(); return; }
        const chip = [...(dk.desk?.hosts.children || [])].find((c) => c.textContent === h);
        if (chip) dkUnlock(h, chip);
      });
      li.append(el('span', 'dk-host', h), el('span', 'dk-state', saved ? saved.user : terminalHosts.includes(h) ? 'locked' : ''), act);
      return li;
    }) : [el('li', 'empty', 'no hosts')]));

    const pages = el('ul', 'dk-rows');
    const keys = Object.keys(acct.vault.pages).sort();
    pages.replaceChildren(...(keys.length ? keys.map((k) => {
      const p = acct.vault.pages[k];
      const li = el('li', 'dk-row acct-page');
      const cu = Object.assign(el('button', '', 'copy user'), { type: 'button' });
      const cp = Object.assign(el('button', '', 'copy pass'), { type: 'button' });
      const del = Object.assign(el('button', 'danger', 'delete'), { type: 'button' });
      cu.addEventListener('click', () => copyText(p.user));
      cp.addEventListener('click', () => copyText(p.pass));
      del.addEventListener('click', () => { delete acct.vault.pages[k]; acctSave(); draw(); });
      const name = Object.assign(el('span', 'dk-host', k), { title: p.url || k });
      li.append(name, el('span', 'dk-state', p.user), cu, cp, del);
      return li;
    }) : [el('li', 'empty', 'none saved')]));
    const pName = noFill(Object.assign(el('input'), { placeholder: 'page', spellcheck: false }));
    pName.setAttribute('list', 'acct-page-names');
    const opts = el('datalist');
    opts.id = 'acct-page-names';
    opts.replaceChildren(...dk.services.map((r) => Object.assign(el('option'), { value: r.name })));
    const pUser = noFill(Object.assign(el('input'), { placeholder: 'user', spellcheck: false }));
    const pPass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
    const pAdd = Object.assign(el('button', 'primary', 'save'), { type: 'button' });
    pAdd.addEventListener('click', () => {
      const k = pName.value.trim();
      if (!k || !pUser.value) return;
      const svc = dk.services.find((r) => r.name === k);
      acct.vault.pages[k] = { url: svc ? serviceUrl(svc) : '', user: pUser.value, pass: pPass.value };
      acctSave();
      draw();
    });
    const pRow = el('div', 'dk-row acct-new');
    pRow.append(pName, pUser, pPass, pAdd);

    const pw = el('form', 'dk-row acct-new');
    const old = noFill(Object.assign(el('input'), { placeholder: 'current' }), true);
    const neu = noFill(Object.assign(el('input'), { placeholder: 'new' }), true);
    const pwGo = Object.assign(el('button', 'primary', 'change'), { type: 'submit' });
    const pwWhy = el('div', 'dk-state');
    pw.append(old, neu, pwGo);
    pw.addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await acctCall('/api/me/password', { old: old.value, pass: neu.value });
      pwWhy.className = `dk-state ${r.ok ? 'ok' : 'bad'}`;
      pwWhy.textContent = r.ok ? 'changed' : r.error || 'no answer';
      if (r.ok) { old.value = ''; neu.value = ''; }
    });

    body.replaceChildren(
      el('div', 'dk-pick-head', 'hosts'), hosts,
      el('div', 'dk-pick-head', 'page logins'), pages, pRow, opts,
      el('div', 'dk-pick-head', 'password'), pw, pwWhy,
    );
  };
  draw();
  dkSize(w, 620, 520);
  dkFocus(w);
}

acctStart();
