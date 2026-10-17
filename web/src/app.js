import { renderMd, mdBlocks, fitMath } from './md.js';
import { parserFor, parserNow, highlight, syntaxErrors } from './lezer.js';

// the page's vendor files, hashed by the build
const ASSETS = __ASSETS__;

// each app's own code in its own chunk, all fetched once the desktop is up
const APPS = {
  projects: () => import('./apps/projects.js'),
  status: () => import('./apps/status.js'),
  terminal: () => import('./apps/terminal.js'),
  editor: () => import('./apps/editor.js'),
  files: () => import('./apps/files.js'),
};
// the newest /api/state, handed to an app as it loads
let lastState = null;
const appMods = new Map();
function app(name) {
  if (!appMods.has(name)) appMods.set(name, APPS[name]().catch((e) => { appMods.delete(name); throw e; }));
  return appMods.get(name);
}
// an app's call: loaded for it when on, skipped when it never was
function appCall(name, on, call) {
  if (on || appMods.has(name)) app(name).then(call, (e) => console.error(`${name} failed to load`, e));
}
// past first paint, so opening one never waits on the network
addEventListener('load', () => (self.requestIdleCallback || setTimeout)(() => {
  for (const n of Object.keys(APPS)) app(n).catch(() => {});
}));

// --- helpers ----------------------------------------------------------------

const paneContent = document.getElementById('pane-content');

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

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// --- the editor's file kinds and open tabs, the code itself fetched on first open ---

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

// tab id -> its editor, host\nshare\npath -> its id
const editors = new Map();
const codeTabs = new Map();
let codeSeq = 0;
const codeKey = (f) => `${f.host}\n${f.share}\n${f.path}`;
const codeName = (f) => f.path.split('/').pop() || f.path;

// a file as the files tab names it: host, then the share's root, then the path
const fileLabel = (host, root, rel) => filesPath(host, root, rel);
function loadJsonSafe(key) { try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch { return []; } }

// an editor tab gone: the chat no longer taking it as "this file"
function editorGone(id) { if (seenEditor === id) { seenEditor = ''; paintSeen(); } }

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
  if (!activeConnections.size) return;
  let changed = false;
  for (const [key, conn] of activeConnections) {
    if (conn.win.closed) { activeConnections.delete(key); changed = true; }
  }
  if (changed) drawMesh();
}

// hosts whose frontend answers, each one terminal tab
let terminalHosts = [];

// model hosts whose opencode is up, the only ones running projects
let harnessHosts = [];

// a host's OS, from /api/state's tailnet (tailscale itself sees every
// host as linux)
const hostPlatform = new Map();

// round-trip ms from this browser to that host, timed here, null until
// measured or when it didn't answer
const hostRtt = new Map();

// host -> last 20 samples, oldest first, for the stats table sparkline
const rttHistory = new Map();
const RTT_HISTORY_LEN = 20;
const RTT_SAMPLE_MS = 2000;
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
  redrawHost(host);
  const r = await fetch(`/api/host?host=${encodeURIComponent(host)}`, { method: 'POST' }).catch(() => null);
  if (hostSwitch?.to !== host) return;
  if (!r || !r.ok) {
    hostSwitch = null;
    redrawHost(from);
    return;
  }
  // chat, state and stats reconnected through the new host
  ws?.close();
  connectState();
  appCall('status', false, (m) => m.statusReconnect());
}

// the served host from the state, held at the pending one until it answers
function settleHost(served) {
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
  // nothing redrawn for a poll changing nothing drawn (a full rebuild at 10/s grew the tab)
  const sig = JSON.stringify([selfHost, routes.map((r) => [r.host, r.name]),
    tailnet.map((d) => [d.name, !!d.phosphorus, d.os || ''])]);
  if (sig === meshSig) return;
  meshSig = sig;
  meshStatsDirty = true;
  if (!meshAnimFrame) drawMesh();
}

