'use strict';

// --- self / routes ------------------------------------------------------
// everything from /api/state, pushed, see connectState at the bottom
let selfHost = '';
// BASE_DOMAIN from /api/state, the page's own host until the first answer
let baseDomain = location.hostname;
// GAME_ZONE from /api/state, games joined at <name>.<zone>
let gameZone = 'hesperus';
const aboutVersion = document.getElementById('about-version');
const topUpdate = document.getElementById('top-update');
const sideModel = document.getElementById('side-model');
const sideChat = document.getElementById('side-chat');
const sideMesh = document.getElementById('side-mesh');

function serviceUrl(route) {
  const base = route.base_path ? `${route.base_path.replace(/^\/+|\/+$/g, '')}/` : '';
  if (route.mode === 'subdomain') return `https://${route.name}.${baseDomain}/${base}`;
  return `/${route.host}/${route.name}/${base}`;
}

const serviceKey = (route) => `${route.host}::${route.name}`;

// key -> { win, host, name } for each service opened from here whose tab is
// still open, driving the touched/blue path and the packet pulse
const activeConnections = new Map();

// window.open rather than the anchor's own nav, for a pollable .closed, a
// blocked popup falling back to target=_blank, untracked
function openService(route, e) {
  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const win = window.open(serviceUrl(route), '_blank');
  if (!win) return;
  e.preventDefault();
  activeConnections.set(serviceKey(route), { win, host: route.host, name: route.name });
  startPulseLoop();
  drawMesh();
}

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

// first in the directory, marked with a database icon
const GIT_SERVICE = 'git';

// rebuilt only on change, for a ↑↓-selected row's focus
let lastServicesSig = '';

function renderRoutes(routes, tailnet) {
  const servicesList = document.getElementById('services-list');

  terminalHosts = tailnet.filter((d) => d.hesperus).map((d) => d.name);
  const services = routes.filter((r) => r.type !== 'game' && r.name !== GIT_SERVICE);
  renderGames(routes.filter((r) => r.type === 'game'));
  gitRoute = routes.find((r) => r.name === GIT_SERVICE) || null;
  renderGitCard();

  const sig = JSON.stringify([services, !gitHostsList.length]);
  if (sig !== lastServicesSig) renderServices(servicesList, services, sig);
  renderMesh(routes, tailnet);
  dkRoutes(services);
}

function renderServices(servicesList, services, sig) {
  lastServicesSig = sig;
  servicesList.innerHTML = '';
  if (!services.length && !gitHostsList.length) {
    servicesList.innerHTML = '<li class="empty">nothing live right now</li>';
  } else {
    for (const r of services) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = serviceUrl(r);
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.addEventListener('click', (e) => openService(r, e));
      a.textContent = r.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.append(
        Object.assign(document.createElement('span'), { className: 'svc-host', textContent: r.host }),
        ' · ',
        Object.assign(document.createElement('span'), { className: 'svc-mode', textContent: r.mode }),
      );
      a.appendChild(meta);
      li.appendChild(a);
      servicesList.appendChild(li);
    }
  }
}

// --- git card ---------------------------------------------------------------

// a row with its hosts folded under it, which expanding slides out,
// updated in place since a rebuild would cut the fan-out short

let gitRoute = null;
let gitHostsList = [];
let gitOpen = false;
let gitBusy = '';
let gitError = '';
let gitEls = null;
let gitAnimating = false;
const gitItems = new Map(); // host -> { li, bubble, backup, lag }
// time behind as the transfer bar's cells: three even bands, each filled
// across its own span of seconds, green to 8s, yellow to 15s, red to 60s
const GIT_LAG_BAND_CELLS = 5;
const GIT_LAG_BANDS = [['good', 0, 8], ['slow', 8, 15], ['stale', 15, 60]];
const GIT_STACK_STEP = 0;
const GIT_STACK_MAX = 3;

function ago(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// how far a host's copy trails the master
function gitBackupText(h, masterGen) {
  if (!h.reachable) return 'unreachable';
  if (h.gen == null || h.ageSec == null) return 'no data yet';
  const parts = [];
  if (h.role === 'master') parts.push('live');
  else if (masterGen != null && h.gen < masterGen) parts.push('older lineage');
  else parts.push(`${ago(h.ageSec)} behind`);
  if (h.role !== 'master' && !h.eligible) parts.push('catching up');
  if (h.updating) parts.push('updating');
  return parts.join(' · ');
}

function lagMeter(ageSec) {
  let html = '';
  let empty = 0;
  for (const [cls, from, to] of GIT_LAG_BANDS) {
    const frac = Math.max(0, Math.min(1, (ageSec - from) / (to - from)));
    const full = Math.round(frac * GIT_LAG_BAND_CELLS);
    if (full) html += `<span class="${cls}">${'█'.repeat(full)}</span>`;
    empty += GIT_LAG_BAND_CELLS - full;
  }
  return `${html}<span class="off">${'░'.repeat(empty)}</span>`;
}

function chevronIcon() {
  const icon = svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' });
  icon.appendChild(svgEl('polyline', { points: '6 3 11 8 6 13' }));
  return icon;
}

function gitSkeleton() {
  if (gitEls) return gitEls;
  const group = document.getElementById('git-card');
  const head = document.createElement('div');
  head.className = 'git-head';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'git-toggle';
  toggle.appendChild(chevronIcon());
  toggle.addEventListener('click', () => {
    gitOpen = !gitOpen;
    toggle.setAttribute('aria-expanded', String(gitOpen));
    toggle.setAttribute('aria-label', gitOpen ? 'hide git hosts' : 'show git hosts');
    layoutGitStack(true);
  });
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'show git hosts');
  const name = document.createElement('a');
  name.className = 'git-name';
  name.target = '_blank';
  name.rel = 'noopener noreferrer';
  name.append(databaseIcon(), document.createTextNode(GIT_SERVICE));
  name.addEventListener('click', (e) => { if (gitRoute) openService(gitRoute, e); else e.preventDefault(); });
  const warn = document.createElement('span');
  warn.className = 'git-warn';
  head.append(toggle, name, warn);

  const list = document.createElement('ul');
  list.className = 'git-hosts';
  list.addEventListener('transitionend', (e) => {
    if (e.target !== list || e.propertyName !== 'height') return;
    gitAnimating = false;
    list.classList.remove('animate');
    if (gitOpen) list.style.height = 'auto';
  });
  const err = document.createElement('div');
  err.className = 'git-error';
  group.append(head, list, err);
  window.addEventListener('resize', () => { if (!gitOpen) layoutGitStack(false); });
  gitEls = { group, head, name, warn, list, err };
  return gitEls;
}

function gitItem(host) {
  let item = gitItems.get(host);
  if (item) return item;
  const li = document.createElement('li');
  li.className = 'git-host';
  const bubble = document.createElement('button');
  bubble.type = 'button';
  bubble.className = 'git-bubble';
  bubble.addEventListener('click', () => askGitSwitch(host));
  const name = document.createElement('span');
  name.className = 'git-host-name';
  name.textContent = host;
  const backup = document.createElement('span');
  backup.className = 'git-host-backup';
  const lag = document.createElement('span');
  lag.className = 'git-lag';
  lag.title = 'time behind the master: green to 8s, yellow to 15s, red to 60s';
  li.append(bubble, name, backup, lag);
  item = { li, bubble, backup, lag };
  gitItems.set(host, item);
  return item;
}

function renderGitCard() {
  const { group, name, warn, list, err } = gitSkeleton();
  const wasHidden = group.hidden;
  group.hidden = !gitRoute && !gitHostsList.length;
  if (group.hidden) return;

  if (gitRoute) name.href = serviceUrl(gitRoute); else name.removeAttribute('href');
  const up = gitHostsList.filter((h) => h.reachable).length;
  warn.hidden = up > 1;
  warn.textContent = up ? 'only one git-host' : 'no git host reachable';

  const master = gitHostsList.find((h) => h.role === 'master' && h.reachable);
  const masterGen = master ? master.gen : null;
  let setChanged = wasHidden;
  const seen = new Set();
  gitHostsList.forEach((h, i) => {
    seen.add(h.host);
    const it = gitItem(h.host);
    if (list.children[i] !== it.li) { list.insertBefore(it.li, list.children[i] || null); setChanged = true; }
    const isMaster = h.reachable && h.role === 'master';
    const canLead = h.reachable && !isMaster && (h.eligible || !master);
    it.li.className = `git-host${isMaster ? ' master' : ''}${h.reachable ? '' : ' down'}${gitBusy === h.host ? ' busy' : ''}${h.reachable && !isMaster && !canLead ? ' catching' : ''}`;
    it.bubble.disabled = !canLead || !!gitBusy;
    it.bubble.setAttribute('aria-pressed', String(isMaster));
    it.bubble.title = isMaster ? `${h.host} is master`
      : !h.reachable ? `${h.host} is unreachable`
      : gitBusy === h.host ? 'switching…'
      : canLead ? `make ${h.host} master` : `${h.host} is still catching up`;
    it.bubble.setAttribute('aria-label', it.bubble.title);
    it.backup.textContent = gitBusy === h.host ? 'switching…' : gitBackupText(h, masterGen);
    const meter = h.reachable && !isMaster && h.ageSec != null ? lagMeter(h.ageSec) : '';
    if (it.lag.dataset.m !== meter) { it.lag.innerHTML = meter; it.lag.dataset.m = meter; }
  });
  for (const [host, it] of gitItems) {
    if (!seen.has(host)) { it.li.remove(); gitItems.delete(host); setChanged = true; }
  }
  err.hidden = !gitError;
  err.textContent = gitError ? `! ${gitError}` : '';
  if (setChanged && !gitAnimating) layoutGitStack(false);
}

// collapsed: each host folded onto the git row, hidden (the CSS), no gap,
// open: the rows slid out into the tree
function layoutGitStack(animate) {
  const { group, head, list } = gitSkeleton();
  group.classList.toggle('open', gitOpen);
  const items = [...list.children];
  // natural height, read with 'auto' before the transition is switched on
  const from = list.offsetHeight;
  list.style.height = 'auto';
  const full = list.offsetHeight;
  if (animate) {
    list.style.height = `${from}px`;
    void list.offsetHeight;
    gitAnimating = true;
    list.classList.add('animate');
  }
  if (gitOpen) {
    list.style.height = animate ? `${full}px` : 'auto';
    items.forEach((li) => {
      li.style.transform = '';
      li.style.zIndex = '';
    });
    return;
  }
  const depth = Math.min(items.length, GIT_STACK_MAX) * GIT_STACK_STEP;
  list.style.height = `${depth}px`;
  items.forEach((li, i) => {
    const k = Math.min(i + 1, GIT_STACK_MAX);
    const dx = head.offsetLeft + k * GIT_STACK_STEP - li.offsetLeft;
    const dy = head.offsetTop + k * GIT_STACK_STEP - li.offsetTop;
    const sx = head.offsetWidth / li.offsetWidth;
    const sy = head.offsetHeight / li.offsetHeight;
    li.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    li.style.zIndex = String(GIT_STACK_MAX + 1 - k);
  });
  if (!animate) gitAnimating = false;
}

// the frontend's own dialog, not confirm(): shows the switch, and flags a force-promote
const gitModal = document.getElementById('git-modal');
const gitModalGo = document.getElementById('git-modal-go');

function closeGitModal() {
  gitModal.hidden = true;
  gitModalGo.onclick = null;
}

function askGitSwitch(host) {
  const master = gitHostsList.find((h) => h.role === 'master' && h.reachable);
  const target = gitHostsList.find((h) => h.host === host);
  const rows = [
    ['from', master ? master.host : 'no live master'],
    ['to', `${host}${target ? ` · ${gitBackupText(target, master ? master.gen : null)}` : ''}`],
  ];
  const dl = document.getElementById('git-switch');
  dl.replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
  const note = document.getElementById('git-modal-note');
  note.classList.toggle('warn', !master);
  note.textContent = master
    ? `${master.host} hands off to ${host}, git.${baseDomain} down a few seconds`
    : `${host} force-promoted, roster reset to the hosts in view, only if the old master is gone`;
  gitModalGo.textContent = master ? 'make master' : 'force-promote';
  gitModalGo.className = master ? 'primary' : 'force';
  gitModalGo.onclick = () => { closeGitModal(); forceGit(host); };
  // hung just below the host being elected, in the main pane's coordinates
  const row = gitItems.get(host)?.li.getBoundingClientRect();
  const pane = gitModal.parentElement.getBoundingClientRect();
  if (row) {
    gitModal.style.top = `${row.bottom - pane.top + 4}px`;
    gitModal.style.left = `${row.left - pane.left}px`;
  }
  gitModal.hidden = false;
  gitModalGo.focus();
}

document.getElementById('git-modal-close').addEventListener('click', closeGitModal);
document.getElementById('git-modal-cancel').addEventListener('click', closeGitModal);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !gitModal.hidden) closeGitModal(); });

async function forceGit(host) {
  gitBusy = host;
  gitError = '';
  renderGitCard();
  const why = await postFailure(`/api/githosts/${encodeURIComponent(host)}/force`);
  if (why) gitError = `make master failed: ${why}`;
  pollState();
  // busy until it leads, or gives up after 30s
  const leads = () => gitHostsList.some((h) => h.host === host && h.role === 'master');
  const until = Date.now() + 30000;
  while (!gitError && Date.now() < until && !leads()) await new Promise((r) => setTimeout(r, 1000));
  if (!gitError && !leads()) gitError = `${host} didn't take over, check the git-daemon logs`;
  gitBusy = '';
  renderGitCard();
  const shown = gitError;
  if (shown) setTimeout(() => { if (gitError === shown) { gitError = ''; renderGitCard(); } }, 15000);
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
const meshToggle = document.getElementById('mesh-toggle');
const paneChat = document.querySelector('.pane-chat');
const layoutEl = document.querySelector('.layout');
const SVG_NS = 'http://www.w3.org/2000/svg';

// the stats table's unclipped height, cached whenever renderMeshStats() runs,
// reserved by meshLayoutParams() when expanded
let lastStatsHeight = 0;

// the chat out of the column on a wide screen: the graph the column's full
// height, set by paintColumn()
let meshAlone = false;

// stats table DOM rebuilt only on real data changes, never per
// expand/collapse frame
let meshStatsDirty = true;

// expanded: fewer logical units per pixel width, a real zoom, on mobile
// .pane-chat is display:contents (clientHeight 0), hence .layout
function meshLayoutParams(expanded) {
  const width = expanded ? 200 : 232;
  const mobile = isMobile();
  const alone = meshAlone && !mobile;
  const pad = alone ? getComputedStyle(paneChat) : null;
  const totalH = mobile ? layoutEl.clientHeight
    : paneChat.clientHeight - (alone ? parseFloat(pad.paddingTop) + parseFloat(pad.paddingBottom) : 0);
  const fraction = mobile || alone ? 1 : (expanded ? 0.5 : 0.25);
  const bodyH = totalH * fraction - meshHeader.clientHeight - (expanded ? lastStatsHeight : 0);
  const widthPx = meshGraphWrap.clientWidth || width;
  const height = width * (Math.max(60, bodyH) / widthPx);
  // the legend expanded only, hidden, not gone, so still measured
  const legend = meshGraphWrap.querySelector('.mesh-legend');
  return { width, height, widthPx, legendPx: expanded ? legend.offsetTop + legend.offsetHeight : 0 };
}

// host row to the non-hesperus devices, a frame fraction, LIFT the
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

// the desktop's own pick, always expanded on a phone, expanded on its own
// with the column to itself, that pick back after
let meshDesktopExpanded = false;

// snap: straight to the end, the column itself changing under it, no table
// fading in or out on the way
function setMeshExpanded(willExpand, snap) {
  if (isMobile()) willExpand = true;
  else if (!meshAlone) meshDesktopExpanded = willExpand;
  if (willExpand === meshPanel.classList.contains('expanded')) return;
  keybarDirty();
  meshPanel.classList.toggle('expanded', willExpand);
  meshToggle.setAttribute('aria-expanded', String(willExpand));
  meshToggle.setAttribute('aria-label', willExpand ? 'shrink mesh graph' : 'expand mesh graph');
  if (!snap) { animateMeshT(willExpand ? 1 : 0); return; }
  if (meshAnimFrame) cancelAnimationFrame(meshAnimFrame);
  meshAnimFrame = null;
  meshT = willExpand ? 1 : 0;
  meshDims = null;
  drawMesh();
}

meshToggle.addEventListener('click', () => setMeshExpanded(!meshPanel.classList.contains('expanded')));
mobileQuery.addEventListener('change', () => setMeshExpanded(meshAlone || meshDesktopExpanded));
setMeshExpanded(false);

// touch swipe on the graph: up to open its table, down to close, desktop only
let meshSwipe = null;
meshGraphWrap.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'mouse') meshSwipe = { id: e.pointerId, x: e.clientX, y: e.clientY };
});
meshGraphWrap.addEventListener('pointercancel', () => { meshSwipe = null; });
meshGraphWrap.addEventListener('pointerup', (e) => {
  if (!meshSwipe || e.pointerId !== meshSwipe.id) return;
  const dx = e.clientX - meshSwipe.x;
  const dy = e.clientY - meshSwipe.y;
  meshSwipe = null;
  if (Math.abs(dy) > 40 && Math.abs(dy) > Math.abs(dx) * 1.3) setMeshExpanded(dy < 0);
});

window.addEventListener('resize', () => {
  if (!meshAnimFrame) drawMesh();
});

// --- serving host -----------------------------------------------------------
// the host serving this page, held by the ingress's hesperus-host cookie

const hesperusHosts = () => meshTailnet.filter((d) => d.hesperus).map((d) => d.name).sort();

// {to, from, at} of a switch awaiting the new host's first answer
let hostSwitch = null;
// grace for a late poll from the old host
const HOST_SWITCH_MS = 4000;
const hostNote = document.getElementById('mesh-host-note');
let hostNoteTimer = null;

// kind: pending, ok or error, the last two fading on their own
function setHostNote(text, kind) {
  clearTimeout(hostNoteTimer);
  hostNote.textContent = text;
  hostNote.className = `mesh-host-note ${kind}`;
  hostNote.hidden = false;
  if (kind !== 'pending') hostNoteTimer = setTimeout(() => { hostNote.hidden = true; }, kind === 'ok' ? 2500 : 6000);
}

// drawn at once as the new self, confirmed or undone by the state
function redrawHost(host) {
  selfHost = host;
  meshSig = '';
  renderMesh(meshRoutes, meshTailnet);
  keybarDirty();
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

// a host's square, name or stats row, expanded only, a mouse on press (no click
// lost to a redraw), a tap on release (never a swipe)
let hostTap = null;
const hostAt = (el) => meshPanel.classList.contains('expanded') && el?.closest?.('[data-host]')?.dataset.host;
for (const el of [meshSvg, meshStatsRows]) {
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse') { hostTap = { id: e.pointerId, x: e.clientX, y: e.clientY }; return; }
    const host = e.button === 0 && hostAt(e.target);
    if (host) { e.preventDefault(); switchHost(host); }
  });
  el.addEventListener('pointerup', (e) => {
    if (!hostTap || hostTap.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - hostTap.x, e.clientY - hostTap.y);
    hostTap = null;
    const host = moved < 10 && hostAt(document.elementFromPoint(e.clientX, e.clientY));
    if (host) switchHost(host);
  });
}

// --- mobile bottom tabs -----------------------------------------------

// below the 720px breakpoint the main pane, the mesh and the model card as
// full-height sections, switched by a bottom tab bar instead of stacking, its
// chat the chat tab
const mobileSections = {
  main: document.querySelector('.pane-main'),
  mesh: meshPanel,
  model: document.getElementById('st-model'),
};

let mobileSection = '';
const MOBILE_ORDER = ['main', 'mesh', 'model'];