// every host pinged from this browser, through the tunnel and the host serving
// the page, the whole round trip timed here
async function pingHosts() {
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

const lerp = (a, b, t) => a + (b - a) * t;

// ping bucket -> CSS class, null/undefined meaning unmeasured, not offline
function pingClass(rttMs) {
  if (rttMs === null || rttMs === undefined) return '';
  if (rttMs <= 150) return 'good';
  if (rttMs <= 300) return 'slow';
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
const SPARK_MAX_MS = 300;
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
      + `<span class="mesh-git-behind">${behind}${h.reachable && !master && acct?.admin
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
function askGitSwitch(name) {
  const master = gitHostsList.find((h) => h.role === 'master' && h.reachable);
  const text = master
    ? `${master.host} hands off to ${name}, git.${baseDomain} down a few seconds.`
    : `${name} force-promoted, roster reset to the hosts in view. only if the old master is gone.`;
  openConfirm(text, {
    title: master ? 'switch git master' : 'force-promote', actionLabel: master ? 'make master' : 'force-promote',
    onAction: async () => {
      let msg = `${name} is taking over`;
      try {
        const r = await fetch(`/api/githosts/${encodeURIComponent(name)}/force`, { method: 'POST' });
        if (!r.ok) msg = `make master failed: ${(await r.json().catch(() => ({}))).error || `status ${r.status}`}`;
      } catch (err) { msg = `make master failed: ${err.message}`; }
      openConfirm(msg, { title: 'git master', hideCancel: true, actionLabel: 'ok', onAction: closeUpdateModal });
    },
  });
}

meshGitRows.addEventListener('click', (e) => {
  const b = e.target.closest('.mesh-git-take');
  if (b) askGitSwitch(b.dataset.host);
});

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
    // the graph off screen: nothing to measure, looked at again a few times a second
    if (!meshPanel.offsetParent) { pulseAnimFrame = setTimeout(() => requestAnimationFrame(tick), 250); return; }
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
  dkDeskStamps();
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
  lastState = state;
  appCall('status', false, (m) => m.statusState(state));
  modelPresence(state.model);
  harnessHosts = (state.model?.models || []).filter((x) => x.harness).map((x) => x.host);
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
  const pick = await filesChoose(fm, { title: 'keep it on', message: what, options: opts });
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

// the status card's clear buttons, its code fetched or not
const stRolesEl = document.querySelector('#st-model .st-model-roles');
stRolesEl.addEventListener('click', (e) => {
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
  const btn = stRolesEl.querySelector(`.st-clear[data-role="${CSS.escape(String(msg.id).replace(/^st:/, ''))}"]`);
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

// a running host's stage, every peer updating at once, and how far along it is
const STAGE_LABEL = { asked: 'starting', installing: 'installing', restarting: 'restarting' };
const STAGE_DONE = { asked: 0.15, installing: 0.45, restarting: 0.8 };
const stageOf = (chain, host) => (chain && chain.versions && chain.versions[host] && chain.versions[host].stage) || '';

// a failure's short cause, when the chain named one, a running host's stage
const stepLabel = (chain, host, step) => (!step ? ''
  : ((step === 'fail' || step === 'unreachable' || step === 'skipped') && chain.errors && chain.errors[host])
    || (step === 'running' && STAGE_LABEL[stageOf(chain, host)]) || UPDATE_LABEL[step] || step);

// nothing new while a chain is in flight, its own continue and cancel above
function renderUpdateButton() {
  updateBtn.disabled = !!meshLock;
  updateBtn.textContent = !meshLock ? 'update' : meshLock.paused ? 'paused' : 'updating';
  updateBtn.title = meshLock ? `started by ${meshLock.initiator}` : 'update every host on the mesh at once';
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

// every host updating at once, each weighed by its stage, so the bar moves
// as the mesh does, not in one jump per host
function renderProgress(status) {
  progressStatus = status;
  const total = status.order.length;
  if (!total) { updateProgress.hidden = true; return; }
  let done = 0;
  let finished = 0;
  for (const host of status.order) {
    const state = status.results[host] || 'pending';
    if (state === 'running') done += STAGE_DONE[stageOf(status, host)] || 0.05;
    else if (state !== 'pending') { done += 1; finished += 1; }
  }
  // block cells, as the files transfer bar
  updateProgress.hidden = false;
  const cells = updateCells();
  const full = Math.round((done / total) * cells);
  updateProgressCells.replaceChildren('█'.repeat(full), Object.assign(document.createElement('i'), { textContent: '░'.repeat(cells - full) }));
  updateProgressLabel.textContent = `${finished}/${total} hosts`;
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
  dkPopsClose('update');
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
  appCall('terminal', false, (m) => m.termsRetheme());
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
    dkPopsClose('theme');
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
  const desk = el('div', 'dk-desk');
  const bar = dkBar(tasks, hosts, dkProfileTray());
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
// on each minute's turn, not up to 5s after it
(function dkClockTick() {
  dkClock();
  setTimeout(dkClockTick, 60000 - (Date.now() % 60000) + 20);
}());

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
  terminal: 'M2 3h12v10H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
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
  if (!first) { tile.classList.remove('dk-wait'); return; }
  if (!tile.classList.contains('dk-wait')) {
    tile.classList.add('dk-wait');
    // the glyph shown after a while, a slow host never leaving a hole
    setTimeout(() => tile.classList.remove('dk-wait'), 600);
  }
  const img = Object.assign(el('img', 'dk-favicon'), { alt: '', decoding: 'async', draggable: false });
  img.addEventListener('load', () => { tile.replaceChildren(img); tile.classList.add('dk-tile-img'); tile.classList.remove('dk-wait'); }, { once: true });
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
  const files = new Map(dk.deskFiles.map((e) => [`doc\n${filesJoin(e.at, e.name)}`, e]));
  // one key per icon and what it shows, an unchanged one kept as it is
  const want = [
    ...hosts.map((h) => [`terminal\n${h}`, () => dkIcon('terminal', 'terminal', h, () => dkTerminal(h))]),
    ['files', () => dkIcon('files', 'files', '', () => filesWin())],
    ['editor', () => dkIcon('editor', 'editor', '', dkEditorPick)],
    ['chat', () => dkIcon('chat', 'chat', '', () => dkOpenApp('chat'))],
    ['status', () => dkIcon('status', 'status', '', () => dkOpenApp('status'))],
    ['projects', () => dkIcon('projects', 'projects', '', () => dkOpenApp('projects'))],
    ...(git ? [['git', () => dkIcon('git', 'git', '', () => dkOpenApp('git'))]] : []),
    ['games', () => dkIcon('games', 'games', '', () => dkOpenApp('games'))],
    ['about', () => dkIcon('about', 'about', '', () => dkOpenApp('about'))],
    ...(acct?.admin ? [['users', () => dkIcon('users', 'users', '', dkUsersWin)]] : []),
    ...dk.services.map((r) => [JSON.stringify([r.host, r.name]), () => dkIcon('service', r.name, r.host, () => dkService(r),
      `/api/favicon/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}`)]),
    ...[...files.values()].map((e) => [JSON.stringify([e.at, e.name, e.dir, e.mtime, e.hosts, e.stale, e.all, e.live]), () => dkFileIcon(e)]),
  ];
  const had = new Map(dkIconEls().map((b) => [b.dataset.key, b]));
  dk.desk.icons.replaceChildren(...want.map(([key, make]) => {
    const old = had.get(key);
    if (old) return old;
    const b = make();
    b.dataset.key = key;
    b.classList.add('dk-new');
    return b;
  }));
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
  const here = new Set(dkIconEls().map((b) => b.dataset.id));
  let placed = false;
  // a deleted file's cell freed once the desktop's files are read
  if (dk.deskReady) {
    for (const id of Object.keys(saved)) {
      if (id.startsWith('doc\n') && !here.has(id)) { delete saved[id]; placed = true; }
    }
  }
  // an icon not in yet keeps its cell, none of the others spilling into it
  const held = new Set(Object.entries(saved).filter(([id, p]) => !here.has(id) && Array.isArray(p)).map(([, p]) => dkCell(...p)));
  const taken = new Set();
  const rest = [];
  for (const b of dkIconEls()) {
    const p = saved[b.dataset.id];
    if (Array.isArray(p) && p[0] < cols && p[1] < rows && !taken.has(dkCell(...p))) {
      taken.add(dkCell(...p));
      dkPut(b, p[0], p[1]);
    } else rest.push(b);
  }
  const busy = (i, skipHeld) => taken.has(dkCell(Math.floor(i / rows), i % rows)) || (skipHeld && held.has(dkCell(Math.floor(i / rows), i % rows)));
  let i = 0;
  for (const b of rest) {
    let j = i;
    while (j < cols * rows && busy(j, true)) j += 1;
    // a full grid: held cells given up before overlapping
    if (j >= cols * rows) { j = i; while (j < cols * rows && busy(j, false)) j += 1; } else i = j;
    const c = Math.floor(j / rows);
    const r = j % rows;
    taken.add(dkCell(c, r));
    dkPut(b, c, r);
    // its cell kept, off the grid only while the desk is too small
    const p = saved[b.dataset.id];
    if (!(Array.isArray(p) && (p[0] >= cols || p[1] >= rows))) { saved[b.dataset.id] = [c, r]; placed = true; }
  }
  if (placed) try { localStorage.setItem(DK_POS_KEY, JSON.stringify(saved)); } catch {}
  for (const id of [...dk.sel]) if (!dkIconEls().some((b) => b.dataset.id === id)) dk.sel.delete(id);
  dkPaintSel();
}

function dkPut(b, c, r) {
  b.dataset.c = c;
  b.dataset.r = r;
  b.style.transform = `translate(${DK_PAD + c * DK_GX}px, ${DK_PAD + r * DK_GY}px)`;
  if (b.classList.contains('dk-new')) requestAnimationFrame(() => requestAnimationFrame(() => b.classList.remove('dk-new')));
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
    if (node.hidden || w.leaving) dkFocus(w); else if (node.classList.contains('focused')) dkMin(w); else dkFocus(w);
  });
  // the minimize button never raising or focusing on its way down
  node.addEventListener('pointerdown', (e) => { if (!e.target.closest('.dk-min')) dkFocus(w); }, true);
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
  if (w.node.hidden) dkRestore(w);
  if (w.node.style.zIndex !== String(dk.z)) w.node.style.zIndex = ++dk.z;
  w.onFocus?.();
  dkAppsChanged();
}

// the offset from the window to its task bar button; the scale also pulls
// the window's own offset in, made up for in the translate
const DK_MIN_SCALE = 0.1;
function dkToTask(w) {
  const a = w.node.getBoundingClientRect();
  const b = w.task.getBoundingClientRect();
  const k = 1 - DK_MIN_SCALE;
  const mx = w.snap ? 0 : w.x;
  const my = w.snap ? 0 : w.y;
  w.node.style.setProperty('--min-x', `${b.left + b.width / 2 - (a.left + a.width / 2) + k * mx}px`);
  w.node.style.setProperty('--min-y', `${b.top + b.height / 2 - (a.top + a.height / 2) + k * my}px`);
}

// shrunk into its task bar button, focused and on top the whole way, the
// next window focused only once it's gone
function dkMin(w) {
  dkToTask(w);
  dkLeave(w, () => {
    w.node.hidden = true;
    w.node.classList.remove('focused');
    w.task.classList.remove('active');
    const top = [...dk.wins.values()].filter((o) => !o.node.hidden && !o.leaving).sort((a, b) => b.node.style.zIndex - a.node.style.zIndex)[0];
    if (top) dkFocus(top);
    dkAppsChanged();
  }, 'dk-minimizing');
}

// grown back out of its task bar button, measured unanimated first
function dkRestore(w) {
  const n = w.node;
  n.style.animation = 'none';
  n.hidden = false;
  dkToTask(w);
  n.style.animation = '';
  n.classList.add('dk-restoring');
  const end = (e) => {
    if (e && e.target !== n) return;
    n.classList.remove('dk-restoring');
    n.removeEventListener('animationend', end);
  };
  n.addEventListener('animationend', end);
  setTimeout(end, 400);
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
  if (w.back) dkNavDrop(w);
  if (force) w.node.remove(); else dkLeave(w, () => w.node.remove());
  w.task.remove();
  dk.wins.delete(w.key);
  dkAppsChanged();
}

// --- a website window's back: history.back() undoes the newest frame load
// anywhere, so only the window holding it gets one

let dkNavs = [];
const dkNavWins = new Set();
const DK_NAV_UNDO_MS = 3000;
function dkNavSync() { for (const w of dkNavWins) w.back.disabled = !w.frame || dkNavs.at(-1) !== w.frame; }
function dkNavDrop(w) {
  dkNavs = dkNavs.filter((f) => f.isConnected && f !== w.frame);
  dkNavWins.delete(w);
  dkNavSync();
}
function dkNav(w, frame) {
  if (!w.back) {
    w.back = Object.assign(el('button', 'dk-back'), { type: 'button', title: 'back', ariaLabel: 'back' });
    w.back.appendChild(dkGlyph(DK_UI.back));
    w.back.addEventListener('click', () => {
      if (dkNavs.at(-1) !== w.frame) return;
      dkNavs.pop();
      w.frame.dkUndo = performance.now();
      history.back();
      dkNavSync();
    });
    w.head.prepend(w.back);
    dkNavWins.add(w);
  }
  if (w.frame && w.frame !== frame) dkNavs = dkNavs.filter((f) => f !== w.frame);
  w.frame = frame;
  let first = true;
  // the first load the page itself, one just after a back that back's
  frame.addEventListener('load', () => {
    if (first) { first = false; return; }
    if (performance.now() - (frame.dkUndo || -Infinity) < DK_NAV_UNDO_MS) { frame.dkUndo = 0; return; }
    dkNavs.push(frame);
    dkNavSync();
  });
  dkNavSync();
}

// --- the apps

function dkTerminal(host, run = '') {
  const c = dk.creds.get(host);
  const w = dkWin(null, 'terminal', host, 'term');
  if (!w || !c) return;
  w.host = host;
  const t = app('terminal').then((m) => m.startTerminal(w.body, host, newSid(), false, false, { ...c, run }));
  w.onFocus = () => t.then((x) => x.focus());
  w.onClose = () => t.then((x) => x.close());
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
async function dkAddFiles(list) {
  const fm = dk.desk && await filesWin(dkDeskAt() || undefined);
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
      ...hosts.map((h) => [`terminal on ${h}`, () => dkTerminal(h), true]),
      ...(hosts.length ? [null] : []),
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

const fmExt = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

function fmKind(e) {
  if (e.dir) return 'dir';
  const x = fmExt(e.name);
  for (const k in FM_KINDS) if (FM_KINDS[k].includes(x)) return k;
  return isCode(e.name) ? 'code' : 'file';
}

const fmIcon = (kind) => dkGlyph(FM_GLYPHS[kind], `fm-${kind}`);

const fmSame = (a, b) => a && b && a.host === b.host && a.share === b.share;

// every window showing that folder, read again
function fmChanged(loc, ...dirs) {
  const same = (a) => fmSame(a, loc) || (isHome(a) && isHome(loc));
  for (const fm of dkFms) if (same(fm.loc) && dirs.includes(fm.dir)) appCall('files', false, (m) => m.fmLoad(fm));
  if (isHome(loc) && dkDeskDirs().some((d) => dirs.includes(d))) dkDeskLoad();
}

// pages, wasm and NAME.app folders run, text edits, the rest shown
const runnable = (e) => (e.dir ? /\.app$/i.test(e.name) : ['html', 'htm', 'wasm'].includes(fmExt(e.name)));

function fileOpen(loc, rel, e) {
  if (loc.host === '*' && !(e.dir && !runnable(e))) loc = homeAt(homePick(rel));
  if (runnable(e)) return dkRun(loc, rel);
  if (e.dir) return filesWin({ loc, dir: rel });
  if (isCode(e.name)) return dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, loc.root, rel) });
  app('files').then((m) => m.dkViewer(loc, rel));
}

const dkMenuEl = el('div', 'dk-menu');
dkMenuEl.hidden = true;
dkMenuEl.setAttribute('role', 'menu');
document.body.appendChild(dkMenuEl);
// a press on its owner left to the owner's own toggle
document.addEventListener('pointerdown', (e) => { if (!dkMenuEl.contains(e.target) && !dkMenuEl.owner?.contains(e.target)) dkMenuEl.hidden = true; }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dkMenuEl.hidden = true; }, true);
addEventListener('blur', () => { dkMenuEl.hidden = true; });

function dkMenu(x, y, items, after, title) {
  dkMenuEl.owner = null;
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

function fmSpring(fm, node, t) {
  if (fm.spring?.node === node) return;
  clearTimeout(fm.spring?.timer);
  fm.spring = null;
  if (fmSame(t.loc, fm.loc) && t.dir === fm.dir) return;
  fm.spring = { node, timer: setTimeout(() => { fm.spring = null; node.classList.remove('drop'); app('files').then((m) => m.fmGo(fm, t.loc, t.dir)); }, FM_SPRING_MS) };
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

// every file manager open, for a change one makes shown in the rest
const dkFms = new Set();

// a folder or place held under a drag this long: opened, the drag going on
const FM_SPRING_MS = 700;

const fmSay = (fm, text, bad) => {
  fm.note.textContent = text || '';
  fm.note.classList.toggle('bad', !!bad);
  clearTimeout(fm.noteTimer);
  if (text && !fm.busy) fm.noteTimer = setTimeout(() => { if (fm.note.textContent === text) fm.note.textContent = ''; }, 6000);
};

// the file manager's window and its choices, fetched on first open
const filesWin = (...a) => app('files').then((m) => m.dkFiles(...a));
const filesChoose = (...a) => app('files').then((m) => m.dkChoose(...a));

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
  dk.deskReady = false;
  if (key) dkDeskLoad();
}

// each online host's Desktop stamps, pushed with the state: a change rereads them
const dkDeskStampNow = () => JSON.stringify(homeOnline().sort()
  .map((h) => [h, dkDeskDirs().map((d) => hostsInfo[h.toLowerCase()]?.desk?.[d] ?? '')]));

function dkDeskStamps() {
  if (dk.deskReady && dkDeskStampNow() !== dk.deskStamp) dkDeskLoad();
}

async function dkDeskLoad() {
  if (!dkDeskAt()) return;
  dk.deskStamp = dkDeskStampNow();
  const key = dk.deskKey;
  // a folder no host answered for: its last icons kept, never blinking out
  const lists = await Promise.all(dkDeskDirs().map((dir) => homeList(dir)
    .then((b) => b.entries.map((e) => ({ ...e, at: dir })), () => dk.deskFiles.filter((e) => e.at === dir))));
  if (key !== dk.deskKey) return;
  dk.deskFiles = lists.flat();
  dk.deskReady = true;
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
    e.dir && ['show in files', () => filesWin({ loc: HOME, dir: rel }), true],
    !e.dir && ['open in editor', () => dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, 'home', rel) }), !e.stale],
    !e.dir && ['download', () => { location.href = filesApi(loc, 'download', { path: rel }); }, !e.stale],
    ...(e.dir ? [] : dkRunItems(rel, e.all ? homeOnline() : e.live || [])),
    null,
    ['show in files', () => filesWin({ loc: HOME, dir: e.at }), true],
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
    const pop = Object.assign(el('button', 'dk-out'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
    pop.appendChild(dkGlyph(DK_UI.pop));
    pop.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
    w.head.querySelector('.dk-btns').prepend(pop);
  }
  w.body.appendChild(frame);
  if (got.kind !== 'wasm') dkNav(w, frame);
  w.onClose = () => { frame.contentWindow?.location.replace('about:blank'); };
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
  codeTabs.set(codeKey(file), id);
  let ed = null;
  app('editor').then((m) => {
    if (!w.node.isConnected) return;
    ed = m.codeEditor(w.body, file, w.node, id);
    editors.set(id, ed);
    if (w.node.classList.contains('focused')) ed.focus();
  }, (e) => { w.body.textContent = `the editor failed to load: ${e.message}`; });
  // the file the chat's models take "this file" to mean
  w.onFocus = () => {
    if (ed && !w.body.contains(document.activeElement)) ed.focus();
    seenEditor = id;
    paintSeen();
  };
  w.holdClose = () => ed?.holdClose();
  w.onClose = () => {
    if (ed) ed.close();
    else if (codeTabs.get(codeKey(file)) === id) codeTabs.delete(codeKey(file));
  };
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
  browse.addEventListener('click', () => { dkClose(w); filesWin(); });
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
  const pop = Object.assign(el('button', 'dk-out'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
  pop.appendChild(dkGlyph(DK_UI.pop));
  pop.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  w.head.querySelector('.dk-btns').prepend(pop);
  const frame = Object.assign(el('iframe', 'dk-frame'), { src: url, title: r.name, allow: 'clipboard-read; clipboard-write; fullscreen' });
  w.body.appendChild(frame);
  dkNav(w, frame);
  // lit on the mesh graph as an open tab of it would be
  const conn = { win: { closed: false }, host: r.host, name: r.name };
  activeConnections.set(serviceKey(r), conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
  w.onClose = () => { conn.win.closed = true; frame.contentWindow?.location.replace('about:blank'); };
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
  if (id === 'status') pingHosts();
  const fit = new ResizeObserver(() => { if (id === 'status') appCall('status', false, (m) => m.statusDraw()); });
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
  if (deskApps.has('projects') !== was.has('projects')) appCall('projects', deskApps.has('projects'), (m) => m.pjWatch(deskApps.has('projects')));
  if (up('status')) appCall('status', true, (m) => m.statusWatch(lastState));
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
    else if (a.view === 'files' && dk.desk) filesWin();
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
  const pop = Object.assign(el('button', 'dk-out'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
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
  dkNav(w, frame);
  // lit on the mesh graph as the service's window is
  w.git.conn = { win: { closed: false }, host: gitRoute.host, name: gitRoute.name };
  activeConnections.set(serviceKey(gitRoute), w.git.conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
}

// --- task bar popups: each grown out of its own button, its bottom on the
// bar's top, a corner on the button's, right of it where it fits, else left

const DK_POP_GAP = 6;

// one task bar popup open at a time, every other closed as one opens
function dkPopsClose(keep) {
  if (keep !== 'mesh') dk.meshTray?.show(false);
  if (keep !== 'menu') dkMenuEl.hidden = true;
  if (keep !== 'update' && !updateModal.hidden) closeUpdateModal();
  if (keep !== 'theme') closeMenus();
  if (keep !== 'unlock') for (const p of document.querySelectorAll('.acct-unlock')) p.dkClose?.();
}
const DK_POP_EDGE = 8;

// fill: a popup as wide as the button's left to the screen's right, at least
// that many px; tall: as tall as the screen allows, at most that many px
// the box a fixed element is placed in: the screen, or the nearest ancestor
// whose transform, filter or blur takes that over
function dkFixedFrame(node) {
  for (let a = node.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.transform !== 'none' || cs.filter !== 'none' || cs.backdropFilter !== 'none' || cs.perspective !== 'none'
      || /paint|layout|strict|content/.test(cs.contain) || /transform|filter|perspective/.test(cs.willChange)) {
      const r = a.getBoundingClientRect();
      return { left: r.left + a.clientLeft, bottom: r.top + a.clientTop + a.clientHeight };
    }
  }
  return { left: 0, bottom: innerHeight };
}

function dkAnchor(pop, btn, { fill = 0, tall = 0 } = {}) {
  pop.dkAnchor = { btn, fill, tall };
  if (!pop.dkPlace) {
    const ro = new ResizeObserver(() => pop.dkPlace());
    pop.dkPlace = () => {
      const a = pop.dkAnchor;
      if (!a || pop.hidden || !pop.isConnected || !a.btn.isConnected) return;
      const r = a.btn.getBoundingClientRect();
      // the bar's edges the limits, so a popup lines up with it
      const bar = (a.btn.closest('.dk-bar') || a.btn).getBoundingClientRect();
      const lo = Math.max(DK_POP_EDGE, bar.left);
      const hi = Math.min(innerWidth - DK_POP_EDGE, bar.right);
      // fixed, but inside the bar its blur makes the bar the frame of reference
      const cb = dkFixedFrame(pop);
      pop.style.top = 'auto';
      pop.style.right = 'auto';
      pop.style.bottom = `${cb.bottom - bar.top + DK_POP_GAP}px`;
      if (a.tall) pop.style.height = `${Math.min(a.tall, bar.top - DK_POP_GAP - DK_POP_EDGE)}px`;
      if (a.fill) pop.style.width = `${Math.min(hi - lo, Math.max(a.fill, hi - r.left))}px`;
      // the button's left edge, else, short of room, its right edge
      const w = pop.offsetWidth;
      const left = r.left + w <= hi + 1 ? r.left : Math.max(lo, r.right - w);
      pop.style.left = `${left - cb.left}px`;
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
  dkAnchor(pop, b, { fill: 240, tall: 440 });
  const fit = new ResizeObserver(() => { meshDims = null; if (!pop.hidden && !meshAnimFrame) drawMesh(); });
  const show = (on) => {
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

// the session rechecked, backing off to 5 minutes while this host doesn't answer;
// the desktop's lists reread on their stamps instead
const ACCT_POLL_MS = 30000;
let acctPollMs = ACCT_POLL_MS;
async function acctTick() {
  const up = await acctCheck();
  acctPollMs = up === false ? Math.min(acctPollMs * 2, 300000) : ACCT_POLL_MS;
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
  dkPopsClose();
  const pop = el('form', 'acct-unlock');
  const user = noFill(Object.assign(el('input'), { placeholder: 'user', spellcheck: false, autocapitalize: 'off', value: dkUsers()[host] || '' }));
  const pass = noFill(Object.assign(el('input'), { placeholder: 'password' }), true);
  const why = el('span', 'dk-state');
  const go = Object.assign(el('button', 'primary', 'log in'), { type: 'submit' });
  pop.append(el('div', 'home-col-head', host), user, pass, why, go);
  pop.classList.add('dk-pop');
  const close = () => { pop.remove(); pop.dkRelease?.(); document.removeEventListener('pointerdown', away, true); };
  pop.dkClose = close;
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
  // a second press closing it
  b.addEventListener('click', () => {
    if (!dkMenuEl.hidden && dkMenuEl.owner === b) { dkMenuEl.hidden = true; return; }
    dkPopsClose('menu');
    dkMenu(0, 0, [
      ['settings', dkProfileWin, true],
      ...(acct?.admin ? [['users', dkUsersWin, true]] : []),
      null,
      ['log out', acctLogout, true, 'danger'],
    ], null, acct?.user || 'profile');
    dkMenuEl.owner = b;
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

// read by the apps loaded on first open

// read by the apps loaded on first open

// read by the apps loaded on first open

// read by the apps loaded on first open

// read by the apps loaded on first open
export {
  ASSETS,
  DK_UI,
  HOME,
  MODEL_ROLES,
  acct,
  codeKey,
  codeLang,
  codeName,
  codeTabs,
  color,
  colorFor,
  copyFile,
  copyText,
  cssVar,
  deskApps,
  dk,
  dkCode,
  dkFms,
  dkFocus,
  dkGlyph,
  dkMenu,
  dkMenuEl,
  dkRunItems,
  dkWallSet,
  dkWin,
  editorGone,
  editors,
  el,
  esc,
  fileLabel,
  fileOpen,
  filesApi,
  filesCall,
  filesJoin,
  filesParent,
  filesPath,
  fmChanged,
  fmExt,
  fmIcon,
  fmKind,
  fmMark,
  fmSame,
  fmSay,
  fmSpring,
  fmTransfer,
  fmUnspring,
  fmZones,
  fold,
  harnessHosts,
  homeAt,
  homeHolders,
  homeOnline,
  homePick,
  homeTarget,
  hostsInfo,
  humanSize,
  icon,
  jsonPost,
  lines,
  may,
  modalOpen,
  modelRoles,
  name,
  news,
  openMenu,
  pingClass,
  plural,
  putFile,
  runnable,
  selfHost,
  send,
  shareMenu,
  steadyRtt,
  ws,
  wsBase,
};