// chat lit while the chat tab is up, home for every other tab
function paintMobileBar() {
  const chatUp = mobileSection === 'main' && document.querySelector('#tabbar-tabs .tab-btn.active')?.dataset.tabId === 'chat';
  const lit = chatUp ? 'chat' : mobileSection;
  for (const btn of document.querySelectorAll('.mobile-tab-btn')) btn.classList.toggle('active', btn.dataset.section === lit);
  moveInk(document.getElementById('mobile-tabbar'), document.querySelector('.mobile-tab-btn.active'));
}

function setMobileSection(name, from) {
  const prev = mobileSection;
  mobileSection = name;
  for (const key in mobileSections) mobileSections[key].classList.toggle('mobile-active', key === name);
  if (prev !== name && (prev === 'model' || name === 'model')) placeModel();
  keybarDirty();
  if (prev && prev !== name && isMobile()) {
    slideIn(mobileSections[name], from || (MOBILE_ORDER.indexOf(name) > MOBILE_ORDER.indexOf(prev) ? 'right' : 'left'));
  }
  paintMobileBar();
}

document.getElementById('mobile-tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.mobile-tab-btn');
  if (!btn) return;
  if (btn.dataset.section !== 'chat') { setMobileSection(btn.dataset.section); return; }
  setMobileSection('main');
  showTab('chat');
});

setMobileSection('main');

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
// blue master, clay available, dark grey out of date, red unreachable
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
    if (!d.hesperus || typeof d.rttMs !== 'number') continue;
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
    tailnet.map((d) => [d.name, !!d.hesperus, d.os || '', typeof d.rttMs === 'number'])]);
  if (sig === meshSig && !sampled) return;
  meshSig = sig;
  meshStatsDirty = true;
  keybarDirty();
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
  // hesperus hosts only, other mesh devices just in the graph
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
  // tailnet devices without hesperus: no routes, known only to the tailnet list
  const outside = new Map();
  for (const d of tailnet) {
    if (d.hesperus) {
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
  // written after the reads, so the frame lays out once
  meshPanel.style.setProperty('--mesh-basis', meshAlone && !isMobile() ? '100%' : `${25 + 25 * t}%`);

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
      drawNode(c.x, c.y, r.name, svcTouched ? 'svc touched' : 'svc', `${m}/${r.name}`,
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

function applyState(state) {
  selfHost = settleHost(state.self.host || '');
  if (state.domain) baseDomain = state.domain;
  if (state.gameZone) gameZone = state.gameZone;
  if (state.self.version) {
    aboutVersion.textContent = `v${state.self.version}`;
    document.querySelector('.brand-ver').textContent = `v${state.self.version}`;
  }

  const next = state.gitHosts;
  const gitChanged = JSON.stringify(next.map((h) => [h.host, h.reachable, h.role, h.eligible]))
    !== JSON.stringify(gitHostsList.map((h) => [h.host, h.reachable, h.role, h.eligible]));
  gitHostsList = next;

  renderRoutes(state.routes, state.tailnet);
  statusState(state);
  modelPresence(state.model);
  const nextModels = new Map((state.model?.models || []).map((x) => [x.host, { file: x.file, ready: x.ready, roles: modelRoles(x, state.model) }])
    .filter(([, v]) => v.roles.length));
  const modelChanged = JSON.stringify([...nextModels]) !== JSON.stringify([...meshModels]);
  meshModels = nextModels;
  if (filesOpened) filesSyncHosts(state.tailnet);
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
  const differs = state.tailnet.some((d) => d.hesperus && d.version && mine && d.version !== mine);
  const news = differs || !!meshLock || !!(chain && !chain.done);
  topUpdate.toggleAttribute('data-news', news);
  topUpdate.title = `mesh update (u)${meshLock || (chain && !chain.done) ? ', under way' : differs ? ', hosts on different versions' : ''}`;
}

// --- terminal tabs --------------------------------------------------------
const tabbarTabs = document.getElementById('tabbar-tabs');
const tabAddBtn = document.getElementById('tab-add');
const tabMenu = document.getElementById('tab-menu');
const tabMenuList = document.getElementById('tab-menu-list');
const tabMenuTitle = document.getElementById('tab-menu-title');
const paneContent = document.getElementById('pane-content');

// id -> { show, close } for each open terminal
const openTabs = new Map();

// the built in tabs, closed ones only hidden and kept closed across visits
const FIXED_TABS = { services: 'home', files: 'files', status: 'status', chat: 'chat', projects: 'projects', desktop: 'desktop' };
const CLOSED_TABS_KEY = 'hesperus-closed-tabs';
const fixedBtn = (id) => tabbarTabs.querySelector(`.tab-btn[data-tab-id="${id}"]`);
function closedTabs() {
  return Object.keys(FIXED_TABS).filter((id) => fixedBtn(id).hidden);
}
function saveClosedTabs() {
  try { localStorage.setItem(CLOSED_TABS_KEY, JSON.stringify(closedTabs())); } catch {}
}
function addTabClose(btn, id) {
  const close = document.createElement('span');
  close.className = 'tab-close';
  close.textContent = '×';
  close.addEventListener('click', (e) => { e.stopPropagation(); closeTab(id); });
  btn.appendChild(close);
}
for (const id in FIXED_TABS) addTabClose(fixedBtn(id), id);
for (const id of loadJsonSafe(CLOSED_TABS_KEY)) if (FIXED_TABS[id]) fixedBtn(id).hidden = true;

// from: the side the view slides in from, by tab order when not given
// a closed built in tab reopened by being gone to
function activateTab(id, from) {
  if (FIXED_TABS[id] && fixedBtn(id).hidden) {
    fixedBtn(id).hidden = false;
    saveClosedTabs();
  }
  const btns = [...tabbarTabs.querySelectorAll('.tab-btn')];
  const prev = btns.findIndex((b) => b.classList.contains('active'));
  const next = btns.findIndex((b) => b.dataset.tabId === id);
  btns.forEach((b) => b.classList.toggle('active', b.dataset.tabId === id));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${id}`));
  const view = document.getElementById(`view-${id}`);
  if (view && prev !== -1 && prev !== next) slideIn(view, from || (next > prev ? 'right' : 'left'));
  moveInk(tabbarTabs, btns[next]);
  keybarDirty();
  statusWatch();
  btns[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  openTabs.get(id)?.show();
  document.dispatchEvent(new CustomEvent('hesperus-tab', { detail: id }));
  paintMobileBar();
}

// a files reload on every visit, however reached
function showTab(id, from) {
  activateTab(id, from);
  if (id === 'files') filesOpen();
}

function closeTab(id) {
  if (openTabs.get(id)?.holdClose?.()) return;
  const btn = tabbarTabs.querySelector(`.tab-btn[data-tab-id="${id}"]`);
  const view = document.getElementById(`view-${id}`);
  const wasActive = btn?.classList.contains('active');
  const at = tabIds().indexOf(id);
  if (FIXED_TABS[id]) {
    btn.hidden = true;
    saveClosedTabs();
  } else {
    openTabs.get(id)?.close();
    btn?.remove();
    view?.remove();
    openTabs.delete(id);
    labelTerms();
  }
  // the one before it, else the one now first, else the about page
  if (wasActive) showTab(tabIds()[Math.max(0, at - 1)] || 'about', 'left');
  else moveInk(tabbarTabs, tabbarTabs.querySelector('.tab-btn.active'));
}

function createTabButton(id, label) {
  const btn = document.createElement('button');
  btn.className = 'tab-btn';
  btn.dataset.tabId = id;

  const span = document.createElement('span');
  span.className = 'tab-label';
  span.textContent = label;
  btn.appendChild(span);

  addTabClose(btn, id);

  btn.addEventListener('click', () => activateTab(id));
  return btn;
}

// a host's lone terminal by its name, several as (1), (2), ... in tab order
function labelTerms() {
  const btns = [...tabbarTabs.querySelectorAll('.tab-btn[data-host]')];
  for (const btn of btns) {
    const same = btns.filter((b) => b.dataset.host === btn.dataset.host);
    btn.querySelector('.tab-label').textContent = same.length > 1
      ? `${btn.dataset.host} (${same.indexOf(btn) + 1})` : btn.dataset.host;
  }
  syncInks();
}

// xterm only on the first terminal, most visits never opening one
let xtermLoaded = null;
function loadXterm() {
  if (xtermLoaded) return xtermLoaded;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/vendor/xterm.css';
  document.head.appendChild(css);
  const script = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`couldn't load ${src}`));
    document.head.appendChild(s);
  });
  xtermLoaded = script('/vendor/xterm.js')
    .then(() => Promise.all([script('/vendor/addon-fit.js'), script('/vendor/addon-webgl.js')]));
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
// terminals too: blue the accent, yellow the gold, magenta the rose
const TERM_HUES = {
  red: '--offmesh', green: '--online', yellow: '--accent-2',
  blue: '--accent', magenta: '--rose', cyan: '--teal',
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
    const loginStep = (data) => {
      seen += new TextDecoder().decode(data);
      if (/login: $/.test(seen)) { seen = ''; ws.send(enc.encode(`${login.user}\r`)); }
      else if (/password: $/.test(seen)) { ws.send(enc.encode(`${login.pass}\r`)); login = null; }
      return true;
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
        term.write(new Uint8Array(e.data));
      };
      ws.onclose = (e) => {
        if (e.code === TERM_TAKEN) {
          term.write('\r\n\x1b[2m[opened in another tab]\x1b[0m\r\n');
          forgetTerm(sid);
          return;
        }
        if (e.code === TERM_ENDED || !resume) {
          term.write('\r\n\x1b[2m[connection closed]\x1b[0m\r\n');
          forgetTerm(sid);
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
    // readable by hesperus while shared, never written to
    get shared() { return shared; },
    share: (on) => {
      shared = on;
      saveTerms(savedTerms().map((t) => (t.sid === sid ? { ...t, shared } : t)));
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'share', on, by: name }));
    },
    close: () => ready.then(() => {
      forgetTerm(sid);
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

// open terminals across a reload, per browser tab, like the sessions
const TERMS_KEY = 'hesperus-terms';
function savedTerms() {
  try { return JSON.parse(sessionStorage.getItem(TERMS_KEY)) || []; } catch { return []; }
}
function saveTerms(list) {
  try { sessionStorage.setItem(TERMS_KEY, JSON.stringify(list)); } catch {}
}
function forgetTerm(sid) {
  saveTerms(savedTerms().filter((t) => t.sid !== sid));
}

function newSid() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// a new session per click, its id by lowest free number
// a sid from before a reload: its session rejoined, unfocused
function openTerminalTab(host, sid, shared = false) {
  let n = 1;
  while (openTabs.has(`term-${host}-${n}`)) n++;
  const id = `term-${host}-${n}`;
  const btn = createTabButton(id, host);
  btn.dataset.host = host;
  tabbarTabs.appendChild(btn);
  labelTerms();
  const view = document.createElement('div');
  view.className = 'view term-view';
  view.id = `view-${id}`;
  paneContent.appendChild(view);
  const resume = !!sid;
  if (!resume) {
    sid = newSid();
    saveTerms([...savedTerms(), { host, sid, shared }]);
  }
  openTabs.set(id, startTerminal(view, host, sid, resume, shared));
  btn.classList.toggle('shared', shared);
  if (!resume) activateTab(id);
  tabMenu.hidden = true;
}

for (const t of savedTerms()) openTerminalTab(t.host, t.sid, !!t.shared);

// --- app tabs: a login over /api/app/<host>, then xpra's html5 client in a frame

const APPS_KEY = 'hesperus-apps';
function savedApps() {
  try { return JSON.parse(sessionStorage.getItem(APPS_KEY)) || []; } catch { return []; }
}
function saveApps(list) {
  try { sessionStorage.setItem(APPS_KEY, JSON.stringify(list)); } catch {}
}
const forgetApp = (sid) => saveApps(savedApps().filter((a) => a.sid !== sid));

// the frame's own client pointed back through this page's origin
function appFrameUrl(host, sid) {
  const base = `/api/appview/${encodeURIComponent(host)}/${sid}/`;
  const https = location.protocol === 'https:';
  const q = new URLSearchParams({
    server: location.hostname, port: location.port || (https ? '443' : '80'), ssl: String(https), path: base,
    floating_menu: 'false', sound: 'false', sharing: 'false', reconnect: 'true',
  });
  return `${base}index.html?${q}`;
}

function startApp(view, host, app, sid, resume) {
  const msg = el('div', 'app-msg', resume ? 'reconnecting…' : 'connecting…');
  const user = Object.assign(el('input'), { placeholder: 'user', autocomplete: 'username', spellcheck: false });
  const pass = Object.assign(el('input'), { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
  const go = Object.assign(el('button', 'primary', 'open'), { type: 'submit' });
  const form = Object.assign(el('form', 'app-login'), { hidden: true });
  form.append(el('div', 'app-login-title', `${app.name} on ${host}`), user, pass, go);
  const frame = Object.assign(el('iframe', 'app-frame'), { hidden: true, title: app.name });
  view.append(msg, form, frame);
  let ws = null;
  let retry = null;
  let delay = RETRY_MIN_MS;
  let ended = false;
  const say = (text) => { msg.textContent = text; msg.hidden = !text; };
  const finish = (text) => {
    ended = true;
    forgetApp(sid);
    form.hidden = true;
    say(text || `${app.name} closed`);
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (ws?.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'auth', user: user.value, password: pass.value }));
    pass.value = '';
    form.hidden = true;
  });
  const connect = () => {
    const q = new URLSearchParams({ sid, id: app.id });
    if (resume) q.set('resume', '1');
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/app/${encodeURIComponent(host)}?${q}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { delay = RETRY_MIN_MS; };
    ws.onmessage = (e) => {
      // a hop's own failure, plain text
      if (typeof e.data !== 'string') { say(new TextDecoder().decode(e.data).trim()); return; }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'login') {
        say(m.why || '');
        form.hidden = false;
        (user.value ? pass : user).focus();
      } else if (m.type === 'status') say(m.text);
      else if (m.type === 'error') say(m.text);
      else if (m.type === 'ready') {
        resume = true;
        say('');
        if (frame.hidden) { frame.src = appFrameUrl(host, sid); frame.hidden = false; }
      }
    };
    ws.onclose = (e) => {
      if (ended) return;
      if (e.code === TERM_TAKEN) { finish('opened in another tab'); frame.remove(); return; }
      if (e.code === TERM_ENDED || !resume) { finish(msg.textContent); frame.remove(); return; }
      retry = setTimeout(connect, delay);
      delay = Math.min(delay * 2, RETRY_MAX_MS);
    };
  };
  connect();
  return {
    show: () => (form.hidden ? frame.contentWindow?.focus() : (user.value ? pass : user).focus()),
    close: () => {
      ended = true;
      forgetApp(sid);
      clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'close' }));
        ws.close();
      }
      frame.src = 'about:blank';
    },
  };
}

// a sid from before a reload: its app rejoined, unfocused
function openAppTab(host, app, sid) {
  let n = 1;
  while (openTabs.has(`app-${host}-${n}`)) n++;
  const id = `app-${host}-${n}`;
  const btn = createTabButton(id, app.name);
  btn.title = `${app.name} on ${host}`;
  tabbarTabs.appendChild(btn);
  const view = el('div', 'view app-view');
  view.id = `view-${id}`;
  paneContent.appendChild(view);
  const resume = !!sid;
  if (!resume) {
    sid = newSid();
    saveApps([...savedApps(), { host, sid, app: { id: app.id, name: app.name } }]);
  }
  openTabs.set(id, startApp(view, host, app, sid, resume));
  if (!resume) activateTab(id);
}

// after the page's script, el and the rest defined below
queueMicrotask(() => { for (const a of savedApps()) if (a.app?.id) openAppTab(a.host, a.app, a.sid); });

function toggleShare(id) {
  const t = openTabs.get(id);
  if (!t) return;
  t.share(!t.shared);
  tabbarTabs.querySelector(`.tab-btn[data-tab-id="${id}"]`)?.classList.toggle('shared', t.shared);
  keybarDirty();
}

// files opened in the editor, newest first, for the + menu
const RECENT_FILES_KEY = 'hesperus-recent-files';
const RECENT_FILES_MAX = 3;
function rememberFile(file) {
  const list = loadJsonSafe(RECENT_FILES_KEY).filter((f) => f && codeKey(f) !== codeKey(file));
  try { localStorage.setItem(RECENT_FILES_KEY, JSON.stringify([file, ...list].slice(0, RECENT_FILES_MAX))); } catch {}
}
// --- new tab: its title the search, a host or page first, then the host's app

// host -> its /api/apps answer, the last one kept while a fresh one's asked
const appLists = new Map();
function fetchApps(host) {
  fetch(`/api/apps/${encodeURIComponent(host)}`).then((r) => r.json()).then((b) => {
    appLists.set(host, { apps: Array.isArray(b.apps) ? b.apps : [], why: b.on ? b.why || b.error || '' : '' });
    if (omni?.host === host) omniRender();
  }).catch(() => {});
}

// every host's apps, a terminal on all of them, the rest as its list has them
function hostApps(host) {
  const list = appLists.get(host);
  return [{ name: 'terminal', kind: 'app', open: () => openTerminalTab(host) },
    ...(list?.apps || []).map((a) => ({ name: a.name, kind: 'app', open: () => openAppTab(host, a) }))];
}

function omniPlaces() {
  const hosts = [...terminalHosts].sort((a, b) => (b === selfHost) - (a === selfHost) || a.localeCompare(b))
    .map((h) => ({ name: h, kind: h === selfHost ? 'this host' : 'host', host: h }));
  const pages = [...Object.entries(FIXED_TABS), ['about', 'about']]
    .map(([id, label]) => ({ name: label, kind: 'page', open: () => showTab(id) }));
  const files = loadJsonSafe(RECENT_FILES_KEY).filter((f) => f && f.host && f.path).slice(0, RECENT_FILES_MAX)
    .map((f) => ({ name: f.label || `${f.host}/${f.path}`, kind: 'recent file', open: () => openCodeTab(f) }));
  return [...hosts, ...pages, ...files];
}

// prefix matches ahead of the rest
function omniMatch(items, q) {
  q = q.trim().toLowerCase();
  if (!q) return items;
  const n = (it) => it.name.toLowerCase();
  return [...items.filter((it) => n(it).startsWith(q)), ...items.filter((it) => !n(it).startsWith(q) && n(it).includes(q))];
}

// the one new tab, null when none is open
let omni = null;

function omniFit(input) {
  input.style.width = `${(input.value || input.placeholder).length + 1}ch`;
}

function omniRender() {
  if (!omni) return;
  const onApp = omni.host && document.activeElement === omni.app;
  omni.items = onApp ? omniMatch(hostApps(omni.host), omni.app.value) : omniMatch(omniPlaces(), omni.place.value);
  omni.sel = Math.min(omni.sel, Math.max(0, omni.items.length - 1));
  tabMenuTitle.textContent = onApp ? `${omni.host} apps` : 'open';
  tabMenuList.replaceChildren(...omni.items.map((it, i) => {
    const li = el('li', i === omni.sel ? 'sel' : '', it.name);
    li.appendChild(el('span', 'omni-kind', it.kind));
    // focus kept in the title's box
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', () => omniChoose(it));
    return li;
  }));
  if (!omni.items.length) tabMenuList.replaceChildren(el('li', 'empty', 'no match'));
  const why = onApp && appLists.get(omni.host)?.why;
  if (why) tabMenuList.appendChild(el('li', 'empty', why));
  tabMenu.hidden = false;
  const r = omni.btn.getBoundingClientRect();
  tabMenu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - tabMenu.offsetWidth - 8))}px`;
  tabMenu.style.top = `${r.bottom + 10}px`;
}

function omniSetHost(host) {
  omni.host = host;
  if (host) omni.place.value = host;
  omni.app.value = '';
  omni.app.hidden = omni.sep.hidden = !host;
  if (host) fetchApps(host);
  omniFit(omni.place);
  omniFit(omni.app);
  omni.sel = 0;
  (host ? omni.app : omni.place).focus();
  omniRender();
}

function omniChoose(it) {
  if (!it) return;
  if (it.host) return omniSetHost(it.host);
  const id = omni.id;
  omni.btn.remove();
  document.getElementById(`view-${id}`)?.remove();
  openTabs.delete(id);
  omni = null;
  tabMenu.hidden = true;
  it.open();
}

function omniKeys(e) {
  const onApp = e.target === omni.app;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    const n = omni.items.length;
    if (n) omni.sel = (omni.sel + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    omniRender();
  } else if (e.key === 'Enter' || (e.key === 'Tab' && omni.items.length)) {
    omniChoose(omni.items[omni.sel]);
  } else if (e.key === 'Backspace' && onApp && !omni.app.value) {
    omniSetHost(null);
  } else if (e.key === 'Escape') {
    closeTab(omni.id);
  } else return;
  e.preventDefault();
}

function openOmniTab() {
  if (omni) {
    activateTab(omni.id);
    return;
  }
  let n = 1;
  while (openTabs.has(`new-${n}`)) n++;
  const id = `new-${n}`;
  // a div, an input inside a button never focusing in some browsers
  const btn = el('div', 'tab-btn tab-new');
  btn.dataset.tabId = id;
  const place = Object.assign(el('input', 'omni-input'), { placeholder: 'host or page', spellcheck: false, autocomplete: 'off' });
  const app = Object.assign(el('input', 'omni-input'), { placeholder: 'app', spellcheck: false, autocomplete: 'off', hidden: true });
  const sep = Object.assign(el('span', 'omni-sep', '›'), { hidden: true });
  btn.append(el('span', 'tab-label', 'new tab'), place, sep, app);
  addTabClose(btn, id);
  // the page's click, which shuts menus, kept off its own
  btn.addEventListener('click', (e) => { e.stopPropagation(); activateTab(id); });
  for (const input of [place, app]) {
    input.addEventListener('keydown', omniKeys);
    input.addEventListener('focus', () => {
      if (input === app && omni.host) fetchApps(omni.host);
      omniRender();
    });
    input.addEventListener('input', () => {
      omniFit(input);
      // the host's name edited away, its apps with it
      if (input === place && omni.host && place.value !== omni.host) {
        omni.host = null;
        app.hidden = sep.hidden = true;
      }
      omni.sel = 0;
      omniRender();
    });
  }
  btn.addEventListener('focusout', (e) => { if (!btn.contains(e.relatedTarget)) tabMenu.hidden = true; });
  omniFit(place);
  omniFit(app);
  tabbarTabs.appendChild(btn);
  const view = el('div', 'view new-view');
  view.id = `view-${id}`;
  paneContent.appendChild(view);
  omni = { id, btn, place, app, sep, host: null, items: [], sel: 0 };
  openTabs.set(id, {
    show: () => (omni?.host ? omni.app : omni?.place)?.focus(),
    close: () => { omni = null; tabMenu.hidden = true; },
  });
  activateTab(id);
}

tabAddBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  closeMenus();
  openOmniTab();
});
tabMenu.addEventListener('click', (e) => e.stopPropagation());
// placed under the new tab, the scrolling tab bar never clipping it
document.body.appendChild(tabMenu);
document.addEventListener('click', () => closeMenus());

// phones: only the active tab in the bar, a tap on it the list of the rest
const tabPick = document.getElementById('tab-pick');
tabbarTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.tab-btn');
  if (!isMobile() || !btn?.classList.contains('active') || btn.classList.contains('tab-brand') || e.target.closest('.tab-close, input')) return;
  e.stopPropagation();
  const open = tabPick.hidden;
  closeMenus();
  if (!open) return;
  const list = tabPick.querySelector('ul');
  list.replaceChildren(...tabIds().map((id) => {
    const li = el('li', id === btn.dataset.tabId ? 'current' : '', tabbarTabs.querySelector(`.tab-btn[data-tab-id="${id}"] .tab-label`)?.textContent.trim() || id);
    li.tabIndex = 0;
    li.addEventListener('click', () => { tabPick.hidden = true; goTab(-1, id); });
    return li;
  }));
  tabPick.hidden = false;
}, true);
tabPick.addEventListener('click', (e) => e.stopPropagation());

document.querySelector('.tab-btn[data-tab-id="services"]')
  .addEventListener('click', () => activateTab('services'));
document.querySelector('.tab-btn[data-tab-id="about"]')
  .addEventListener('click', () => activateTab('about'));
document.querySelector('.tab-btn[data-tab-id="files"]')
  .addEventListener('click', () => showTab('files'));
document.querySelector('.tab-btn[data-tab-id="status"]')
  .addEventListener('click', () => activateTab('status'));
document.querySelector('.tab-btn[data-tab-id="chat"]')
  .addEventListener('click', () => activateTab('chat'));
document.querySelector('.tab-btn[data-tab-id="projects"]')
  .addEventListener('click', () => activateTab('projects'));
document.querySelector('.tab-btn[data-tab-id="desktop"]')
  .addEventListener('click', () => activateTab('desktop'));

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

const filesPanesEl = document.getElementById('files-panes');
const filesPreview = document.getElementById('files-preview');
const filesMsgEl = document.getElementById('files-msg');
const xferBarEl = document.getElementById('files-xferbar');
const filesPaneTpl = document.getElementById('files-pane-tpl');
const filesActsEl = document.getElementById('files-acts');
const filesAct = (name) => filesActsEl.querySelector(`[data-act="${name}"]`);
const filesInput = document.getElementById('files-input');

let filesPanes = [];
let filesOpened = false;
let filesHostNames = [];
let filesActive = null;

// loc is any {host, share}: a pane, a share row, or the pair a transfer holds
const filesApi = (loc, op, params) => {
  const q = new URLSearchParams({ share: loc.share || '0', ...(params || {}) });
  return `/api/files/${encodeURIComponent(loc.host)}/${op}?${q}`;
};
const filesJoin = (a, b) => (a ? `${a}/${b}` : b);
// host then the share path: razer/hesperus/files/gondor.jpg
const filesPath = (host, root, rel) =>
  [host, ...`${root}/${rel || ''}`.split('/')].filter(Boolean).join('/');
const filesParent = (p) => p.split('/').slice(0, -1).join('/');

// one key per tree node: host alone, share root, or a path under a share
const fkey = (host, share, rel) => `${host}\n${share}\n${rel}`;
const fparts = (key) => {
  const [host, share, ...rel] = key.split('\n');
  return { host, share, rel: rel.join('\n') };
};

function filesMsg(text, bad) {
  filesMsgEl.hidden = !text;
  filesMsgEl.textContent = text || '';
  filesMsgEl.classList.toggle('bad', !!bad);
  if (text) setTimeout(() => { if (filesMsgEl.textContent === text) filesMsgEl.hidden = true; }, 6000);
}

// JSON from every call, failures included, one place to surface them
async function filesCall(loc, op, init, params) {
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

// ---- panes ----------------------------------------------------------------

// host, share, root, perms and cwd: the working directory, where new folders
// and blank-space drops land
function makePane() {
  const el = filesPaneTpl.content.firstElementChild.cloneNode(true);
  const pane = {
    el,
    host: '',
    share: '',
    root: '',
    perms: '',
    cwd: '',
    infos: new Map(),    // host -> {shares, warn}, fetched on first expand
    dirs: new Map(),     // fkey -> entries, the loaded part of the tree
    open: new Set(),     // expanded fkeys
    fetchedAt: new Map(), // fkey -> when its listing landed
    fetching: new Map(), // fkey -> its listing in flight
    sel: new Set(),      // fkeys picked for transfer
    anchor: '',          // where a shift-click range starts
    flat: [],            // visible entry keys in order, for shift ranges
  };
  el.addEventListener('pointerdown', () => setActive(pane));
  el.addEventListener('focusin', () => { if (filesActive !== pane) setActive(pane); });
  const tree = el.querySelector('.files-tree');
  tree.addEventListener('dragover', (e) => dragOver(pane, e));
  tree.addEventListener('dragleave', (e) => { if (!tree.contains(e.relatedTarget)) dragClear(); });
  tree.addEventListener('drop', (e) => dragDrop(pane, e));
  return pane;
}

// a snapshot, so a transfer keeps its target when the working directory moves
const workLoc = (pane) => ({ host: pane.host, share: pane.share, root: pane.root, perms: pane.perms });

// the toolbar acts on whichever pane was last touched
function setActive(pane) {
  filesActive = pane;
  keybarDirty();
  for (const p of filesPanes) p.el.classList.toggle('active', p === pane);
  actsSync();
}

function actsSync() {
  const pane = filesActive;
  filesAct('mkdir').hidden = !pane || !may(pane, 'w');
  filesAct('mkdir').title = pane && pane.host ? `new folder in ${filesPath(pane.host, pane.root, pane.cwd)}` : 'new folder';
}

for (const name of ['mkdir', 'upload', 'refresh', 'split', 'view']) filesAct(name).appendChild(icon(name));
filesAct('mkdir').addEventListener('click', () => paneMkdir(filesActive));
filesAct('upload').addEventListener('click', () => uploadAsk());
filesAct('refresh').addEventListener('click', () => { for (const pane of filesPanes) paneReload(pane); });
filesAct('split').addEventListener('click', () => filesSetSplit(!filesSplit()));
filesAct('view').addEventListener('click', () => {
  filesSetView(filesPreview.hidden);
  // opened on the highlighted file, not an empty view
  filesActive?.el.querySelector('.files-row.sel')?.fileActs?.follow?.();
});

// picked in the upload dialog, used once the file chooser answers
let uploadDest = null;
filesInput.addEventListener('change', () => {
  if (uploadDest) uploadTo(uploadDest.loc, uploadDest.dir, filesInput.files);
  filesInput.value = '';
});

// any writable share on any host, and a folder inside it, one not there yet
// made by the first write
async function uploadAsk() {
  const pane = filesActive;
  await Promise.all(filesHostNames.filter((m) => !pane.infos.has(m)).map((m) => loadHost(pane, m)));
  const locs = filesHostNames.flatMap((m) => pane.infos.get(m).shares).filter((l) => may(l, 'w'));
  if (!locs.length) { filesMsg('no published directory allows uploads', true); return; }
  const at = locs.findIndex((l) => l.host === pane.host && l.share === pane.share);
  const pick = await filesAsk({
    title: 'upload',
    message: 'where the files go, or skip this and drag them from your computer onto any folder',
    where: locs,
    whereAt: Math.max(at, 0),
    value: at === -1 ? '' : pane.cwd,
    actionLabel: 'choose files',
  });
  if (!pick) return;
  uploadDest = pick;
  filesInput.click();
}

// ---- drag and drop --------------------------------------------------------

let filesDrag = null;   // rows in flight: {pane, keys}
let dragMark = null;    // the row, or tree, lit up as the target
let dragExpand = null;  // unfolds a closed folder held under the pointer
const DRAG_EXPAND_MS = 500;
const dragHint = document.createElement('div');
dragHint.className = 'files-drag-hint';
dragHint.hidden = true;
document.body.appendChild(dragHint);

// the selection if the row is part of it, the row alone otherwise
function dragStart(pane, key, e) {
  filesDrag = { pane, keys: pane.sel.has(key) ? [...pane.sel] : [key] };
  e.currentTarget.addEventListener('dragend', dragEnd, { once: true });
  e.dataTransfer.effectAllowed = 'copyMove';
  e.dataTransfer.setData('text/plain', filesDrag.keys.map((k) => fparts(k).rel).join('\n'));
}

function dragClear() {
  if (dragMark) dragMark.classList.remove('drop-ok', 'drop-no');
  dragMark = null;
  dragHint.hidden = true;
  clearTimeout(dragExpand);
}

// on the row itself too: the tree redrawn on unfold, a detached row's
// dragend never reaching the document
const dragEnd = () => { filesDrag = null; dragClear(); };
document.addEventListener('dragend', dragEnd);
// a file let go anywhere else, otherwise opened by the browser in place of the frontend
document.addEventListener('dragover', (e) => {
  if (!e.defaultPrevented && [...e.dataTransfer.types].includes('Files')) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  }
});
document.addEventListener('drop', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });

// a folder row, a file row's folder, or blank space as the working directory
function dropTarget(pane, e) {
  const li = e.target.closest('li');
  if (li) return li.dropAt ? { ...li.dropAt, mark: li } : null;
  return pane.share ? { loc: workLoc(pane), rel: pane.cwd, mark: pane.el.querySelector('.files-tree') } : null;
}

// what letting go here would do, or why it can't, a move inside one share
// only, a copy for anything crossing shares or held with ctrl
function dropPlan(t, e) {
  const where = filesPath(t.loc.host, t.loc.root, t.rel);
  if (!may(t.loc, 'w')) return { bad: `${where} is read-only` };
  if (!filesDrag) return { say: `upload to ${where}` };
  const items = filesDrag.keys.map(fparts);
  const same = (k) => k.host === t.loc.host && k.share === t.loc.share;
  if (items.some((k) => same(k) && `${t.rel}/`.startsWith(`${k.rel}/`))) return { bad: "can't drop a folder into itself" };
  if (items.every((k) => same(k) && filesParent(k.rel) === t.rel)) return { bad: 'already here' };
  const move = items.every(same) && !(e.ctrlKey || e.metaKey);
  return { say: `${move ? 'move' : 'copy'} ${items.length > 1 ? `${items.length} items ` : ''}to ${where}`, move, items };
}

function dragOver(pane, e) {
  if (!filesDrag && ![...e.dataTransfer.types].includes('Files')) return;
  const t = dropTarget(pane, e);
  if (!t) {
    // a host row taking no drop, but still unfolding under a held file
    const li = e.target.closest('li');
    if (li !== dragMark) {
      dragClear();
      dragMark = li;
      if (li?.expandOnDrag) dragExpand = setTimeout(li.expandOnDrag, DRAG_EXPAND_MS);
    }
    return;
  }
  const plan = dropPlan(t, e);
  if (!plan.bad) {
    e.preventDefault();
    e.dataTransfer.dropEffect = plan.move ? 'move' : 'copy';
  }
  if (dragMark !== t.mark) {
    dragClear();
    dragMark = t.mark;
    if (t.mark.expandOnDrag) dragExpand = setTimeout(t.mark.expandOnDrag, DRAG_EXPAND_MS);
  }
  dragMark.classList.toggle('drop-ok', !plan.bad);
  dragMark.classList.toggle('drop-no', !!plan.bad);
  dragHint.textContent = plan.bad || plan.say;
  dragHint.classList.toggle('bad', !!plan.bad);
  dragHint.hidden = false;
  dragHint.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 18}px)`;
}

function dragDrop(pane, e) {
  e.preventDefault();
  const t = dropTarget(pane, e);
  const plan = t && dropPlan(t, e);
  const drag = filesDrag;
  const files = e.dataTransfer.files; // gone once this handler returns
  filesDrag = null;
  dragClear();
  if (!plan || plan.bad) return;
  if (!drag) uploadTo(t.loc, t.rel, files);
  else if (plan.move) moveItems(plan.items, t.loc, t.rel);
  else copyItems(drag.pane, plan.items, t.loc, t.rel);
}

// an unreachable host still given a node, with the error as its note
async function loadHost(pane, host) {
  try {
    const info = await filesCall({ host }, 'info');
    pane.infos.set(host, {
      shares: info.shares.map((sh) => ({ host, share: sh.id, root: sh.label, perms: sh.perms })),
      warn: !info.enabled
        ? `no files directory, set [files] dir in ${host}'s config/hesperus.ini`
        : info.wantDir ? `hesperus.ini now says ${info.wantDir}, rebuilding to mount it` : '',
    });
  } catch (err) {
    pane.infos.set(host, { shares: [], warn: err.message });
  }
}

const shareOf = (pane, host, share) =>
  ((pane.infos.get(host) || {}).shares || []).find((s) => s.share === share);

// true when the listing differs from the one held
async function paneFetch(pane, loc, dir) {
  const key = fkey(loc.host, loc.share, dir);
  const body = await filesCall(loc, 'list', undefined, { path: dir });
  const changed = JSON.stringify(pane.dirs.get(key)) !== JSON.stringify(body.entries);
  pane.dirs.set(key, body.entries);
  pane.fetchedAt.set(key, Date.now());
  if (body.truncated) filesMsg(`${filesPath(loc.host, loc.root, dir)} has more entries than shown`, true);
  return changed;
}

// one listing in flight a folder, a hover's head start shared with its click
function paneList(pane, loc, dir) {
  const key = fkey(loc.host, loc.share, dir);
  if (!pane.fetching.has(key)) pane.fetching.set(key, paneFetch(pane, loc, dir).finally(() => pane.fetching.delete(key)));
  return pane.fetching.get(key);
}

// fetched this recently: shown as held, nothing asked again
const HELD_MS = 5000;
const heldFresh = (pane, key) => pane.dirs.has(key) && Date.now() - (pane.fetchedAt.get(key) || 0) < HELD_MS;

// a closed folder's listing fetched while the pointer rests on it
const HOVER_MS = 60;
function prefetchOnHover(li, pane, loc, rel) {
  let timer = null;
  li.addEventListener('pointerenter', () => {
    if (pane.open.has(fkey(loc.host, loc.share, rel)) || heldFresh(pane, fkey(loc.host, loc.share, rel))) return;
    timer = setTimeout(() => paneList(pane, loc, rel).catch(() => {}), HOVER_MS);
  });
  li.addEventListener('pointerleave', () => clearTimeout(timer));
}

const isWork = (pane, loc, rel) => pane.host === loc.host && pane.share === loc.share && pane.cwd === rel;

function setWork(pane, loc, rel) {
  Object.assign(pane, { host: loc.host, share: loc.share, root: loc.root, perms: loc.perms, cwd: rel });
}

// a pane's starting point: the host unfolded, its first share as the working one
async function paneHome(pane, host) {
  pane.open.add(fkey(host, '', ''));
  if (!pane.infos.has(host)) await loadHost(pane, host);
  const loc = pane.infos.get(host).shares[0];
  if (loc) {
    setWork(pane, loc, '');
    pane.open.add(fkey(host, loc.share, ''));
    await paneFetch(pane, loc, '').catch((err) => filesMsg(`${host}: ${err.message}`, true));
  } else setWork(pane, { host, share: '', root: '', perms: '' }, '');
  paneRender(pane);
}

// everything unfolded fetched again over what's shown, whatever vanished folded away
async function paneReload(pane) {
  const opened = [...pane.open].map(fparts);
  const hosts = new Set(opened.map((k) => k.host).filter((m) => filesHostNames.includes(m)));
  await Promise.all([...hosts].map((m) => loadHost(pane, m)));
  await Promise.all(opened.filter((k) => k.share).map(async (k) => {
    const loc = shareOf(pane, k.host, k.share);
    try {
      if (!loc) throw new Error('gone');
      await paneFetch(pane, loc, k.rel);
    } catch { pane.open.delete(fkey(k.host, k.share, k.rel)); }
  }));
  const here = shareOf(pane, pane.host, pane.share);
  pane.perms = here ? here.perms : '';
  paneRender(pane);
}

// unfolded at once, from what's held or a loading row, the fetch drawn as it lands
async function toggleOpen(pane, key, load) {
  pane.flip = key;
  if (pane.open.has(key)) { pane.open.delete(key); paneRender(pane); return; }
  pane.open.add(key);
  paneRender(pane);
  try {
    if (await load()) paneRender(pane);
  } catch (err) {
    pane.open.delete(key);
    filesMsg(err.message, true);
    paneRender(pane);
  }
}

// a held listing shown first, fetched again behind it unless just fetched,
// drawn again only when it changed
const toggleDir = (pane, loc, rel) => toggleOpen(pane, fkey(loc.host, loc.share, rel),
  () => (heldFresh(pane, fkey(loc.host, loc.share, rel)) ? false : paneList(pane, loc, rel)));

// ---- tree -----------------------------------------------------------------

// rwd with a dash for whatever is missing: rw-, -wd, r-d
const permMask = (perms) => 'rwd'.split('').map((c) => ((perms || '').includes(c) ? c : '-')).join('');

function noteRow(text, depth, cls) {
  const li = document.createElement('li');
  li.className = cls || 'empty';
  li.style.setProperty('--depth', depth);
  li.classList.toggle('guided', depth > 1);
  li.textContent = text;
  return li;
}

// > in the gutter of a row that can unfold, shown on hover, the one just
// toggled born in its old state then turned, as the graph's toggle
function chevron(li, pane, key, expandable) {
  if (!expandable) return;
  li.classList.add('expandable');
  const open = pane.open.has(key);
  const c = document.createElement('span');
  c.className = 'files-chev';
  c.appendChild(chevronIcon());
  c.classList.toggle('open', pane.flip === key ? !open : open);
  if (pane.flip === key) pane.flipEl = c;
  li.prepend(c);
}

// icon and label, the part every row shares
function rowBase(depth, iconName, text) {
  const li = document.createElement('li');
  li.className = 'files-row';
  li.style.setProperty('--depth', depth);
  li.classList.toggle('guided', depth > 1);
  li.tabIndex = 0;
  const name = document.createElement('span');
  name.className = 'files-name';
  name.appendChild(icon(iconName));
  const label = document.createElement('span');
  label.textContent = text;
  name.appendChild(label);
  li.append(name);
  return li;
}

function paneRender(pane) {
  if (pane === filesActive) actsSync();
  // the card's title: where new folders and blank-space drops land
  pane.el.dataset.title = pane.host ? filesPath(pane.host, pane.root, pane.cwd) : 'files';
  pane.flat = []; // rebuilt as the walk goes, so shift ranges match the screen
  const rows = [];
  for (const host of filesHostNames) {
    const mk = fkey(host, '', '');
    const open = pane.open.has(mk);
    const load = () => (pane.infos.has(host) ? null : loadHost(pane, host));
    const li = rowBase(0, 'host', host);
    li.dataset.fk = mk;
    chevron(li, pane, mk, true);
    if (!open) li.expandOnDrag = () => toggleOpen(pane, mk, load);
    li.classList.add('host');
    li.querySelector('.files-name > span').classList.toggle('is-self', host === selfHost);
    li.addEventListener('click', () => toggleOpen(pane, mk, load));
    rows.push(li);
    const info = open && pane.infos.get(host);
    if (!info) continue;
    if (info.warn) rows.push(noteRow(info.warn, 1, 'files-warn'));
    for (const loc of info.shares) {
      const shown = shareRows(pane, loc);
      if (pane.flip === mk) shown[0].classList.add('unfold');
      rows.push(...shown);
    }
  }
  const tree = pane.el.querySelector('.files-tree');
  const focused = tree.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
  tree.replaceChildren(...rows);
  if (focused != null) rows.find((li) => li.dataset.fk === focused)?.focus({ preventScroll: true });
  keybarDirty();
  // styled once in the old state, now on the page, then turned
  if (pane.flipEl) {
    getComputedStyle(pane.flipEl.firstChild).transform;
    pane.flipEl.classList.toggle('open');
  }
  pane.flip = pane.flipEl = null;
}

// a published directory, its permissions beside it, then whatever is unfolded
function shareRows(pane, loc) {
  const key = fkey(loc.host, loc.share, '');
  const open = pane.open.has(key);
  const li = rowBase(1, 'folder', loc.root);
  li.dataset.fk = key;
  const listed = pane.dirs.get(key);
  chevron(li, pane, key, !listed || listed.length > 0);
  if (!open) li.expandOnDrag = () => toggleDir(pane, loc, '');
  prefetchOnHover(li, pane, loc, '');
  const perms = document.createElement('span');
  perms.className = 'files-perms';
  perms.title = 'what this directory allows: read, write, delete';
  perms.textContent = permMask(loc.perms);
  li.querySelector('.files-name').appendChild(perms);
  li.dropAt = { loc, rel: '' };
  li.addEventListener('click', () => {
    const again = open && isWork(pane, loc, '');
    setWork(pane, loc, '');
    if (open && !again) paneRender(pane); else toggleDir(pane, loc, '');
  });
  if (!open) return [li];
  if (!pane.dirs.has(key)) return [li, noteRow('loading', 2)];
  const entries = entryRows(pane, loc, '', 2);
  if (entries.length) return [li, ...entries];
  const empty = noteRow(may(loc, 'w') ? 'drop files here' : 'empty', 2);
  empty.dropAt = li.dropAt;
  return [li, empty];
}

function entryRows(pane, loc, dir, depth) {
  const out = [];
  // the folder just opened: its rows ease in rather than appear
  const fresh = pane.flip === fkey(loc.host, loc.share, dir);
  for (const e of pane.dirs.get(fkey(loc.host, loc.share, dir)) || []) {
    const rel = filesJoin(dir, e.name);
    pane.flat.push(fkey(loc.host, loc.share, rel));
    const row = entryRow(pane, loc, e, rel, depth);
    if (fresh) row.classList.add('unfold');
    out.push(row);
    if (!e.dir || !pane.open.has(fkey(loc.host, loc.share, rel))) continue;
    if (pane.dirs.has(fkey(loc.host, loc.share, rel))) out.push(...entryRows(pane, loc, rel, depth + 1));
    else out.push(noteRow('loading', depth + 1));
  }
  return out;
}

// plain click: selection replaced, ctrl/cmd: one added, shift: the run from
// the anchor, in on-screen row order
function selectRow(pane, key, e) {
  if (e.shiftKey && pane.anchor) {
    const a = pane.flat.indexOf(pane.anchor);
    const b = pane.flat.indexOf(key);
    if (a !== -1 && b !== -1) {
      if (!(e.ctrlKey || e.metaKey)) pane.sel.clear();
      for (const p of pane.flat.slice(Math.min(a, b), Math.max(a, b) + 1)) pane.sel.add(p);
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (pane.sel.has(key)) pane.sel.delete(key); else pane.sel.add(key);
    pane.anchor = key;
  } else {
    pane.sel.clear();
    pane.sel.add(key);
    pane.anchor = key;
  }
  paintSel(pane);
}

// the marks moved in place, the tree itself never drawn again for a click
function paintSel(pane) {
  for (const li of pane.el.querySelectorAll('.files-tree > .files-row')) li.classList.toggle('sel', pane.sel.has(li.dataset.fk));
  keybarDirty();
}

function entryRow(pane, loc, entry, rel, depth) {
  const key = fkey(loc.host, loc.share, rel);
  const open = pane.open.has(key);
  const li = rowBase(depth, entry.dir ? 'folder' : 'file', entry.name);
  li.dataset.fk = key;
  const listed = pane.dirs.get(key);
  chevron(li, pane, key, entry.dir && (listed ? listed.length > 0 : !entry.empty));
  if (entry.dir && !open) li.expandOnDrag = () => toggleDir(pane, loc, rel);
  if (entry.dir && !entry.empty) prefetchOnHover(li, pane, loc, rel);
  if (pane.sel.has(key)) li.classList.add('sel');
  li.draggable = true;
  li.addEventListener('dragstart', (e) => dragStart(pane, key, e));
  li.dropAt = { loc, rel: entry.dir ? rel : filesParent(rel) };

  const meta = document.createElement('span');
  meta.className = 'files-meta';
  meta.textContent = entry.dir ? '' : humanSize(entry.size);

  const acts = document.createElement('span');
  acts.className = 'files-rowacts';
  if (!entry.dir) {
    const dl = document.createElement('a');
    dl.href = filesApi(loc, 'download', { path: rel });
    dl.title = 'download';
    dl.appendChild(icon('download'));
    acts.appendChild(dl);
  }
  if (may(loc, 'w')) {
    const ren = document.createElement('button');
    ren.type = 'button';
    ren.title = 'rename';
    ren.appendChild(icon('rename'));
    ren.addEventListener('click', (e) => { e.stopPropagation(); paneRename(pane, loc, rel, entry.name); });
    acts.appendChild(ren);
  }
  if (may(loc, 'd')) {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'bad';
    del.title = 'delete';
    del.appendChild(icon('trash'));
    del.addEventListener('click', (e) => { e.stopPropagation(); paneDelete(pane, loc, rel, entry); });
    acts.appendChild(del);
  }

  // plain click on a folder: working directory, unfolded too, the same click
  // on the open working folder: folded
  li.addEventListener('click', (e) => {
    if (e.target.closest('.files-rowacts')) return;
    const again = open && isWork(pane, loc, rel);
    selectRow(pane, key, e);
    if (!entry.dir || e.shiftKey || e.ctrlKey || e.metaKey) return;
    setWork(pane, loc, rel);
    if (!open || again) toggleDir(pane, loc, rel); else paneRender(pane);
  });
  // a file: code in the editor, the rest previewed
  const edit = !entry.dir && codeLang(rel)
    ? () => openCodeTab({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, loc.root, rel) }) : null;
  li.addEventListener('dblclick', (e) => {
    if (entry.dir || e.target.closest('.files-rowacts')) return;
    if (isCode(rel)) edit(); else filesShow(loc, rel);
  });
  if (!entry.dir) li.addEventListener('click', () => viewFollow(loc, rel));

  // what the key row offers for this row while it has focus
  li.fileActs = {
    dir: entry.dir,
    follow: entry.dir ? null : () => viewFollow(loc, rel),
    edit,
    download: entry.dir ? null : () => acts.querySelector('a').click(),
    rename: may(loc, 'w') ? () => paneRename(pane, loc, rel, entry.name) : null,
    del: may(loc, 'd') ? () => paneDelete(pane, loc, rel, entry) : null,
  };
  li.append(meta, acts);
  return li;
}

// ---- actions --------------------------------------------------------------

// fresh for every pane holding one of these directories
async function refreshShown(loc, dirs) {
  for (const pane of filesPanes) {
    const shown = [...new Set(dirs)].filter((d) => pane.dirs.has(fkey(loc.host, loc.share, d)));
    if (!shown.length) continue;
    try { await Promise.all(shown.map((d) => paneFetch(pane, loc, d))); } catch (err) { filesMsg(err.message, true); }
    paneRender(pane);
  }
}

async function paneMkdir(pane) {
  const loc = workLoc(pane);
  const dir = pane.cwd;
  const name = await filesAsk({
    title: 'new folder',
    message: `in ${filesPath(loc.host, loc.root, dir)}`,
    value: '',
    actionLabel: 'create',
  });
  if (!name) return;
  try {
    await filesCall(loc, 'mkdir', jsonPost({ path: filesJoin(dir, name) }));
    await refreshShown(loc, [dir]);
  } catch (err) { filesMsg(err.message, true); }
}

async function paneRename(pane, loc, rel, current) {
  const name = await filesAsk({
    title: 'rename',
    message: filesPath(loc.host, loc.root, rel),
    value: current,
    actionLabel: 'rename',
  });
  if (!name || name === current) return;
  try {
    await filesCall(loc, 'rename', jsonPost({ from: rel, to: filesJoin(filesParent(rel), name) }));
    followMove(loc, rel, filesJoin(filesParent(rel), name));
    await refreshShown(loc, [filesParent(rel)]);
  } catch (err) { filesMsg(err.message, true); }
}

async function paneDelete(pane, loc, rel, entry) {
  const what = entry.dir ? `${entry.name} and everything in it` : entry.name;
  const ok = await filesAsk({
    title: 'delete',
    message: `delete ${what} from ${filesPath(loc.host, loc.root, filesParent(rel))}? this cannot be undone.`,
    actionLabel: 'delete',
    danger: true,
  });
  if (!ok) return;
  try {
    await filesCall(loc, 'delete', jsonPost({ path: rel }));
    followMove(loc, rel, filesParent(rel), true);
    const v = filesViewing;
    if (v && v.loc.host === loc.host && v.loc.share === loc.share && `${v.rel}/`.startsWith(`${rel}/`)) viewEmpty();
    await refreshShown(loc, [filesParent(rel)]);
  } catch (err) { filesMsg(err.message, true); }
}

// a working directory inside a moved folder following it, inside a deleted
// one, back to where that stood
function followMove(loc, from, to, gone) {
  for (const pane of filesPanes) {
    pane.sel.delete(fkey(loc.host, loc.share, from));
    if (pane.host !== loc.host || pane.share !== loc.share) continue;
    if (!`${pane.cwd}/`.startsWith(`${from}/`)) continue;
    pane.cwd = gone ? to : to + pane.cwd.slice(from.length);
  }
}

// within one share, a rename without a byte through here
async function moveItems(items, loc, dir) {
  let failed = 0;
  for (const k of items) {
    const name = k.rel.split('/').pop();
    if (filesParent(k.rel) === dir) continue;
    try {
      await filesCall(loc, 'rename', jsonPost({ from: k.rel, to: filesJoin(dir, name) }));
      followMove(loc, k.rel, filesJoin(dir, name));
    } catch (err) { failed += 1; filesMsg(`${name}: ${err.message}`, true); }
  }
  if (!failed) filesMsg(`moved ${items.length} to ${filesPath(loc.host, loc.root, dir)}`);
  await refreshShown(loc, [dir, ...items.map((k) => filesParent(k.rel))]);
}

// raw body, not multipart, the target name in the query string
async function uploadTo(loc, dir, fileList) {
  const list = [...fileList];
  if (!list.length) return;
  if (!may(loc, 'w')) { filesMsg(`${filesPath(loc.host, loc.root, dir)} is read-only`, true); return; }
  const total = list.reduce((n, f) => n + f.size, 0);
  let done = 0;
  let failed = 0;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    try {
      await putFile(loc, filesJoin(dir, f.name), f, (sent) => {
        xferShow(`upload -> ${loc.host}`, i + 1, list.length, f.name, done + sent, total);
      });
      done += f.size;
    } catch (err) { failed += 1; filesMsg(`${f.name}: ${err.message}`, true); }
  }
  xferHide();
  if (!failed) filesMsg(`uploaded ${list.length} to ${filesPath(loc.host, loc.root, dir)}`);
  await refreshShown(loc, [dir]);
}

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

// a pick possibly spanning shares, so each item carrying its own
async function copyItems(from, items, to, dir) {
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const { host, share, rel } = items[i];
    const name = rel.split('/').pop();
    if (host === to.host && share === to.share && filesParent(rel) === dir) {
      failed += 1;
      filesMsg(`${name} is already in ${filesPath(to.host, to.root, dir)}`, true);
      continue;
    }
    const src = { host, share };
    const dst = filesJoin(dir, name);
    const entry = (from.dirs.get(fkey(host, share, filesParent(rel))) || []).find((e) => e.name === name);
    const label = `${host} -> ${to.host}`;
    try {
      if (entry && entry.dir) {
        await copyTree(src, rel, to, dst, (f, child) => xferShow(label, i + 1, items.length, child || name, f, 1));
      } else {
        await copyFile(src, rel, to, dst, (f) => xferShow(label, i + 1, items.length, name, f, 1));
      }
    } catch (err) { failed += 1; filesMsg(`${name}: ${err.message}`, true); }
  }
  xferHide();
  if (!failed) filesMsg(`copied ${items.length} to ${filesPath(to.host, to.root, dir)}`);
  from.sel.clear();
  paneRender(from);
  await refreshShown(to, [dir]);
}

// ---- progress bar ---------------------------------------------------------

// cells at 0.7em, 30 of them about as wide as the 22 at full height
const XFER_CELLS = 30;

// block cells rather than a styled div, to sit with the rest of the UI
function xferShow(label, n, of, name, got, total) {
  const frac = total ? Math.max(0, Math.min(1, got / total)) : 0;
  const full = Math.round(frac * XFER_CELLS);
  xferBarEl.hidden = false;
  xferBarEl.querySelector('.files-xfer-what').textContent = `${label}  ${n}/${of}  ${name}`;
  xferBarEl.querySelector('.files-xfer-cells').textContent = `${'█'.repeat(full)}${'░'.repeat(XFER_CELLS - full)}`;
  xferBarEl.querySelector('.files-xfer-pct').textContent = `${String(Math.round(frac * 100)).padStart(3)}%`;
}

function xferHide() { xferBarEl.hidden = true; }

// ---- view -----------------------------------------------------------------
// right of the panes, or their bottom half in split mode

let filesViewing = null; // {loc, rel, key} last opened

function filesSetView(on) {
  keybarDirty();
  filesPreview.hidden = !on;
  filesAct('view').classList.toggle('on', on);
  if (on && !filesViewing) viewEmpty();
}

// open, the view following the highlighted file
function viewFollow(loc, rel) {
  if (filesPreview.hidden || filesViewing?.key === fkey(loc.host, loc.share, rel)) return;
  filesShow(loc, rel);
}
filesPanesEl.addEventListener('focusin', (e) => e.target.fileActs?.follow?.());

function viewHead(text) {
  const head = document.createElement('div');
  head.className = 'files-preview-head';
  head.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.title = 'close';
  close.textContent = '×';
  close.addEventListener('click', () => filesSetView(false));
  head.appendChild(close);
  return head;
}

function viewEmpty() {
  filesViewing = null;
  const note = document.createElement('div');
  note.className = 'files-note';
  note.textContent = 'highlight a file to view it';
  filesPreview.replaceChildren(viewHead(''), note);
}

// files last read, key -> body, drawn at once on a revisit and handed to an editor
const filesReads = new Map();
const FILES_READS_MAX = 24;
function keepRead(key, body) {
  filesReads.delete(key);
  filesReads.set(key, body);
  if (filesReads.size > FILES_READS_MAX) filesReads.delete(filesReads.keys().next().value);
}

// text inline, an image as an image, anything else a download; a held read
// shown first, fetched again behind it
async function filesShow(loc, rel) {
  const mine = { loc, rel, key: fkey(loc.host, loc.share, rel) };
  filesViewing = mine;
  filesSetView(true);
  const held = filesReads.get(mine.key);
  if (held) viewBody(loc, rel, held);
  else filesPreview.replaceChildren(viewHead(filesPath(loc.host, loc.root, rel)), document.createTextNode('loading...'));
  try {
    const body = await filesCall(loc, 'read', undefined, { path: rel });
    if (filesViewing !== mine) return; // a later click winning
    keepRead(mine.key, body);
    if (held && held.text === body.text && held.size === body.size) return;
    viewBody(loc, rel, body);
  } catch (err) {
    if (filesViewing === mine) filesPreview.replaceChildren(viewHead(filesPath(loc.host, loc.root, rel)), document.createTextNode(err.message));
  }
}

function viewBody(loc, rel, body) {
  const head = viewHead(filesPath(loc.host, loc.root, rel));
  const src = filesApi(loc, 'download', { inline: '1', path: rel });
  let inner;
  if (body.text !== undefined) {
    inner = document.createElement('pre');
    inner.className = 'files-text';
    inner.textContent = body.text;
  } else if (/\.(png|jpe?g|gif|webp|svg)$/i.test(rel)) {
    inner = document.createElement('img');
    inner.className = 'files-img';
    inner.src = src;
    inner.alt = rel;
  } else {
    inner = document.createElement('div');
    inner.className = 'files-note';
    inner.textContent = body.tooBig
      ? `${humanSize(body.size)}, too large to preview, download it instead`
      : 'no preview for this file type';
  }
  if (body.text !== undefined && codeLang(rel)) {
    const open = Object.assign(document.createElement('button'), { type: 'button', className: 'files-edit', textContent: 'edit', title: 'open in the code editor (o)' });
    open.addEventListener('click', () => openCodeTab({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, loc.root, rel) }));
    head.insertBefore(open, head.lastChild);
    const f = { host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, loc.root, rel) };
    const share = Object.assign(document.createElement('button'), { type: 'button', className: 'files-edit', textContent: 'share', title: 'invite someone to work on it with you' });
    share.addEventListener('click', () => shareMenu(share, f, (said) => { share.textContent = said; setTimeout(() => { share.textContent = 'share'; }, 3000); }));
    head.insertBefore(share, head.lastChild);
  }
  filesPreview.replaceChildren(head, inner);
}

// ---- ask ------------------------------------------------------------------

// rename, new folder, delete and upload asked here, not through prompt() and
// confirm(), both outside the page and unstyleable

const filesModal = document.getElementById('files-modal');
const filesAskTitle = document.getElementById('files-ask-title');
const filesAskText = document.getElementById('files-ask-text');
const filesAskWhere = document.getElementById('files-ask-where');
const filesAskInput = document.getElementById('files-ask-input');
const filesAskDirs = document.getElementById('files-ask-dirs');
const filesAskGo = document.getElementById('files-ask-go');
const filesAskCancel = document.getElementById('files-ask-cancel');
const filesAskClose = document.getElementById('files-ask-close');

// the open dialog's answer, settled by whichever button or key ends it
let filesAskSettle = null;
let filesAskLocs = null;

function filesAskEnd(answer) {
  filesModal.hidden = true;
  const settle = filesAskSettle;
  filesAskSettle = null;
  if (settle) settle(answer);
}

// resolves to the typed name, true for a bare confirm, {loc, dir} when given
// shares to pick from, null when dismissed
function filesAsk({ title, message, value, actionLabel, danger, where, whereAt }) {
  filesAskEnd(null); // whatever was open losing
  filesAskTitle.textContent = title;
  filesAskText.textContent = message;
  filesAskGo.textContent = actionLabel || 'ok';
  filesAskGo.classList.toggle('danger', !!danger);
  filesAskGo.classList.toggle('primary', !danger);
  filesAskLocs = where || null;
  filesAskWhere.hidden = !where;
  filesAskWhere.replaceChildren(...(where || []).map((l, i) =>
    new Option(`${filesPath(l.host, l.root, '')}  ${permMask(l.perms)}`, i)));
  if (where) filesAskWhere.selectedIndex = whereAt;
  whereHints();
  filesAskInput.placeholder = where ? 'folder inside it, blank for the top' : '';
  const asksName = value !== undefined;
  filesAskInput.hidden = !asksName;
  filesAskInput.value = asksName ? value : '';
  filesModal.hidden = false;
  if (asksName) { filesAskInput.focus(); filesAskInput.select(); }
  return new Promise((resolve) => { filesAskSettle = resolve; });
}

// folders already seen in the picked share, offered as the path is typed
function whereHints() {
  const loc = filesAskLocs && filesAskLocs[filesAskWhere.selectedIndex];
  const seen = new Set();
  for (const pane of loc ? filesPanes : []) {
    for (const [key, entries] of pane.dirs) {
      const k = fparts(key);
      if (k.host !== loc.host || k.share !== loc.share) continue;
      for (const e of entries) if (e.dir) seen.add(filesJoin(k.rel, e.name));
    }
  }
  filesAskDirs.replaceChildren(...[...seen].sort().map((d) => new Option(d)));
}

filesAskWhere.addEventListener('change', () => { filesAskInput.value = ''; whereHints(); });
filesAskGo.addEventListener('click', () => {
  const text = filesAskInput.value.trim();
  if (filesAskLocs) {
    const dir = text.split('/').filter(Boolean).join('/');
    filesAskEnd({ loc: filesAskLocs[filesAskWhere.selectedIndex], dir });
  } else filesAskEnd(filesAskInput.hidden ? true : text || null);
});
filesAskCancel.addEventListener('click', () => filesAskEnd(null));
filesAskClose.addEventListener('click', () => filesAskEnd(null));
filesAskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); filesAskGo.click(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !filesModal.hidden) filesAskEnd(null); });

// ---- wiring ---------------------------------------------------------------

// the host list: whatever the mesh poll already knows, at no cost
function filesSyncHosts(tailnet) {
  const names = (tailnet || []).filter((d) => d.hesperus).map((d) => d.name).sort();
  if (!names.length || names.join() === filesHostNames.join()) return;
  filesHostNames = names;
  // a first mesh poll possibly after the tab opens, a pane learning its host
  // only here, homed rather than left empty
  for (const pane of filesPanes) {
    if (pane.host && names.includes(pane.host)) paneRender(pane);
    else paneHome(pane, names.includes(selfHost) ? selfHost : names[0]);
  }
}

const filesSplit = () => filesPanesEl.classList.contains('split');

function filesSetSplit(on) {
  keybarDirty();
  filesPanesEl.classList.toggle('split', on);
  filesAct('split').classList.toggle('on', on);
  if (on && filesPanes.length === 1) {
    const second = makePane();
    filesPanes.push(second);
    filesPanesEl.append(second.el);
    // a second pane on the same host no use, started somewhere else
    const other = filesHostNames.find((m) => m !== filesPanes[0].host) || filesPanes[0].host;
    if (other) paneHome(second, other);
  } else if (!on && filesPanes.length === 2) {
    filesPanes.pop().el.remove();
    if (!filesPanes.includes(filesActive)) setActive(filesPanes[0]);
  }
}

function filesOpen() {
  if (filesOpened) { for (const pane of filesPanes) paneReload(pane); return; }
  filesOpened = true;
  const first = makePane();
  filesPanes = [first];
  filesPanesEl.appendChild(first.el);
  setActive(first);
  filesSyncHosts(meshTailnet);
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

const stOpen = () => document.getElementById('view-status').classList.contains('active') && !document.hidden;

// opened on the first look and kept for the page's life: samples and history
// arriving while the tab is away, so coming back never a grey wait
function statusWatch() {
  if (!stOpen() && !chipOut()) return;
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
    chipDraw();
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
  if (stWs && (stOpen() || chipOut()) && Date.now() - stLast > ST_QUIET_MS) statusConnect();
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
  chipDraw();
}

// the model card standing in for the corner chat on the chat tab, redrawn
// once a frame at most, the stats socket open for it as for the status tab
const chipOut = () => stModelEl.parentElement === paneChat && !document.hidden;
let chipFrame = null;
function chipDraw() {
  if (chipFrame || !chipOut()) return;
  chipFrame = requestAnimationFrame(() => { chipFrame = null; drawModelSum(); });
}

// ---- glyphs ----------------------------------------------------------------

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// low to high: sage, clay, rose
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
const HEAT_VAR = { 'st-lo': '--sage', 'st-mid': '--clay', 'st-hi': '--rose' };
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
  if (chipOut()) {
    const line = (cls, label, n) => `<div class="st-row"><i class="${cls}"></i> ${kTok(n).padEnd(5)} <span class="st-dim">${label}</span></div>`;
    const legend = [
      `<div class="st-row">${kTok(used)}/${kTok(m.ctx)} <span class="st-dim">${pct(used / m.ctx)}</span></div>`,
      ...parts.map(([k, label, n]) => line(`ctx-${k} full`, label.split(' ')[0], n)),
      line('', 'free', m.ctx - used),
    ].join('');
    return `<div class="st-ctx st-ctx-chip"><div class="st-ctx-grid">${cells}</div><div class="st-ctx-key">${legend}</div>${loadHtml(m.host)}</div>`;
  }
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
function loadHtml(host) {
  return `<div class="st-ctx-load">${loadKinds(host).map((k) => `<div class="st-box st-${k}"><div class="st-head">${k} <span class="st-dim">${esc(host)}</span></div>`
    + `<canvas class="st-graph st-graph-cpu" data-host="${esc(host)}" data-k="${k}"></canvas><div class="st-row"></div></div>`).join('')}</div>`;
}

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
  const groups = [{ id: 'hesperus', name: 'mesh', models: stModels().map((m) => ({ id: `hesperus/${m.host}`, name: m.file ? `${m.host} · ${m.file}` : m.host })) }];
  for (const p of catalog || []) {
    if (p.id !== 'hesperus' && p.models.length) groups.push({ id: p.id, name: p.id, models: p.models.map((m) => ({ id: `${p.id}/${m.id}`, name: m.name.toLowerCase() })) });
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
// the orangutan first on the projects tab, its own there
const roleOrder = () => (tabbarTabs.querySelector('.tab-btn.active')?.dataset.tabId === 'projects' ? [...MODEL_ROLES].reverse() : MODEL_ROLES);

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
  const providers = (catalog || []).filter((p) => p.id !== 'hesperus');
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
    + '<input class="st-pick-in st-pick-secret" type="text" name="hesperus-provider-key" placeholder="api key" autocomplete="off" '
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
  const live = stNet ? stNet.tailnet.filter((d) => d.hesperus).map((d) => d.name) : [...stHosts.keys()];
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
  keybarDirty();
  const card = stHosts.get(name)?.card?.card;
  card?.focus({ preventScroll: true });
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// arrows: the nearest host that way on screen, false at an edge, for the tabs
function statusStep(dx, dy) {
  const cards = [...stHostsEl.querySelectorAll('.st-card')];
  const at = cards.find((c) => c === document.activeElement);
  if (!at) { cards[0]?.focus(); return !!cards[0]; }
  const mid = (el) => { const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  const [x, y] = mid(at);
  let best = null;
  let bestD = Infinity;
  for (const c of cards) {
    const [cx, cy] = mid(c);
    const along = dx ? (cx - x) * dx : (cy - y) * dy;
    if (c === at || along <= 1) continue;
    const d = along + 2 * Math.abs(dx ? cy - y : cx - x);
    if (d < bestD) { bestD = d; best = c; }
  }
  if (!best) return !!dy;
  best.focus({ preventScroll: true });
  best.scrollIntoView({ block: 'nearest' });
  return true;
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
// mesh and its channels, direct messages, and private hesperus sessions kept in
// this browser. Bubbles: yours on the right, everyone else's on the left,
// hesperus's replies the full width

const chatPanel = document.getElementById('chat-panel');
const chatLog = document.getElementById('chat-log');
// hesperus's [open a terminal on host](#term:host): a terminal tab, never a navigation
chatPanel.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#term:"]');
  if (!a) return;
  e.preventDefault();
  const host = decodeURIComponent(a.getAttribute('href').slice(6));
  if (terminalHosts.includes(host)) openTerminalTab(host);
});
const chatTitle = document.getElementById('chat-title');
const chatStatus = document.getElementById('chat-status');
const chatMenu = document.getElementById('chat-menu');
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
const chatFilesBtn = document.getElementById('chat-files-btn');
const chatPop = document.getElementById('chat-pop');
const chatTabBadge = document.getElementById('chat-tab-badge');

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

let name = localStorage.getItem('hesperus-chat-name') || '';
let color = localStorage.getItem('hesperus-chat-color') || '';
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
  && localStorage.getItem('hesperus-chat-notify') === '1';

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
    localStorage.setItem('hesperus-chat-notify', '0');
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
  localStorage.setItem('hesperus-chat-notify', '1');
  paintBell();
});

// silent, one live popup replaced by the next, a burst never stacking
// an invite to a file past the bell: asked of this person by name
function notifyChat(m, invite = false) {
  if ((!notifyOn && !invite) || !away() || !canNotify || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(m.name, { body: m.text, tag: 'hesperus-chat', silent: true });
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

// --- markdown and math ------------------------------------------------------
// a line's text as markdown, $..$ \(..\) inline and $$..$$ \[..\] display
// math through katex, sanitised, plain text if a library never loaded

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|\$(?=\S)((?:\\\$|[^$\n])+?)(?<=\S)\$(?!\d)/g;
const mdReady = () => !!(window.marked && window.DOMPurify && window.katex);
// text only: pictures come as attachments, never from wherever a line points
const MD_TAGS = ['p', 'br', 'strong', 'em', 'del', 's', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'a', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input',
  'details', 'summary', 'kbd', 'sup', 'sub', 'mark', 'ins', 'abbr'];
const MD_ATTRS = ['href', 'align', 'class', 'start', 'type', 'checked', 'disabled', 'open', 'title', 'colspan', 'rowspan'];
if (window.DOMPurify) {
  // links out of the page, never over it; a task's checkbox the only input
  DOMPurify.addHook('afterSanitizeAttributes', (el) => {
    if (el.tagName === 'A') { el.target = '_blank'; el.rel = 'noopener noreferrer'; }
    if (el.tagName === 'INPUT' && el.getAttribute('type') !== 'checkbox') el.remove();
    if (el.tagName === 'INPUT') el.setAttribute('disabled', '');
  });
}

function renderMd(el, src, breaks = true) {
  if (!mdReady()) { el.textContent = src; return; }
  // code first so a $ in it stays a $, then math, each held by a token
  const held = [];
  const hold = (html) => `\u0001${held.push(html) - 1}\u0001`;
  const code = [];
  let text = src.replace(/```[\s\S]*?(?:```|$)|`[^`\n]+`/g, (m) => `\u0002${code.push(m) - 1}\u0002`);
  text = text.replace(MATH_RE, (m, dd, db, ip, id) => {
    const tex = dd ?? db ?? ip ?? id;
    try {
      return hold(katex.renderToString(tex, { displayMode: dd != null || db != null, throwOnError: false, output: 'html' }));
    } catch {
      return m;
    }
  });
  text = text.replace(/\u0002(\d+)\u0002/g, (_, i) => code[i]);
  const html = DOMPurify.sanitize(marked.parse(text, { breaks, gfm: true }), { ALLOWED_TAGS: MD_TAGS, ALLOWED_ATTR: MD_ATTRS });
  el.innerHTML = html.replace(/\u0001(\d+)\u0001/g, (_, i) => held[i]);
  el.classList.add('md');
  for (const box of el.querySelectorAll('li > input:first-child, li > p:first-child > input:first-child')) box.closest('li').classList.add('task');
  if (held.length) fitMath(el);
  for (const c of el.querySelectorAll('pre > code[class*="language-"]')) {
    const lang = c.className.match(/language-(\S+)/)[1].toLowerCase();
    if (lang === 'mermaid') drawMermaid(c.parentElement, c.textContent);
    else if (window.hljs && hljs.getLanguage(lang)) hljs.highlightElement(c);
  }
}

// --- diagrams -------------------------------------------------------------------
// a mermaid fence drawn in the palette, the library fetched on the first one,
// each drawing kept by theme and source so a redraw while streaming never flickers

const mermaidSvgs = new Map();
let mermaidLoad = null;
let mermaidTheme = '';
let mermaidSeq = 0;
const loadMermaid = () => (mermaidLoad ||= new Promise((resolve, reject) => {
  const s = Object.assign(document.createElement('script'), { src: '/vendor/mermaid.js' });
  s.onload = () => resolve(window.mermaid);
  s.onerror = () => { mermaidLoad = null; reject(new Error('mermaid failed to load')); };
  document.head.appendChild(s);
}));

function mermaidThemed(m) {
  const css = getComputedStyle(document.documentElement);
  const v = (k) => css.getPropertyValue(k).trim();
  const theme = [v('--bg'), v('--fg'), v('--accent')].join();
  if (theme === mermaidTheme) return theme;
  mermaidTheme = theme;
  m.initialize({
    startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: 'base',
    fontFamily: v('--font'),
    themeVariables: {
      background: v('--bg'), fontFamily: v('--font'), fontSize: '12px',
      primaryColor: v('--card'), primaryTextColor: v('--fg'), primaryBorderColor: v('--accent'),
      secondaryColor: v('--card'), secondaryTextColor: v('--fg'), secondaryBorderColor: v('--iris'),
      tertiaryColor: v('--bg'), tertiaryTextColor: v('--fg'), tertiaryBorderColor: v('--sage'),
      lineColor: v('--muted'), textColor: v('--fg'), mainBkg: v('--card'), nodeBorder: v('--accent'),
      clusterBkg: v('--bg'), clusterBorder: v('--border'), edgeLabelBackground: v('--bg'),
      noteBkgColor: v('--card'), noteTextColor: v('--fg'), noteBorderColor: v('--clay'),
      actorBkg: v('--card'), actorBorder: v('--accent'), actorTextColor: v('--fg'), signalColor: v('--muted'),
    },
  });
  return theme;
}

// the source stays up as code until the drawing lands, and if it won't parse
async function drawMermaid(pre, src) {
  pre.classList.add('mermaid-src');
  let m;
  try { m = await loadMermaid(); } catch { return; }
  const key = `${mermaidThemed(m)}\n${src}`;
  let svg = mermaidSvgs.get(key);
  if (svg === undefined) {
    try { svg = (await m.render(`mermaid-${mermaidSeq += 1}`, src)).svg; } catch { svg = ''; }
    mermaidSvgs.set(key, svg);
  }
  if (!svg || !pre.isConnected) return;
  const box = Object.assign(document.createElement('div'), { className: 'mermaid-box' });
  box.innerHTML = svg;
  pre.replaceWith(box);
}

// math wider than its line shrunk to fit, to half size at most, display math
// scrolling past that, inline math breaking only between its bases
const MATH_EM = 1.05;
function fitMath(el) {
  const line = el.closest('.bubble') || el.closest('li');
  if (!line || !line.clientWidth) return;
  for (const k of el.querySelectorAll('.katex')) {
    k.style.fontSize = '';
    const disp = k.closest('.katex-display');
    const bases = [...k.querySelectorAll('.katex-html > *')].map((b) => b.getBoundingClientRect().width);
    const wide = disp ? bases.reduce((a, w) => a + w, 0) : Math.max(0, ...bases);
    const room = (disp || line).clientWidth - 2;
    if (wide > room) k.style.fontSize = `${MATH_EM * Math.max(0.5, room / wide)}em`;
  }
}

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
  if (k.kind === 'edit' && (!m.editAt || m.editAt <= k.timestamp)) { m.edited = k.text; m.editAt = k.timestamp; }
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
    renderMd(rest, body.slice(cmd[0].length).trimStart());
    text.append(el('span', 'cmd', cmd[0]), ' ', rest);
  } else if (body) {
    renderMd(text, addressed(to, body));
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

const CHANNELS_KEY = 'hesperus-chat-channels';
// chat's agents, the orangutan kept for projects; both picked in the model card
const AGENTS = ['chimp'];
const MODEL_ROLES = ['chimp', 'orangutan'];
const AGENT_SUB = { chimp: 'quick' };
const AGENT_KEY = 'hesperus-agents';
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
const LEFT_KEY = 'hesperus-chat-left';
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

const docked = () => cwMain.contains(chatPanel);
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
  if (c === conv && !away() && (docked() || chatPanel.offsetParent)) return;
  news.set(c, (news.get(c) || 0) + 1);
  paintConvs();
}

// every channel: mesh, those with lines, those opened here
function channels() {
  const seen = [...convLines.keys()].filter((c) => c.startsWith('ch:') && convLines.get(c).length).map(chOf)
    .filter((ch) => !(leftChannels[ch] >= lastAt(`ch:${ch}`)));
  return [...new Set([...seen, ...myChannels])].sort();
}

const lastAt = (c) => convLines.get(c)?.at(-1)?.timestamp || 0;
function topicOf(c) {
  return convLines.get(c)?.findLast((m) => m.kind === 'topic' && m.text)?.text || '';
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
  goConv(order[(Math.max(0, at) + step + order.length) % order.length]);
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
  chatTabBadge.hidden = !total;
  chatTabBadge.textContent = `(${total > 99 ? '99+' : total})`;
  chatTitle.querySelector('.chat-title-dot').hidden = !total;
  cwList.replaceChildren(...convItems());
  if (!chatMenu.hidden) chatMenu.firstElementChild.replaceChildren(...convItems());
}

for (const list of [cwList, chatMenu]) {
  list.addEventListener('click', (e) => {
    const more = e.target.closest('.cw-more');
    if (more) { e.stopPropagation(); convMenu(more.dataset.conv, more); return; }
    const b = e.target.closest('.cw-item');
    if (!b) return;
    chatMenu.hidden = true;
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
  keybarDirty();
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
  keybarDirty();
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
    return [read, { label: 'open', act: () => goConv(c) },
      { label: 'leave', sub: 'hide it here until someone posts', act: () => leaveChannel(ch) },
      { label: 'close for everyone', sub: 'its history gone mesh-wide', key: 'd', danger: true, confirm: `sure? close #${ch} for everyone`, act: () => send({ type: 'close', ch }) },
    ].filter(Boolean);
  }
  if (c === 'mesh') {
    return [read, { label: 'clear for everyone', sub: "#mesh's history gone mesh-wide", key: 'd', danger: true, confirm: 'sure? clear #mesh for everyone', act: () => send({ type: 'clear' }) }].filter(Boolean);
  }
  if (isAgent(c)) {
    return [read, { label: 'open', act: () => goConv(c) },
      { label: 'clear conversation', sub: 'and its context, in this browser', key: 'd', danger: true, confirm: `sure? forget the ${c} conversation`, act: () => clearAgent(c) },
    ].filter(Boolean);
  }
  return [read, { label: 'open', act: () => goConv(c) }].filter(Boolean);
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

// the corner's title a menu of every conversation
chatTitle.addEventListener('click', (e) => {
  e.stopPropagation();
  if (docked()) return;
  chatMenu.hidden = !chatMenu.hidden;
  if (!chatMenu.hidden) chatMenu.firstElementChild.replaceChildren(...convItems());
});
document.addEventListener('click', (e) => { if (!chatMenu.hidden && !chatMenu.contains(e.target)) chatMenu.hidden = true; });

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

// the code tab last up and still open: the file the models take "this file" to mean
const chatSees = document.getElementById('chat-sees');
const SEEN_MAX = 24000;
let seenTab = '';
function seenFile() {
  const ed = seenTab && openTabs.get(seenTab);
  if (!ed) return undefined;
  const text = ed.text();
  return { ...ed.file, text: text.slice(0, SEEN_MAX), size: text.length };
}
function paintSeen() {
  const f = seenTab && openTabs.get(seenTab)?.file;
  chatSees.hidden = !f;
  if (!f) return;
  chatSees.textContent = codeName(f);
  chatSees.title = `the chimp sees ${f.label}, the file you have open, and knows you mean it`;
}
document.addEventListener('hesperus-tab', (e) => {
  if (e.detail.startsWith('code-')) seenTab = e.detail;
  paintSeen();
});

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
  keybarDirty();
}

// the chat tab up, on this conversation
function openConv(c) {
  if (isMobile() && mobileSection !== 'main') setMobileSection('main');
  if (!docked()) showTab('chat');
  setConv(c);
}

// wherever the chat is, the tab only on a phone, where the corner isn't
const goConv = (c) => {
  if (isMobile()) return openConv(c);
  if (!chatPane && !docked()) setChatPane(true);
  setConv(c);
};

// the panel into the tab and back, the conversation's lines moved with it,
// not drawn again
document.addEventListener('hesperus-tab', (e) => {
  const tab = e.detail === 'chat';
  if (tab === docked()) return;
  const pinned = chatPinned;
  const top = chatLog.scrollTop;
  (tab ? cwMain : paneChat).appendChild(chatPanel);
  placeModel();
  paintColumn();
  chatMenu.hidden = true;
  chatPinned = pinned;
  chatLog.scrollTop = pinned ? chatLog.scrollHeight : top;
  paintConvs();
  keybarDirty();
});

// the model card's roles in the order the tab puts them
document.addEventListener('hesperus-tab', () => { if (stModel()) { stModelHtml = ''; drawModelSum(); } });

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
let showSeen = Number(localStorage.getItem('hesperus-show-seen')) || 0;

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
    kind: t.role === 'assistant' ? 'model' : t.role === 'notice' ? 'notice' : undefined, text: t.text,
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
  addAgentTurn(w.agent, msg.error ? { role: 'notice', text: said, at: Date.now() } : { role: 'assistant', text: said, ...by, at: Date.now() }, was);
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
    setTimeout(connectChat, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    chatHeard = Date.now();
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'history') {
      renderHistory(msg.messages, msg.closed && typeof msg.closed === 'object' ? msg.closed : {});
    } else if (msg.type === 'message') {
      const { type, ...m } = msg;
      takeLine(m, true);
    } else if (msg.type === 'hesperus-ui') {
      hesperusPressed(msg.action);
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
    if (m.file) openCodeTab(m.file);
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
  goConv(`ch:${ch}`);
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
    goConv(agent);
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
      openCodeTab(f, false);
    });
    return;
  }
  if (cmd === '/dm') {
    const to = nameIn(arg);
    if (!to || to === name) { chatNote('usage: /dm name [message]'); return; }
    const text = arg.slice(to.length).trim();
    if (isAgent(to)) { goConv(to); if (text) sendAgent(to, text); return; }
    goConv(`dm:${to}`);
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
    if (!arg) { chatNote('usage: /rename name'); return; }
    name = arg.slice(0, 32);
    localStorage.setItem('hesperus-chat-name', name);
    send({ type: 'rename', name });
    return;
  }
  if (cmd === '/recolor') {
    const idx = arg ? COLOR_NAMES.indexOf(arg.toLowerCase()) : -1;
    if (arg && idx === -1) { chatNote(`usage: /recolor ${COLOR_NAMES.join('|')}`); return; }
    color = idx !== -1 ? NAME_COLORS[idx] : NAME_COLORS[Math.floor(Math.random() * NAME_COLORS.length)];
    localStorage.setItem('hesperus-chat-color', color);
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
    const f = openTabs.get(id)?.file;
    if (f && (f.label === w || f.path === w || codeName(f) === w || f.label.endsWith(`/${w}`))) return f;
  }
  const [host, ...rest] = w.split('/');
  if (![selfHost, ...hesperusHosts()].includes(host) || !rest.length) return null;
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
  try { localStorage.setItem('hesperus-show-seen', String(showSeen)); } catch {}
  document.getElementById('show-modal-text').replaceChildren(el('b', '', m.name), ' wants to work on ', el('code', '', m.file.label), ' with you, in a shared editor.');
  showModal.hidden = false;
  document.getElementById('show-modal-go').focus();
}
const closeShow = () => { showModal.hidden = true; };
document.getElementById('show-modal-go').addEventListener('click', () => { closeShow(); if (showFile) openCodeTab(showFile); });
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
      list = [...codeTabs.values()].map((id) => openTabs.get(id)?.file).filter(Boolean).map((f) => [f.label, 'open in an editor tab']);
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
const ME_CMDS = [['/rename', 'change your name', 'new name'], ['/recolor', 'change your colour', COLOR_NAMES.join(', ')]];
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
  chatMenu.hidden = true;
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
  localStorage.setItem('hesperus-chat-name', name);
  chatJoin.hidden = true;
  chatCompose.hidden = false;
  connectChat();
});

if (name) {
  chatJoin.hidden = true;
  chatCompose.hidden = false;
  connectChat();
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

// syntax errors by a parse alone, lezer's parsers fetched per language; never evaluated
const parsers = new Map();
function parserFor(check) {
  const [mod, dialect] = check.split(':');
  if (!parsers.has(check)) {
    parsers.set(check, import(`/vendor/lezer/${mod}.js`)
      .then((m) => (dialect ? m.parser.configure({ dialect }) : m.parser)).catch(() => null));
  }
  return parsers.get(check);
}
const ERR_MAX = 50;
function syntaxErrors(parser, text) {
  const out = [];
  parser.parse(text).iterate({
    enter: (n) => {
      if (!n.type.isError || out.length >= ERR_MAX) return;
      const near = n.to > n.from ? text.slice(n.from, n.to) : (text.slice(n.from).match(/^\s*(\S{1,16})/) || [])[1];
      const what = near ? `unexpected ${near.trim().slice(0, 24)}` : 'unexpected end of file';
      if (!out.some((e) => e.from === n.from)) out.push({ from: n.from, to: n.to, what });
    },
  });
  return out;
}

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

// --- tabs ------------------------------------------------------------------------

const CODE_TABS_KEY = 'hesperus-code-tabs';
// host\nshare\npath -> its tab id
const codeTabs = new Map();
let codeSeq = 0;
const codeKey = (f) => `${f.host}\n${f.share}\n${f.path}`;
const codeName = (f) => f.path.split('/').pop() || f.path;

function saveCodeTabs() {
  const list = [...codeTabs.values()].map((id) => openTabs.get(id)?.file).filter(Boolean);
  try { localStorage.setItem(CODE_TABS_KEY, JSON.stringify(list)); } catch {}
}

// a file as the files tab names it: host, then the share's root, then the path
const fileLabel = (host, root, rel) => filesPath(host, root, rel);

function openCodeTab(f, focus = true) {
  const file = { host: f.host, share: String(f.share ?? ''), path: f.path, label: f.label || `${f.host}/${f.path}` };
  if (focus) rememberFile(file);
  const have = codeTabs.get(codeKey(file));
  if (have && openTabs.has(have)) { if (focus) activateTab(have); return openTabs.get(have); }
  const id = `code-${codeSeq += 1}`;
  const btn = createTabButton(id, codeName(file));
  btn.classList.add('code-tab');
  btn.title = file.label;
  tabbarTabs.appendChild(btn);
  syncInks();
  const view = el('div', 'view code-view');
  view.id = `view-${id}`;
  paneContent.appendChild(view);
  const ed = codeEditor(view, file, btn, id);
  openTabs.set(id, ed);
  codeTabs.set(codeKey(file), id);
  saveCodeTabs();
  if (focus) activateTab(id);
  tabMenu.hidden = true;
  return ed;
}

const anyCodeDirty = () => [...codeTabs.values()].some((id) => openTabs.get(id)?.dirty());
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
    if (window.hljs && text.length <= HL_MAX && hljs.getLanguage(lang.hl)) {
      code.innerHTML = `${hljs.highlight(text, { language: lang.hl, ignoreIllegals: true }).value}\n`;
    } else code.textContent = `${text}\n`;
    const lines = text.split('\n').length;
    if (nums.dataset.n !== String(lines)) {
      nums.dataset.n = String(lines);
      nums.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }
    paintMarks();
    checkSoon();
  }
  const redraw = () => { drawFrame ||= requestAnimationFrame(draw); mdSoon(); };

  // --- markdown rendered: the source's blocks drawn, one edited at a time in place ---
  const MD_KEY = 'hesperus-md-rendered';
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
  // its blocks by marked's lexer, each with where its source sits
  function mdBlocks(text) {
    const blocks = [];
    let at = 0;
    try {
      // an html element left open, a <details> say, one block with what it wraps
      let open = 0;
      for (const t of marked.lexer(text)) {
        const from = at;
        at += t.raw.length;
        if (open) blocks.at(-1).raw += t.raw;
        else if (t.type !== 'space') blocks.push({ from, raw: t.raw });
        if (t.type === 'html' || open) open = Math.max(0, open + (t.raw.match(/<details\b/gi) || []).length - (t.raw.match(/<\/details>/gi) || []).length);
      }
    } catch { at = -1; }
    return at === text.length ? blocks : [{ from: 0, raw: text }];
  }
  function paintMd() {
    if (!rendered || mdEditing) return;
    const text = ta.value;
    const top = mdView.scrollTop;
    const blocks = window.marked ? mdBlocks(text) : [{ from: 0, raw: text }];
    const edit = canWrite();
    mdView.replaceChildren(...blocks.map((b) => {
      const d = el('div', 'md-block');
      renderMd(d, b.raw.replace(/\n+$/, ''), false);
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
      if (p.name === name) continue;
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
    keybarDirty();
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

  function connect() {
    if (closed) return;
    const q = new URLSearchParams({ share: file.share, path: file.path });
    sock = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/code/${encodeURIComponent(file.host)}?${q}`);
    sock.onopen = () => { retry = 1000; say({ type: 'join', name: name || 'anon', color: color || colorFor(name || 'anon') }); };
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
        paintState(msg.error);
      }
    };
    sock.onclose = () => {
      ready = false;
      inflight = null;
      if (closed) return;
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
  ta.addEventListener('focus', keybarDirty);
  ta.addEventListener('blur', keybarDirty);

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

  // a held read shown while the session connects, read-only until it lands
  const held = filesReads.get(fkey(file.host, file.share, file.path));
  if (typeof held?.text === 'string') { ta.value = held.text.replace(/\r\n?/g, '\n'); ta.setSelectionRange(0, 0); }
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
      codeTabs.delete(codeKey(file));
      saveCodeTabs();
      if (seenTab === id) { seenTab = ''; paintSeen(); }
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
for (const f of loadJsonSafe(CODE_TABS_KEY)) if (f && f.host && f.path) openCodeTab(f, false);
function loadJsonSafe(key) { try { const v = JSON.parse(localStorage.getItem(key)); return Array.isArray(v) ? v : []; } catch { return []; } }

// --- projects -----------------------------------------------------------------
// the orangutan's long projects, every host's: the list, one's live state, or a
// new one, polled while the tab is up

const pjList = document.getElementById('pj-list');
// a project's longest, as the server holds it
const PJ_MAX_HOURS = 14 * 24;
const pjHead = document.getElementById('pj-head');
const pjBody = document.getElementById('pj-body');
const PJ_POLL_MS = 1000;
// the workspace's files listed again at most this often, on news only
const PJ_FILES_MS = 3000;
const PJ_PHASES = ['plan', 'execute', 'test', 'refine'];
const PJ_ENDED = { done: 'done', blocked: 'blocked', expired: 'out of time', stopped: 'stopped', failed: 'failed' };
let pjAll = [];
let pjSelf = '';
// host/id, or 'new'
let pjPick = '';
let pjOne = null;
let pjTimer = 0;
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

async function pjPoll() {
  try {
    const r = await pjGet('/api/projects');
    pjSelf = r.self;
    pjAll = (r.projects || []).sort((a, b) => (b.status === 'running') - (a.status === 'running') || b.started - a.started);
    if (!pjPick && pjAll.length) pjPick = pjKey(pjAll[0]);
    if (!pjPick && !pjAll.length) pjPick = 'new';
    pjPaintList();
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
  clearInterval(pjTimer);
  pjTimer = 0;
  if (!on) return;
  pjPoll();
  pjTimer = setInterval(() => { if (!document.hidden) pjPoll(); }, PJ_POLL_MS);
}
document.addEventListener('hesperus-tab', (e) => pjWatch(e.detail === 'projects'));

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
  if (key === 'new') pjPaintNew(); else { pjBody.replaceChildren(el('div', 'st-wait', 'loading')); pjPoll(); }
  keybarDirty();
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
    + `${esc(f.path.slice(p.id.length + 1))}</button></li>`).join('') : '<li class="st-dim">empty</li>';
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
    + `<div class="pj-sec"><div class="pj-sec-head">workspace <span class="st-dim">${esc(p.host)}/projects/${p.id}</span></div><ul class="pj-files">${files}</ul></div></div>`
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
  const msg = el('span', 'pj-msg');
  const btns = el('div', 'update-actions');
  btns.append(msg, stop, del, send);
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
  return acts;
}

function pjActsState(acts, p) {
  const live = p.status === 'running';
  acts.querySelector('.pj-note').hidden = !live;
  acts.querySelector('.pj-send').hidden = !live;
  acts.querySelector('.pj-stop').hidden = !live;
  acts.querySelector('.pj-del').hidden = live;
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
  if (f && pjOne) openCodeTab({ host: pjOne.host, share: 'projects', path: f.dataset.path, label: `${pjOne.host}/projects/${f.dataset.path}` });
});

// the workspace's files, again only once something happened there
function pjLoadFiles() {
  const p = pjOne;
  if (!p) return;
  const key = pjKey(p);
  const news = `${p.events.length}:${p.events.at(-1)?.at || 0}`;
  if (pjFiles.key === key && (pjFiles.sig === news || Date.now() - pjFiles.at < PJ_FILES_MS)) return;
  pjFiles = { ...pjFiles, key, at: Date.now(), sig: news };
  pjGet(`/api/files/${encodeURIComponent(p.host)}/tree?share=projects&path=${encodeURIComponent(p.id)}&depth=4`).then((r) => {
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
  const hosts = [...new Set([pjSelf, ...hesperusHosts()].filter(Boolean))].sort((x, y) => (y === pjSelf) - (x === pjSelf) || x.localeCompare(y));
  const first = hosts.find((h) => !busy.has(h)) || hosts[0] || '';
  form.innerHTML = '<p class="pj-intro">The <span class="who-model">orangutan</span> works on it alone in a sandbox on the host picked, in rounds of plan, execute, test and refine, '
    + 'until it says it is done or the time runs out. It reports as it goes; its files land in the read-only projects share.</p>'
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
  keybarDirty();
}

// --- hesperus's presses on this page ----------------------------------------------
// the page moved for whoever asked, as a button would: a view, a terminal, a host

const HESPERUS_VIEWS = { home: 'services', files: 'files', status: 'status', about: 'about', projects: 'projects' };
function hesperusPressed(a) {
  if (!a) return;
  // opened by hesperus, shared with it from the start, s still unshares
  if (a.kind === 'terminal' && terminalHosts.includes(a.host)) openTerminalTab(a.host, undefined, a.share === true);
  else if (a.kind === 'host' && hesperusHosts().includes(a.host)) switchHost(a.host);
  else if (a.kind === 'code' && a.host && a.path) openCodeTab({ host: a.host, share: a.share, path: a.path, label: `${a.host}/${a.path}` });
  else if (a.kind === 'view') {
    if (HESPERUS_VIEWS[a.view]) activateTab(HESPERUS_VIEWS[a.view]);
    else if (a.view === 'chat') openConv('mesh');
    else if (a.view === 'update' && updateModal.hidden) openUpdateModal();
  } else if (a.kind === 'creds') credsAsk(a);
  else if (a.kind === 'creds-close') credsClose(a.id);
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

// every hesperus host and the version it answered with, ours from
// /api/state itself, while a chain runs, in its order, each with its step
function renderVersions() {
  const { tailnet, selfVersion } = updateSeen;
  // one that answered before listed too, as not answering, ours always,
  // even before this host is in its own tailnet view
  const names = tailnet.filter((d) => d.hesperus || d.hesperusSeen).map((d) => d.name);
  if (selfHost && !names.includes(selfHost)) names.push(selfHost);
  const order = updateChain ? [...updateChain.order, ...names.filter((n) => !updateChain.order.includes(n))] : names;
  const isQuiet = (host) => {
    const d = tailnet.find((x) => x.name === host);
    return host !== selfHost && !!d && !!d.hesperusSeen && !d.hesperus;
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
  try { c = await (await fetch('/api/update/check?fresh=1')).json(); } catch {}
  renderUpdateButton();
  const versions = [updateSeen.selfVersion, ...updateSeen.tailnet.filter((d) => d.hesperus).map((d) => d.version)]
    .filter(Boolean);
  // a checkout's version its commit count past the release's MAJOR.MINOR, always behind an install
  const behind = c.latest ? versions.filter((v) => v.split('.').length > 2 || newerVersion(c.latest, v)).length : 0;
  if (!c.latest) {
    openConfirm(`couldn't reach the release feed${c.error ? ` (${c.error})` : ''}. update anyway?`, {
      title: 'update the mesh', actionLabel: 'update', password: true,
      onAction: () => startChain(updatePassField.get()),
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
    title: 'update the mesh', actionLabel: 'update', password: true,
    onAction: () => startChain(updatePassField.get()),
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

// the side column, each card shown or hidden by its own button and stacked
// mesh, model, chat
const CARDS_KEY = 'hesperus-cards';
const CHAT_PANE_KEY = 'hesperus-chat-pane';
const cards = { mesh: true, model: false };
try { Object.assign(cards, JSON.parse(localStorage.getItem(CARDS_KEY) || '{}')); } catch {}
let chatPane = true;
try { chatPane = localStorage.getItem(CHAT_PANE_KEY) !== 'off'; } catch {}

function setCard(k, on) {
  cards[k] = on;
  try { localStorage.setItem(CARDS_KEY, JSON.stringify(cards)); } catch {}
  placeModel();
  paintColumn();
  if (k === 'mesh' && on) drawMesh();
}
function setChatPane(on) {
  chatPane = on;
  try { localStorage.setItem(CHAT_PANE_KEY, on ? 'on' : 'off'); } catch {}
  placeModel();
  paintColumn();
}
// the column gone on a wide screen with nothing in it, the tabs the full width
function paintColumn() {
  const chatIn = chatPane && !docked();
  paneChat.dataset.chat = chatPane ? 'on' : 'off';
  paneChat.dataset.mesh = cards.mesh ? 'on' : 'off';
  sideMesh.setAttribute('aria-expanded', String(cards.mesh));
  sideModel.setAttribute('aria-expanded', String(cards.model));
  sideChat.setAttribute('aria-expanded', String(chatPane));
  // the chat up in its tab: the button with nothing to show or hide
  sideChat.disabled = docked();
  sideChat.title = docked() ? 'chat pane, the chat is in this tab' : 'chat pane (shift+c)';
  layoutEl.classList.toggle('no-side', !cards.mesh && !cards.model && !chatIn);
  meshDims = null;
  const alone = cards.mesh && !cards.model && !chatIn;
  if (alone !== meshAlone) {
    meshAlone = alone;
    const want = alone || meshDesktopExpanded;
    if (isMobile() || want === meshPanel.classList.contains('expanded')) { if (!meshAnimFrame) drawMesh(); } else setMeshExpanded(want, true);
  } else if (cards.mesh && !meshAnimFrame) drawMesh();
  if (typeof railDirty === 'function') railDirty();
  keybarDirty();
}
// barebones in the column above the chat, the rest of the column without it,
// on a phone its own section; else back on the status tab
function placeModel() {
  const full = !chatPane || docked();
  const here = isMobile() ? mobileSection === 'model' : cards.model;
  const before = !isMobile() && chatPanel.parentElement === paneChat ? chatPanel : null;
  if (here && (stModelEl.parentElement !== paneChat || stModelEl.nextElementSibling !== before)) paneChat.insertBefore(stModelEl, before);
  if (!here && stModelEl.parentElement !== stTopEl) stTopEl.appendChild(stModelEl);
  stModelEl.classList.toggle('mini', here && !full && !isMobile());
  stModelHtml = '';
  if (here) { statusWatch(); drawModelSum(); }
}
mobileQuery.addEventListener('change', () => { placeModel(); paintColumn(); });
sideMesh.addEventListener('click', () => setCard('mesh', !cards.mesh));
sideModel.addEventListener('click', () => setCard('model', !cards.model));
sideChat.addEventListener('click', () => setChatPane(!chatPane));

// the rail's labels beside their cards: a shown card's the card's own height,
// a hidden one's a short slot where it would sit, cut from the next card's
// label (else the one before), all stacked at the top with none shown
const railEl = document.getElementById('side-rail');
const RAIL_SLOT_REM = 4.4;
const RAIL_GAP_REM = 0.35;
let railFrame = null;
function paintRail() {
  railFrame = null;
  if (isMobile()) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const slot = RAIL_SLOT_REM * rem;
  const gap = RAIL_GAP_REM * rem;
  const top0 = railEl.getBoundingClientRect().top;
  const open = !layoutEl.classList.contains('no-side');
  const items = [[sideMesh, meshPanel, cards.mesh], [sideModel, stModelEl, cards.model && stModelEl.parentElement === paneChat],
    [sideChat, chatPanel, chatPane && !docked()]].map(([btn, card, on]) => {
    const r = on && open ? card.getBoundingClientRect() : null;
    return r && r.height ? { btn, on: true, top: r.top - top0, bottom: r.bottom - top0 } : { btn, on: false };
  });
  if (!items.some((x) => x.on)) {
    let y = parseFloat(getComputedStyle(railEl).paddingTop);
    for (const x of items) { x.top = y; x.bottom = y + slot; y += slot + gap; }
  } else {
    for (let i = 0; i < items.length;) {
      if (items[i].on) { i += 1; continue; }
      let j = i;
      while (j < items.length && !items[j].on) j += 1;
      const run = items.slice(i, j);
      const next = items[j];
      const prev = items.slice(0, i).reverse().find((x) => x.on);
      if (next) {
        run.forEach((x, k) => { x.top = next.top + k * (slot + gap); x.bottom = x.top + slot; });
        next.top += run.length * (slot + gap);
      } else {
        run.forEach((x, k) => { x.top = prev.bottom - (run.length - k) * (slot + gap) + gap; x.bottom = x.top + slot; });
        prev.bottom -= run.length * (slot + gap);
      }
      i = j;
    }
  }
  for (const x of items) {
    x.btn.style.top = `${x.top}px`;
    x.btn.style.height = `${Math.max(slot, x.bottom - x.top)}px`;
  }
}
const railDirty = () => { if (!railFrame) railFrame = requestAnimationFrame(paintRail); };
const railWatch = new ResizeObserver(railDirty);
for (const e of [meshPanel, stModelEl, chatPanel, paneChat, layoutEl]) railWatch.observe(e);
new MutationObserver(() => topUpdate.setAttribute('aria-expanded', String(!updateModal.hidden))).observe(updateModal, { attributes: true, attributeFilter: ['hidden'] });
placeModel();
paintColumn();

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
    stateRetry = setTimeout(connectState, stateRetryMs);
    stateRetryMs = Math.min(stateRetryMs * 1.5, 5000);
  };
  sock.onerror = () => sock.close();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && stateWs.readyState === WebSocket.CLOSED) connectState();
});
setInterval(pruneConnections, 1000);

connectState();

// --- themes -----------------------------------------------------------------

// the browser's scheme unless one is picked, picking the browser's own drops
// the override, applied before paint by index.html

const THEMES = ['dark', 'light', 'oled'];
const themeToggles = document.querySelectorAll('.theme-toggle');
const themeMenus = [...document.querySelectorAll('.theme-menu')];
const systemLight = matchMedia('(prefers-color-scheme: light)');

const currentTheme = () => document.documentElement.dataset.theme || 'dark';
const openMenu = () => [tabMenu, tabPick, ...themeMenus].find((m) => !m.hidden);
function closeMenus() { for (const m of [tabMenu, tabPick, ...themeMenus]) m.hidden = true; }

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
  try { return localStorage.getItem('hesperus-theme'); } catch { return null; }
}

function setTheme(theme) {
  // a cross-fade for the switch only, never for ordinary hovers
  document.documentElement.classList.add('theme-fade');
  setTimeout(() => document.documentElement.classList.remove('theme-fade'), 350);
  try {
    if (theme === (systemLight.matches ? 'light' : 'dark')) localStorage.removeItem('hesperus-theme');
    else localStorage.setItem('hesperus-theme', theme);
  } catch {}
  applyTheme(theme);
}

const rotateTheme = () => setTheme(THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length]);

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
  });
}
systemLight.addEventListener('change', (e) => { if (!themePick()) applyTheme(e.matches ? 'light' : 'dark'); });
applyTheme(currentTheme());

// --- navigation: swipes, keys and the key bar -------------------------------
// one row of stops, the tabs in order, on a phone mesh and chat after them

function isMobile() { return mobileQuery.matches; }

function slideIn(el, from) {
  el.classList.remove('swipe-in', 'from-left', 'from-right');
  void el.offsetWidth;
  el.classList.add('swipe-in', `from-${from}`);
  const done = (e) => {
    if (e.target !== el) return;
    el.classList.remove('swipe-in', 'from-left', 'from-right');
    el.removeEventListener('animationend', done);
  };
  el.addEventListener('animationend', done);
}

// the accent edge over a bar's active button
function moveInk(bar, btn) {
  const ink = bar.querySelector('.tab-ink');
  if (!ink) return;
  ink.style.width = btn ? `${btn.offsetWidth}px` : '0';
  ink.style.transform = btn ? `translateX(${btn.offsetLeft}px)` : '';
}

function syncInks() {
  moveInk(tabbarTabs, tabbarTabs.querySelector('.tab-btn.active'));
  moveInk(document.getElementById('mobile-tabbar'), document.querySelector('.mobile-tab-btn.active'));
}
window.addEventListener('resize', () => {
  syncInks();
  // narrowed to a phone: the active tab kept in the scrolled bar's view
  tabbarTabs.querySelector('.tab-btn.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
// any tab resizing (the brand's version landing, a label marked unsaved), every tab after it shifted
const tabSizes = new ResizeObserver(syncInks);
const watchTabs = () => document.querySelectorAll('.tab-btn, .mobile-tab-btn').forEach((b) => tabSizes.observe(b));
new MutationObserver(watchTabs).observe(tabbarTabs, { childList: true });
watchTabs();

// the brand off the numbering
const tabIds = () => [...tabbarTabs.querySelectorAll('.tab-btn:not(.tab-brand):not([hidden])')].map((b) => b.dataset.tabId);

function navStops() {
  const tabs = tabIds().map((tab) => ({ tab }));
  return isMobile() ? [...tabs, { section: 'mesh' }, { section: 'model' }] : tabs;
}

function navAt() {
  if (isMobile() && mobileSection !== 'main') return navStops().findIndex((s) => s.section === mobileSection);
  return tabIds().indexOf(tabbarTabs.querySelector('.tab-btn.active')?.dataset.tabId);
}

// false at either end unless wrapping, as the cli's ←/→
function navGo(step, wrap) {
  const stops = navStops();
  let i = navAt() + step;
  if (wrap) i = (i + stops.length) % stops.length;
  if (i < 0 || i >= stops.length) return false;
  const from = step > 0 ? 'right' : 'left';
  const stop = stops[i];
  if (stop.section) setMobileSection(stop.section, from);
  else {
    if (isMobile() && mobileSection !== 'main') setMobileSection('main', from);
    showTab(stop.tab, from);
  }
  return true;
}

function goTab(n, id = tabIds()[n]) {
  if (!id) return;
  if (isMobile() && mobileSection !== 'main') setMobileSection('main');
  showTab(id);
}

// touch and pen only, mouse drags left to text selection and file drag and drop
const SWIPE_PX = 60;
let swipe = null;

layoutEl.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' || !e.isPrimary) return;
  if (e.target.closest('input, textarea, select, .modal, .update-pane, .tab-menu, .dk')) return;
  const main = e.target.closest('.pane-content');
  const side = isMobile() && e.target.closest('.mesh-panel, .chat-panel, #st-model');
  if (main || side) swipe = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), el: null, dx: 0 };
});

layoutEl.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.id) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (!swipe.el) {
    if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
    if (Math.abs(dx) < 12) return;
    swipe.el = isMobile() && mobileSection !== 'main' ? mobileSections[mobileSection] : document.querySelector('.view.active');
    if (!swipe.el) { swipe = null; return; }
    swipe.el.classList.add('dragging');
  }
  // under the finger, heavy past either end, a rubber band
  const i = navAt();
  const edge = (dx > 0 && i <= 0) || (dx < 0 && i >= navStops().length - 1);
  const shown = edge ? dx / 4 : dx;
  swipe.dx = dx;
  swipe.el.style.transform = `translateX(${shown}px)`;
  swipe.el.style.opacity = String(1 - Math.min(0.5, Math.abs(shown) / 600));
});

function swipeEnd(e) {
  if (!swipe || e.pointerId !== swipe.id) return;
  const { el, dx, t } = swipe;
  swipe = null;
  if (!el) return;
  el.classList.remove('dragging');
  const flick = Math.abs(dx) > 25 && Math.abs(dx) / (performance.now() - t) > 0.5;
  const went = e.type === 'pointerup' && (Math.abs(dx) > SWIPE_PX || flick) && navGo(dx < 0 ? 1 : -1);
  if (!went) {
    el.classList.add('settling');
    el.addEventListener('transitionend', () => el.classList.remove('settling'), { once: true });
  }
  el.style.transform = '';
  el.style.opacity = '';
}
layoutEl.addEventListener('pointerup', swipeEnd);
layoutEl.addEventListener('pointercancel', swipeEnd);

// a trackpad's sideways two-finger swipe, its momentum one swipe, not several
let wheelSum = 0;
let wheelLocked = false;
let wheelQuiet = null;

// a sideways scroller under the pointer, with room left to move, keeping the gesture
function scrollsSideways(el, dx) {
  for (; el && el !== paneContent; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth || !/auto|scroll/.test(getComputedStyle(el).overflowX)) continue;
    if (dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0) return true;
  }
  return false;
}

paneContent.addEventListener('wheel', (e) => {
  if (e.ctrlKey || Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.5) return;
  clearTimeout(wheelQuiet);
  wheelQuiet = setTimeout(() => { wheelSum = 0; wheelLocked = false; }, 250);
  if (wheelLocked || scrollsSideways(e.target, e.deltaX)) return;
  wheelSum += e.deltaX;
  if (Math.abs(wheelSum) < 90) return;
  wheelLocked = true;
  navGo(wheelSum > 0 ? 1 : -1);
  wheelSum = 0;
}, { passive: true });

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

// ↑↓: a › walked down the rows, as in the cli's lists, enter to open
const NAV_ROWS = '.list > li > a, .git-name[href], .git-bubble:not(:disabled), .game-card, .join-key-btn, .files-row, .cw-item, .pj-file:not(:disabled)';

// the view's side-by-side columns: services | game servers, or files panes
function navCols(view) {
  return view.id === 'view-files' ? filesPanes.map((p) => p.el) : [...view.querySelectorAll('.home-col, .pj-side, .pj-main')];
}

// ↑↓ within the focused row's column, the join links as one row
function moveSelection(step) {
  const menu = openMenu();
  const view = document.querySelector('.view.active');
  const focused = document.activeElement;
  const scope = menu || view && (navCols(view).find((col) => col.contains(focused)) || view);
  if (!scope) return;
  const rows = [...scope.querySelectorAll(menu ? '.tab-menu-list li:not(.empty)' : NAV_ROWS)]
    .filter((el) => (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : el.offsetParent));
  if (!rows.length) return;
  const at = rows.indexOf(focused.closest?.('.join-key') ? joinKeyBtn : focused);
  const next = at === -1 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + step));
  rows[next].focus();
  rows[next].scrollIntoView({ block: 'nearest' });
}

const modalOpen = () => !!document.querySelector('.modal:not([hidden])');
const shown = (el) => !!el && (el.checkVisibility ? el.checkVisibility({ visibilityProperty: true }) : !!el.offsetParent);

// a popup's go button, never the one that cancels a running update
function modalGo(modal) {
  return [...modal.querySelectorAll('.update-actions button')]
    .filter((b) => b.id !== 'update-cancel' && !b.disabled && shown(b)).pop();
}

// c: the chat wherever it is, on a phone its tab
function focusChat() {
  if (isMobile()) openConv(conv);
  else if (!chatPane && !docked()) setChatPane(true);
  (joined() ? chatText : chatName).focus();
}

// ←→: the next column's row at the same height, never the join links, false
// at the edge for the tabs, on a join link the other one
function sideStep(step) {
  const at = document.activeElement;
  const view = document.querySelector('.view.active');
  if (!view || !view.contains(at) || at === view) return false;
  const join = at.closest('.join-key');
  if (join) {
    const links = [...join.querySelectorAll('button:not(:disabled), a[href]')].filter(shown);
    links[Math.max(0, Math.min(links.length - 1, links.indexOf(at) + step))]?.focus();
    return true;
  }
  const cols = navCols(view);
  const from = cols.findIndex((col) => col.contains(at));
  const to = cols[from + step];
  if (from === -1 || !to) return false;
  const rowsOf = (col) => [...col.querySelectorAll(NAV_ROWS)].filter((el) => shown(el) && !el.closest('.join-key'));
  const rows = rowsOf(to);
  if (!rows.length) return false;
  const pane = filesPanes.find((p) => p.el === to);
  if (pane) setActive(pane);
  const row = rows[Math.min(rows.length - 1, Math.max(0, rowsOf(cols[from]).indexOf(at)))];
  row.focus();
  row.scrollIntoView({ block: 'nearest' });
  return true;
}

const ROW_ENTER = [['.game-card', 'play/stop'], ['.git-bubble', 'make master'], ['.join-key-btn', 'guest key'], ['.files-row', 'open'], ['a, button', 'open']];

// the keys for what is on screen, as groups of [key, label, kind, action],
// no action: only a hint, a leading string for the group's pane name
function keybarKeys() {
  const at = document.activeElement;
  // every key but this one to a focused terminal
  if (at?.closest('.xterm')) return [[['shift+esc', 'unfocus', '', () => at.blur()]]];
  const modal = document.querySelector('.modal:not([hidden])');
  if (modal) {
    const go = modalGo(modal);
    return [[
      modal.querySelector('.modal-header > span')?.textContent.trim().toLowerCase() || 'popup',
      go && ['enter', go.textContent, go.classList.contains('primary') ? 'primary' : 'danger', () => go.click()],
      ['esc', 'close', '', () => modal.querySelector('.modal-close').click()],
    ]];
  }
  const menu = openMenu();
  if (menu === tabMenu && omni) {
    return [['new tab', ['enter', 'open', 'primary', () => omniChoose(omni.items[omni.sel])], ['tab', 'complete', 'quiet'],
      ['↑↓', 'move', 'quiet'], ['esc', 'close', '', () => closeTab(omni.id)]]];
  }
  if (menu) {
    const pick = () => (menu.contains(at) && at.matches('li') ? at : menu.querySelector('li:not(.empty)'))?.click();
    return [[menu === tabMenu ? 'menu' : menu === tabPick ? 'tabs' : 'theme', ['enter', menu === themeMenus[0] ? 'set' : 'open', 'primary', pick], ['esc', 'close', '', closeMenus]]];
  }
  if (at?.classList?.contains('code-ta')) {
    return [['editor', ['esc', 'leave editor', '', () => at.blur()]]];
  }
  if (chatPop.contains(at)) {
    return [['menu', ['enter', at.classList.contains('armed') ? 'confirm' : 'pick', at.classList.contains('danger') ? 'danger' : 'primary', () => at.click()],
      ['↑↓', 'move', 'quiet'], ['esc', 'close', '', () => closePop(true)]]];
  }
  if (at === chatText || at === chatName) {
    const form = at === chatText ? chatForm : chatJoin;
    const box = at === chatText;
    return [[
      'chat',
      ['enter', !box ? 'join' : editing ? 'save' : 'send', 'primary', () => form.requestSubmit()],
      box && ['shift+enter', 'newline', 'quiet'],
      box && ['/', 'commands', 'quiet'],
      ['ctrl+↑↓', 'chats', 'quiet'],
      ['esc', replyTo || editing ? 'cancel' : 'leave chat', '', () => (replyTo || editing ? cancelCompose() : at.blur())],
    ]];
  }

  const id = tabbarTabs.querySelector('.tab-btn.active')?.dataset.tabId || '';
  const view = document.getElementById(`view-${id}`);
  const row = view && view.contains(at) && at !== view ? at : null;
  let here = [];
  if (id.startsWith('term-')) {
    here = [['enter', 'type', 'primary', () => openTabs.get(id)?.focus()],
      ['s', openTabs.get(id)?.shared ? 'unshare' : 'share with hesperus', '', () => toggleShare(id)],
      ['esc', 'close', 'danger', () => closeTab(id)]];
  } else if (id === 'services') {
    const enter = row && ROW_ENTER.find(([sel]) => row.matches(sel));
    here = [
      enter && ['enter', enter[1], 'primary', () => (row.querySelector('.game-btn') || row).click()],
    ];
  } else if (id.startsWith('code-')) {
    const ed = openTabs.get(id);
    here = ed ? [['enter', 'edit', 'primary', () => ed.focus()],
      ['esc', 'close', 'danger', () => closeTab(id)]] : [];
  } else if (id === 'chat') {
    const c = row?.matches('.cw-item') && row.dataset.conv;
    const danger = c && convActions(c).find((it) => it.danger);
    here = [
      ['enter', row ? 'open' : joined() ? 'type' : 'join', 'primary', () => (row ? row.click() : (joined() ? chatText : chatName).focus())],
      danger && ['d', danger.label, 'danger', () => convMenu(c, row, true)],
      ['ctrl+↑↓', 'chats', 'quiet'],
    ];
  } else if (id === 'status') {
    const host = row?.dataset.host;
    here = [
      host && ['enter', host === stOpenHost ? 'close host' : 'open host', 'primary', () => stToggle(host)],
    ];
  } else if (id === 'projects') {
    const live = pjOne && pjOne.status === 'running';
    here = [
      row && ['enter', 'open', 'primary', () => row.click()],
      ['n', 'new project', '', () => pjGo('new')],
      pjOne && pjPick !== 'new' && (live ? ['s', pjArmed === 'stop' ? 'really stop' : 'stop', 'danger', pjStop]
        : ['d', pjArmed === 'delete' ? 'really delete' : 'delete', 'danger', pjDelete]),
    ];
  } else if (id === 'files' && filesActive) {
    const acts = row && row.fileActs;
    here = [
      row && row.matches('.files-row') && ['enter', acts && !acts.dir ? 'select' : 'open', 'primary', () => row.click()],
      acts && acts.del && ['d', 'delete', 'danger', acts.del],
    ];
  }
  if (here.length) here = [here];
  // an editor's or terminal's name already in its tab, none under it
  const tabName = !/^(code|term|new|app)-/.test(id) && tabbarTabs.querySelector('.tab-btn.active .tab-label')?.textContent.trim().toLowerCase();
  const first = here.find((g) => g.some(Array.isArray));
  if (first && tabName) first.unshift(tabName);
  // the open update pane beside the rest, its go on a key of its own
  const go = !updateModal.hidden && modalGo(updateModal);
  // shift+u only with the pane open: a walk's start, or its own step once running
  const start = go && ['mesh-update', 'update-confirm-go'].includes(go.id);
  if (go) here.push(['update', ['shift+u', start ? 'start update' : go.textContent, go.classList.contains('primary') ? 'primary' : 'danger', () => go.click()]]);
  return [...here, [
    ['1-9', 'tabs', 'quiet'],
    ['c', 'chat', 'quiet', focusChat],
    !docked() && ['shift+c', chatPane ? 'hide chat pane' : 'chat pane', 'quiet', () => setChatPane(!chatPane)],
    ['+', 'new tab', 'quiet', () => tabAddBtn.click()],
    ['u', updateModal.hidden ? 'update' : 'close update', 'quiet', toggleUpdatePane],
    ['p', 'about', 'quiet', () => goTab(-1, 'about')],
  ]];}

const keybarEl = document.getElementById('keybar');
let keybarActs = [];

function renderKeybar() {
  const groups = keybarKeys().map((g) => g.filter(Boolean)).filter((g) => g.some(Array.isArray));
  const names = groups.map((g) => (typeof g[0] === 'string' ? g.shift() : ''));
  keybarActs = groups.flat();
  const els = [];
  groups.forEach((g, gi) => {
    if (gi) els.push(Object.assign(document.createElement('span'), { className: 'keybar-sep' }));
    for (const [key, label, kind, act] of g) {
      const el = document.createElement(act ? 'button' : 'span');
      if (act) { el.type = 'button'; el.dataset.i = keybarActs.indexOf(g.find((k) => k[0] === key && k[1] === label)); }
      el.className = act ? kind || '' : 'keybar-hint';
      // the global row first to go on a narrow screen
      if (gi === groups.length - 1 && groups.length > 1) el.dataset.drop = '';
      el.append(Object.assign(document.createElement('b'), { textContent: key }), ` ${label}`);
      // the pane's name over its first key
      if (names[gi] && key === g[0][0] && label === g[0][1]) el.dataset.pane = names[gi];
      els.push(el);
    }
  });
  const sig = els.map((el) => `${el.className}|${el.dataset.pane || ''}|${el.textContent}`).join('\n');
  if (sig !== keybarEl.dataset.sig) {
    keybarEl.dataset.sig = sig;
    keybarEl.replaceChildren(...els);
    fitKeybar();
  }
}

// one row, as the cli's: global keys dropped first, then hints, only the rest
// wrapped
function fitKeybar() {
  const all = [...keybarEl.children];
  for (const el of all) el.hidden = false;
  const drop = [...keybarEl.querySelectorAll('[data-drop], .keybar-hint')].reverse();
  const wraps = () => all.some((el) => !el.hidden && el.offsetTop > all[0].offsetTop + 2);
  while (drop.length && wraps()) drop.shift().hidden = true;
  for (const sep of keybarEl.querySelectorAll('.keybar-sep')) sep.hidden = !!sep.nextElementSibling?.hidden;
}

function keybarDirty() {
  if (keybarDirty.queued) return;
  keybarDirty.queued = true;
  requestAnimationFrame(() => { keybarDirty.queued = false; renderKeybar(); });
}

// focus kept on the row the keys are about, the menu shut by any click
// reaching the page
keybarEl.addEventListener('mousedown', (e) => e.preventDefault());
keybarEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const i = e.target.closest('button')?.dataset.i;
  if (i !== undefined) keybarActs[i]?.[3]();
});
document.addEventListener('focusin', keybarDirty);
document.addEventListener('focusout', keybarDirty);
window.addEventListener('resize', fitKeybar);
const keybarWatch = new MutationObserver(keybarDirty);
for (const el of [...document.querySelectorAll('.modal'), updateModal, tabMenu, ...themeMenus, chatJoin, document.getElementById('git-card')]) {
  keybarWatch.observe(el, { attributes: true, attributeFilter: ['hidden', 'class'], subtree: true });
}
keybarDirty();

// keys by the name the row shows them under
const KEY_NAMES = { ' ': 'space', Enter: 'enter', Delete: 'd', U: 'shift+u', C: 'shift+c' };

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

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  const typing = t.closest?.('input, textarea, select, [contenteditable], .xterm');
  // shift+esc only ever unfocusing a terminal, never closing one
  if (e.key === 'Escape' && e.shiftKey) {
    if (t.closest?.('.xterm')) t.blur();
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    if (typing && t.closest('.chat-panel')) t.blur();
    if (!updateModal.hidden) closeUpdateModal();
    // esc on an unfocused terminal tab: closed
    const id = tabbarTabs.querySelector('.tab-btn.active')?.dataset.tabId || '';
    if (!typing && !openMenu() && !modalOpen() && /^(term|code|new|app)-/.test(id)) closeTab(id);
    closeMenus();
    return;
  }
  if (typing) return;
  // a focused link or button's own enter and space
  if ((e.key === 'Enter' || e.key === ' ') && t.closest?.('a[href], button')) return;
  const name = KEY_NAMES[e.key] || e.key;
  if (/^[1-9]$/.test(e.key) && !modalOpen()) goTab(Number(e.key) - 1);
  else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !modalOpen()) {
    const step = e.key === 'ArrowDown' ? 1 : -1;
    if (!(stOpen() && !openMenu() && statusStep(0, step))) moveSelection(step);
  // unlisted in the key row, ←→ crossing columns first, then tabs
  } else if (['ArrowLeft', 'ArrowRight'].includes(e.key) && !modalOpen()) {
    const step = e.key === 'ArrowRight' ? 1 : -1;
    if (!(stOpen() && !openMenu() ? statusStep(step, 0) : sideStep(step))) navGo(step, true);
  } else {
    renderKeybar();
    const hit = keybarActs.find(([key, , , act]) => act && key === name);
    if (!hit) return;
    hit[3]();
  }
  e.preventDefault();
});

// home closed last visit: the first tab still open, else the about page
if (tabbarTabs.querySelector('.tab-btn.active')?.hidden) activateTab(tabIds()[0] || 'about');

// --- desktop: a pretend remote desktop, every window one of the
// mesh's own terminals, files or services, drawn here

const dkView = document.getElementById('view-desktop');
const DK_USERS_KEY = 'hesperus-dk-users';
const wsBase = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
// creds: host -> {user, pass}, this page's memory only
const dk = { creds: new Map(), rows: new Map(), wins: new Map(), services: [], z: 10, n: 0, desk: null, sig: '' };

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

function dkLoginRow(host) {
  const user = Object.assign(el('input'), { placeholder: 'user', autocomplete: 'username', spellcheck: false, value: dkUsers()[host] || '' });
  const pass = Object.assign(el('input'), { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
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
  box.append(el('div', 'home-col-head', 'desktop'), el('p', 'dk-note', 'ssh into one or more hosts'), list, actions);
  go.addEventListener('click', dkConnect);
  dkView.replaceChildren(box);
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
  }));
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
  const clock = el('span', 'dk-clock');
  const off = Object.assign(el('button', 'dk-off', 'disconnect'), { type: 'button' });
  const bar = el('div', 'dk-bar');
  bar.append(tasks, hosts, clock, off);
  const art = el('div', 'dk-art');
  art.appendChild(document.querySelector('.about-art').cloneNode(true));
  const desk = el('div', 'dk-desk');
  desk.append(art, icons, wins, bar);
  dkView.replaceChildren(desk);
  hosts.replaceChildren(...[...dk.creds.keys()].map((h) => el('span', 'dk-chip', h)));
  off.addEventListener('click', dkDisconnect);
  // a press on bare desk unfocuses every window
  wins.addEventListener('pointerdown', (e) => { if (e.target === wins) dkFocus(null); });
  dk.desk = { el: desk, icons, wins, tasks, clock };
  // the desk resized (side column shown or hidden), floating windows kept on it
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

function dkClock() {
  if (!dk.desk) return;
  dk.desk.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
setInterval(dkClock, 5000);

function dkDisconnect() {
  for (const w of [...dk.wins.values()]) dkClose(w, true);
  dk.creds.clear();
  dk.desk = null;
  dkLogin();
}

const DK_GLYPHS = {
  terminal: 'M2 3h12v10H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
  files: ICONS.folder,
  editor: 'M3 1.5h7l3 3v10H3zM10 1.5v3h3M5 7.5h6M5 10h6M5 12.5h3.5',
  service: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM1.5 8h13M8 1.5c-2.2 2.4-2.2 10.6 0 13M8 1.5c2.2 2.4 2.2 10.6 0 13',
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

function dkIcon(kind, label, sub, open) {
  const b = Object.assign(el('button', `dk-icon dk-${kind}`), { type: 'button', title: sub ? `${label} on ${sub}` : label });
  const tile = el('span', 'dk-tile');
  tile.appendChild(dkGlyph(DK_GLYPHS[kind]));
  b.append(tile, el('span', 'dk-label', label));
  if (sub) b.appendChild(el('span', 'dk-sub', sub));
  b.addEventListener('click', open);
  return b;
}

// rebuilt only when the hosts or services change
function dkIcons() {
  if (!dk.desk) return;
  const hosts = [...dk.creds.keys()];
  const sig = JSON.stringify([hosts, dk.services.map((r) => [r.host, r.name])]);
  if (sig === dk.sig) return;
  dk.sig = sig;
  dk.desk.icons.replaceChildren(
    ...hosts.map((h) => dkIcon('terminal', 'terminal', h, () => dkTerminal(h))),
    dkIcon('files', 'files', '', () => dkFiles()),
    dkIcon('editor', 'editor', '', dkEditorPick),
    ...dk.services.map((r) => dkIcon('service', r.name, r.host, () => dkService(r))),
  );
}

function dkRoutes(services) {
  dk.services = services;
  dkIcons();
  dkLoginHosts();
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
  const grip = el('div', 'dk-grip');
  node.append(head, body, grip);
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
  dkDrag(w, grip, (dx, dy, o) => { w.w = Math.max(280, o.w + dx); w.h = Math.max(160, o.h + dy); });
  wins.appendChild(node);
  tasks.appendChild(task);
  dk.wins.set(w.key, w);
  return w;
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
      if (zone) dkSnap(w, zone);
    };
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp, { once: true });
    head.addEventListener('pointercancel', onUp, { once: true });
  });
}

function dkFocus(w) {
  for (const o of dk.wins.values()) {
    o.node.classList.toggle('focused', o === w);
    o.task.classList.toggle('active', o === w);
  }
  if (!w) return;
  w.node.hidden = false;
  if (w.node.style.zIndex !== String(dk.z)) w.node.style.zIndex = ++dk.z;
  w.onFocus?.();
}

function dkMin(w) {
  w.node.hidden = true;
  w.node.classList.remove('focused');
  w.task.classList.remove('active');
  const top = [...dk.wins.values()].filter((o) => !o.node.hidden).sort((a, b) => b.node.style.zIndex - a.node.style.zIndex)[0];
  if (top) dkFocus(top);
}

function dkMax(w) {
  dkSnap(w, w.snap === 'max' ? '' : 'max');
  dkFocus(w);
}

// force: past an editor's unsaved hold
function dkClose(w, force) {
  if (!force && w.holdClose?.()) return;
  w.onClose?.();
  w.node.remove();
  w.task.remove();
  dk.wins.delete(w.key);
}

// --- the apps

function dkTerminal(host) {
  const c = dk.creds.get(host);
  const w = dkWin(null, 'terminal', host, 'term');
  if (!w || !c) return;
  const t = startTerminal(w.body, host, newSid(), false, false, { ...c });
  w.onFocus = () => t.focus();
  w.onClose = () => t.close();
  dkFocus(w);
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
}

// each connected host's shares, asked once a window
async function fmSide(fm) {
  const hosts = [...dk.creds.keys()];
  const render = () => {
    const out = [el('div', 'fm-side-head', 'hosts')];
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
      const info = await filesCall({ host: h }, 'info');
      fm.shares.set(h, info.enabled
        ? { shares: info.shares.map((sh) => ({ host: h, share: sh.id, root: sh.label, perms: sh.perms })) }
        : { error: 'no files directory' });
    } catch (err) { fm.shares.set(h, { error: err.message }); }
    render();
  }));
  // no place yet: the first share found
  if (!fm.loc) {
    const first = [...fm.shares.values()].find((i) => i.shares?.length);
    if (first) fmGo(fm, first.shares[0], '');
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
}

// every window showing that folder, read again
function fmChanged(loc, ...dirs) {
  for (const fm of dkFms) if (fmSame(fm.loc, loc) && dirs.includes(fm.dir)) fmLoad(fm);
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
    crumbs.push(el('span', 'fm-crumb-host', fm.loc.host));
    const parts = fm.dir ? fm.dir.split('/') : [];
    [fm.loc.root, ...parts].forEach((name, i) => {
      const c = Object.assign(el('button', 'fm-crumb', name), { type: 'button' });
      const to = parts.slice(0, i).join('/');
      c.addEventListener('click', () => to !== fm.dir && fmGo(fm, fm.loc, to));
      fmDropZone(fm, c, () => ({ loc: fm.loc, dir: to }));
      crumbs.push(el('span', 'fm-crumb-sep', '›'), c);
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
    dk.drag = { loc: fm.loc, items: fmPicked(fm) };
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
  if (e.dir) return fmGo(fm, fm.loc, rel);
  if (isCode(e.name)) return dkCode({ host: fm.loc.host, share: fm.loc.share, path: rel, label: fileLabel(fm.loc.host, fm.loc.root, rel) });
  dkViewer(fm.loc, rel);
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

// a right click's menu, on the page so no window's transform shifts it
function fmMenu(fm, x, y, onItem) {
  const picked = fmPicked(fm);
  const one = picked.length === 1 ? fm.shown.find((e) => e.name === picked[0].name) : null;
  const w = fmCan(fm, 'w');
  const items = onItem ? [
    ['open', () => one && fmOpen(fm, one), !!one],
    one && !one.dir && ['open in editor', () => dkCode({ host: fm.loc.host, share: fm.loc.share, path: picked[0].rel, label: fileLabel(fm.loc.host, fm.loc.root, picked[0].rel) }), true],
    one && !one.dir && ['download', () => fmDownload(fm, picked[0].rel), fmCan(fm, 'r')],
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

const dkMenuEl = el('div', 'dk-menu');
dkMenuEl.hidden = true;
dkMenuEl.setAttribute('role', 'menu');
document.body.appendChild(dkMenuEl);
function dkMenu(x, y, items, after) {
  dkMenuEl.replaceChildren(...items.map((it) => {
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
  try {
    await putFile(fm.loc, rel, new Blob([]));
    fmChanged(fm.loc, fm.dir);
    dkCode({ host: fm.loc.host, share: fm.loc.share, path: rel, label: fileLabel(fm.loc.host, fm.loc.root, rel) });
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
        if (it.dir) await copyTree(from, it.rel, to, target, tick);
        else await copyFile(from, it.rel, to, target, tick);
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
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    try {
      fm.busy = 'x';
      await putFile(loc, filesJoin(dir, f.name), f, (sent) => fmSay(fm, `uploading ${f.name} ${f.size ? Math.round((sent / f.size) * 100) : 100}% (${i + 1}/${list.length})`));
    } catch (err) { fm.busy = ''; fmSay(fm, `${f.name}: ${err.message}`, true); }
  }
  fm.busy = '';
  fmSay(fm, `uploaded ${list.length} to ${filesPath(loc.host, loc.root, dir)}`);
  fmChanged(loc, dir);
}

// a folder, a place or blank space taking a drag: the computer's own files
// uploaded, a window's moved inside one share or copied (ctrl) across them
function fmDropZone(fm, node, where) {
  node.addEventListener('dragover', (e) => {
    const t = where();
    if (!t || (!dk.drag && !e.dataTransfer.types.includes('Files'))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = dk.drag && fmSame(dk.drag.loc, t.loc) && !e.ctrlKey && !e.altKey ? 'move' : 'copy';
    fm.main.querySelectorAll('.drop').forEach((x) => x !== node && x.classList.remove('drop'));
    node.classList.add('drop');
  });
  node.addEventListener('dragleave', (e) => { if (!node.contains(e.relatedTarget)) node.classList.remove('drop'); });
  node.addEventListener('drop', (e) => {
    const t = where();
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
  const frame = Object.assign(el('iframe', 'dk-frame'), { src: filesApi(loc, 'download', { path: rel, inline: 1 }), title: rel });
  w.body.appendChild(frame);
  w.onClose = () => { frame.src = 'about:blank'; };
  dkFocus(w);
}

// --- the editor: the code tab's own editor, in a window

function dkCode(f) {
  const file = { host: f.host, share: String(f.share ?? ''), path: f.path, label: f.label || `${f.host}/${f.path}` };
  rememberFile(file);
  const w = dkWin(`code:${codeKey(file)}`, codeName(file), file.host, 'code');
  if (!w) return;
  // a tab already on the file kept as the one the editor's map points to
  const tab = codeTabs.get(codeKey(file));
  const ed = codeEditor(w.body, file, w.node, `dkcode-${dk.n}`);
  w.onFocus = () => { if (!w.body.contains(document.activeElement)) ed.focus(); };
  w.holdClose = () => ed.holdClose();
  w.onClose = () => {
    ed.close();
    if (tab && openTabs.has(tab)) { codeTabs.set(codeKey(file), tab); saveCodeTabs(); }
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

// a press inside a service's frame never reaching the page, its window raised by the page's blur
addEventListener('blur', () => setTimeout(() => {
  const f = document.activeElement;
  const w = f?.classList.contains('dk-frame') && [...dk.wins.values()].find((o) => o.body.contains(f));
  if (w && !w.node.classList.contains('focused')) dkFocus(w);
}));

// shells ended with the page, not left for their grace
addEventListener('pagehide', (e) => { if (!e.persisted) for (const w of [...dk.wins.values()]) if (w.kind === 'term') dkClose(w, true); });

dkLogin();
