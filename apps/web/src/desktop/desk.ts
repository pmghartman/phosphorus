// --- desktop: a pretend remote desktop, every window one of the
// mesh's own terminals, files or services, drawn here
import { acctCall } from '../lib/api.ts';
import { app, appCall } from '../apps/index.ts';
import { chatName, chatText, convNow, dragsFiles, joined, openConv, setConv } from '../features/chat/chat.ts';
import { DK_GLYPHS, DK_UI, dkGlyph, el, isMobile, mobileQuery, stash, svgEl } from '../lib/dom.ts';
import { activeConnections, drawMesh, phosphorusHosts, pingHosts, serviceKey, serviceUrl, startPulseLoop, switchHost, dkMeshTray, type Connection } from '../features/mesh/mesh.ts';
import { noteAdd, notifyOs, dkBellTray } from '../features/notes.ts';
import { dkFms, filesJoin, filesParent, filesWin, fileLabel, fmSame, fmTransfer, fmMark, fmSpring, fmUnspring, fmZones, HOME, homeAt, homeOnline, may, putFile, fmChanged } from '../features/home/home.ts';
import { deskApps, dk, st } from '../lib/state.ts';
import type { AppWant, Route, UiAction } from '@phosphorus/wire';
import { openUpdateModal, updateModal } from '../features/update.ts';
import { newSid } from '../lib/util.ts';
import { agentArm, agentOwn, agentStep, agentViewOn } from '../features/agent.ts';
import { mcpStat, dkMcpTray } from '../features/mcp.ts';
import { dkAppearanceWin, dkControlTray } from './control.ts';
import { dkCode, dkDeskAt, dkDeskWatch, dkFileIcon, dkFileMenu, type FileRef } from './deskfiles.ts';
import { dkLoginHosts } from './login.ts';
import { dkBadge, dkBar, dkChips, dkClock, dkHomeBtn, dkAnchor, dkPlaceItems, type Pop } from './taskbar.ts';
import { dkClose, dkFocus, dkNav, dkPlace, dkSize, dkSnap, dkWin, type DkWin, type NavFrame } from './windows.ts';
import { dkSpotlightTray } from './spotlight.ts';
import { dkSessionHold, dkSessionRestore, dkSessionTry } from './session.ts';

const dkView = document.getElementById('view-desktop')!;

// --- the desktop: icons, windows and a task bar

export function dkDesktop(): void {
  dk.login = null;
  const icons = el('div', 'dk-icons');
  const wins = el('div', 'dk-wins');
  const tasks = el('div', 'dk-tasks');
  const hosts = el('span', 'dk-hosts');
  const desk = el('div', 'dk-desk');
  const bar = dkBar(tasks, hosts);
  bar.prepend(dkHomeBtn());
  const ctl = dkControlTray();
  const bell = dkBellTray();
  const agent = st.acct?.boot ? null : dkMcpTray();
  const search = dkSpotlightTray();
  bar.append(search, ...(agent ? [agent] : []), bell, ctl);
  // the mesh and update panes opened from the panel
  ctl.append(dkMeshTray(dk.ctl!.btn), updateModal);
  dkAnchor(updateModal as Pop, dk.ctl!.btn);
  const menubar = el('div', 'dk-bar dk-menubar');
  const app = el('span', 'dk-menubar-app');
  app.append(dkGlyph(DK_GLYPHS.mesh!, 'dk-menubar-app-ic'), el('span', 'dk-menubar-app-t', 'phosphorus'));
  menubar.append(app);
  desk.append(dkArt(), icons, wins, menubar, bar);
  dkView.replaceChildren(desk);
  dkBand(icons);
  dkDeskMenu(icons);
  dk.desk = { el: desk, icons, wins, tasks, hosts, bar, menubar, app, items: { search, hosts, agent, bell, clock: dk.clock!, profile: ctl } };
  dkPlaceItems();
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
  dkSessionRestore();
}

// a phone's windows always filling the screen
mobileQuery.addEventListener('change', () => {
  if (isMobile()) for (const w of dk.wins.values()) dkSnap(w, 'max');
  dkPlaceItems();
});

export function dkArt(): HTMLElement {
  dkWallPaint();
  const art = el('div', 'dk-art');
  art.appendChild(document.querySelector('.about-mark')!.cloneNode(true));
  return art;
}

// on each minute's turn, not up to 5s after it
(function dkClockTick() {
  dkClock();
  setTimeout(dkClockTick, 60000 - (Date.now() % 60000) + 20);
}());

export function dkLogout(): void {
  // the session kept as it was, never saved empty on the way out
  dkSessionHold(true);
  dk.meshTray?.show(false);
  dk.ctl?.show(false);
  dk.mcp?.show(false);
  // the last user's key and calls never shown to the next
  dk.mcp = null;
  dk.mcpStop?.();
  Object.assign(mcpStat, { configured: false, seen: 0, at: 0, now: 0, got: 0, client: '', calls: [], recent: [], url: '' });
  for (const w of [...dk.wins.values()]) dkClose(w, true);
  dk.creds.clear();
  dk.desk = null;
  dkSessionHold(false);
}

// icons on a grid, any cell, kept per browser; a press selects, a drag moves
// the selection, a double click (a tap on touch) opens
const DK_POS_KEY = 'phosphorus-dk-icons';
const DK_GX = 92;
const DK_GY = 86;
const DK_PAD = 8;

// a service with no icon of its own: its initial in a square
function dkMono(label: string): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: 'ic dk-mono', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('rect', { x: 1.5, y: 1.5, width: 13, height: 13 }));
  const t = svgEl('text', { x: 8, y: 8.6, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  t.textContent = (String(label).match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  svg.appendChild(t);
  return svg;
}

// the first of icons that loads, the glyph kept when none does; again: all asked once more
// after that long, doubling, while the tile is on the desk, a host restarting answering later
function dkTryIcons(tile: HTMLElement, icons: string[], again = 0, retry = false) {
  const srcs = icons.filter(Boolean);
  if (!srcs.length) return;
  if (!retry) {
    tile.classList.add('dk-wait');
    // the glyph shown after a while, a slow host never leaving a hole
    setTimeout(() => tile.classList.remove('dk-wait'), 600);
  }
  const next = (i: number) => {
    if (i === srcs.length) {
      tile.classList.remove('dk-wait');
      if (again) setTimeout(() => { if (tile.isConnected) dkTryIcons(tile, srcs, Math.min(again * 2, 600000), true); }, again);
      return;
    }
    const img = Object.assign(el('img', 'dk-favicon'), { alt: '', decoding: 'async' as const, draggable: false });
    img.addEventListener('load', () => { tile.replaceChildren(img, ...tile.querySelectorAll('.dk-public, .dk-badge')); tile.classList.add('dk-tile-img'); tile.classList.remove('dk-wait'); }, { once: true });
    img.addEventListener('error', () => next(i + 1), { once: true });
    img.src = srcs[i]!;
  };
  next(0);
}

export function dkIcon(kind: string, label: string, sub: string, open: () => void, icon: string | string[] = '', again = 0): HTMLButtonElement {
  const b = Object.assign(el('button', `dk-icon dk-${kind}`), { type: 'button', title: sub ? `${label} on ${sub}` : label });
  const tile = el('span', 'dk-tile');
  tile.appendChild(kind === 'service' ? dkMono(label) : dkGlyph(DK_GLYPHS[kind]!));
  if (kind === 'chat') tile.appendChild(dkBadge());
  // a site's own icon once it loads
  dkTryIcons(tile, ([] as string[]).concat(icon), again);
  b.append(tile, el('span', 'dk-label', label));
  if (sub) b.appendChild(el('span', 'dk-sub', sub));
  b.dataset.id = `${kind}\n${label}\n${sub}`;
  b.addEventListener('dblclick', open);
  // a phone's icons a grid that scrolls, a tap opening
  b.addEventListener('click', () => { if (isMobile()) open(); });
  b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); open(); } });
  b.addEventListener('pointerdown', (e) => dkGrab(e, b, open));
  return b;
}

// a public one badged with a globe, open to all behind its own login only
function dkServiceIcon(r: Route): HTMLButtonElement {
  const b = dkIcon('service', r.name, r.host, () => dkService(r), `/api/favicon/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}`, 30000);
  return r.public ? dkGlobe(b, 'public: no phosphorus login') : b;
}

// the logged in hosts still on the mesh, a dead one's terminal never offered
export function dkLiveHosts(): string[] {
  const up = new Set([...st.terminalHosts, st.selfHost]);
  return [...dk.creds.keys()].filter((h) => up.has(h));
}

// a globe in the tile's corner: reachable without the phosphorus login
function dkGlobe(b: HTMLButtonElement, why: string): HTMLButtonElement {
  b.title += `, ${why}`;
  const g = Object.assign(el('img', 'dk-public'), { src: '/globe.png', alt: '', draggable: false });
  b.querySelector('.dk-tile')!.appendChild(g);
  return b;
}

// rebuilt only when the hosts or services change
export function dkIcons(): void {
  if (!dk.desk) return;
  dkDeskWatch();
  const hosts = dkLiveHosts();
  const git = !!st.gitRoute;
  const webapps = dkWebApps();
  const sig = JSON.stringify([hosts, git, !!st.acct?.admin, dk.services.map((r) => [r.host, r.name, !!r.public]), webapps.map((a) => a.id), dk.deskFiles.map((e) => [e.at, e.name, e.dir, e.mtime, e.hosts, e.stale, e.all])]);
  if (sig === dk.sig) return;
  dk.sig = sig;
  // a host, login or service newly here: a saved window waiting on it opened
  dkSessionTry();
  const files = new Map(dk.deskFiles.map((e) => [`doc\n${filesJoin(e.at!, e.name)}`, e]));
  // one key per icon and what it shows, an unchanged one kept as it is
  const want: [string, () => HTMLButtonElement][] = [
    ...hosts.map((h): [string, () => HTMLButtonElement] => [`terminal\n${h}`, () => dkIcon('terminal', 'terminal', h, () => dkTerminal(h))]),
    ['files', () => dkIcon('files', 'files', '', () => filesWin())],
    ['chat', () => dkIcon('chat', 'chat', '', () => dkOpenApp('chat'))],
    ['status', () => dkIcon('status', 'status', '', () => dkOpenApp('status'))],
    ...(git ? [['git', () => dkGlobe(dkIcon('git', 'git', '', () => dkOpenApp('git')), 'public: its own login only')] as [string, () => HTMLButtonElement]] : []),
    ['code', () => dkIcon('code', 'code', '', () => dkOpenApp('code'))],
    ['agents', () => dkIcon('agents', 'agents', '', () => dkOpenApp('agents'))],
    ['games', () => dkIcon('games', 'games', '', () => dkOpenApp('games'))],
    ['apps', () => dkIcon('apps', 'apps', '', () => dkOpenApp('apps'))],
    ['about', () => dkIcon('about', 'about', '', () => dkOpenApp('about'))],
    ...webapps.map((a): [string, () => HTMLButtonElement] => [`webapp\n${a.id}`, () => dkIcon('app', a.id, '', () => dkWebApp(a.id), a.mount + 'icon.svg')]),
    ...dk.services.map((r): [string, () => HTMLButtonElement] => [JSON.stringify([r.host, r.name, !!r.public]), () => dkServiceIcon(r)]),
    ...[...files.values()].map((e): [string, () => HTMLButtonElement] => [JSON.stringify([e.at, e.name, e.dir, e.mtime, e.hosts, e.stale, e.all, e.live]), () => dkFileIcon(e)]),
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

function dkSaved(): Record<string, [number, number]> {
  try { const v = JSON.parse(localStorage.getItem(DK_POS_KEY)!); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
const dkIconEls = () => (dk.desk ? [...dk.desk.icons.querySelectorAll<HTMLButtonElement>('.dk-icon')] : []);
const dkGrid = () => {
  const { icons } = dk.desk!;
  return {
    cols: Math.max(1, Math.floor((icons.clientWidth - DK_PAD) / DK_GX)),
    rows: Math.max(1, Math.floor((icons.clientHeight - DK_PAD) / DK_GY)),
  };
};
const dkCell = (c: number | string, r: number | string) => `${c},${r}`;

// saved cells first, the rest down then across into the free ones
export function dkLayout(): void {
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
  const taken = new Set<string>();
  const rest: HTMLButtonElement[] = [];
  for (const b of dkIconEls()) {
    const p = saved[b.dataset.id!];
    if (Array.isArray(p) && p[0] < cols && p[1] < rows && !taken.has(dkCell(...p))) {
      taken.add(dkCell(...p));
      dkPut(b, p[0], p[1]);
    } else rest.push(b);
  }
  const busy = (i: number, skipHeld: boolean) => taken.has(dkCell(Math.floor(i / rows), i % rows)) || (skipHeld && held.has(dkCell(Math.floor(i / rows), i % rows)));
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
    const p = saved[b.dataset.id!];
    if (!(Array.isArray(p) && (p[0] >= cols || p[1] >= rows))) { saved[b.dataset.id!] = [c, r]; placed = true; }
  }
  if (placed) try { localStorage.setItem(DK_POS_KEY, JSON.stringify(saved)); } catch {}
  for (const id of [...dk.sel]) if (!dkIconEls().some((b) => b.dataset.id === id)) dk.sel.delete(id);
  dkPaintSel();
}

function dkPut(b: HTMLElement, c: number, r: number) {
  b.dataset.c = String(c);
  b.dataset.r = String(r);
  b.style.transform = `translate(${DK_PAD + c * DK_GX}px, ${DK_PAD + r * DK_GY}px)`;
  if (b.classList.contains('dk-new')) requestAnimationFrame(() => requestAnimationFrame(() => b.classList.remove('dk-new')));
}

function dkSave() {
  const saved = dkSaved();
  for (const b of dkIconEls()) saved[b.dataset.id!] = [Number(b.dataset.c), Number(b.dataset.r)];
  try { localStorage.setItem(DK_POS_KEY, JSON.stringify(saved)); } catch {}
}

function dkPaintSel() {
  for (const b of dkIconEls()) b.classList.toggle('sel', dk.sel.has(b.dataset.id!));
}

function dkGrab(e: PointerEvent, b: HTMLButtonElement, open: () => void) {
  if (e.button !== 0 || isMobile()) return;
  e.preventDefault();
  dkFocus(null);
  b.focus({ preventScroll: true });
  const id = b.dataset.id!;
  const add = e.ctrlKey || e.metaKey;
  const was = dk.sel.has(id);
  if (add) { if (!was) dk.sel.add(id); } else if (!was) dk.sel = new Set([id]);
  dkPaintSel();
  b.setPointerCapture(e.pointerId);
  const moving = dkIconEls().filter((x) => dk.sel.has(x.dataset.id!));
  let dx = 0;
  let dy = 0;
  let dragged = false;
  let frame = 0;
  // files on the desktop carried into a files window: its folder under the pointer
  const files = moving.filter((x) => x.dataset.file);
  let zone: Element | null = null;
  let px = e.clientX;
  let py = e.clientY;
  const aim = () => {
    let z: Element | null = null;
    for (const n of document.elementsFromPoint(px, py)) {
      if (n.closest('.dk-icons')) continue;
      z = n.closest('[data-fm-drop]');
      break;
    }
    const got = z && fmZones.get(z);
    const t = got?.where();
    if (zone && zone !== z) { zone.classList.remove('drop'); fmUnspring(fmZones.get(zone)!.fm, zone); }
    zone = got && t && may(t.loc, 'w') ? z : null;
    if (zone) { fmMark(got!.fm, zone); fmSpring(got!.fm, zone, t!); }
  };
  // a copy riding the pointer above every window
  let ghost: HTMLElement | null = null;
  const paint = () => {
    frame = 0;
    for (const x of moving) x.style.transform = `translate(${DK_PAD + Number(x.dataset.c) * DK_GX + dx}px, ${DK_PAD + Number(x.dataset.r) * DK_GY + dy}px)`;
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
  const onMove = (ev: PointerEvent) => {
    dx = ev.clientX - e.clientX;
    dy = ev.clientY - e.clientY;
    px = ev.clientX;
    py = ev.clientY;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    if (!dragged) { dragged = true; dk.desk!.el.classList.add('dk-moving'); for (const x of moving) x.classList.add('dk-lift'); }
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const onUp = (ev: PointerEvent) => {
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
      const { fm, where } = fmZones.get(zone)!;
      const t = where()!;
      zone.classList.remove('drop');
      fmUnspring(fm);
      for (const x of moving) dkPut(x, Number(x.dataset.c), Number(x.dataset.r));
      const items = files.map((x) => dk.deskFiles.find((f) => filesJoin(f.at!, f.name) === x.dataset.file))
        .filter((f): f is NonNullable<typeof f> => !!f).map((f) => ({ rel: filesJoin(f.at!, f.name), dir: !!f.dir, name: f.name }))
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
function dkDrop(moving: HTMLElement[], dc: number, dr: number) {
  const { cols, rows } = dkGrid();
  const taken = new Set(dkIconEls().filter((x) => !moving.includes(x)).map((x) => dkCell(x.dataset.c!, x.dataset.r!)));
  for (const x of moving) {
    const c0 = Math.max(0, Math.min(cols - 1, Number(x.dataset.c) + dc));
    const r0 = Math.max(0, Math.min(rows - 1, Number(x.dataset.r) + dr));
    let best: { c: number; r: number; d: number } | null = null;
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
function dkBand(icons: HTMLElement) {
  icons.addEventListener('pointerdown', (e) => {
    if (e.target !== icons || e.button !== 0 || isMobile()) return;
    e.preventDefault();
    dkFocus(null);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const keep = e.ctrlKey || e.metaKey ? new Set(dk.sel) : new Set<string>();
    dk.sel = new Set(keep);
    dkPaintSel();
    icons.setPointerCapture(e.pointerId);
    const box = icons.getBoundingClientRect();
    const x0 = e.clientX - box.left;
    const y0 = e.clientY - box.top;
    const band = el('div', 'dk-band');
    let frame = 0;
    let at: PointerEvent | null = null;
    const paint = () => {
      frame = 0;
      const x1 = Math.max(0, Math.min(box.width, at!.clientX - box.left));
      const y1 = Math.max(0, Math.min(box.height, at!.clientY - box.top));
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
        if (il < r && il + i.width > l && it < bt && it + i.height > t) dk.sel.add(b.dataset.id!);
      }
      dkPaintSel();
    };
    const onMove = (ev: PointerEvent) => {
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

// esc and ctrl+a for the icons, a window's own keys left alone; on the document after the
// page's own escape (keys/shortcuts.ts), which marks a shift+esc as handled
export function dkIconKeys(e: KeyboardEvent): void {
  if (!dk.desk || e.defaultPrevented || e.ctrlKey && e.altKey) return;
  const t = e.target as Node;
  if (t !== document.body && !dk.desk.icons.contains(t)) return;
  if (e.key === 'Escape') { dk.sel.clear(); dkPaintSel(); }
  else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    dk.sel = new Set(dkIconEls().map((b) => b.dataset.id!));
    dkPaintSel();
  } else if (/^Arrow(Up|Down|Left|Right)$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // the nearest icon that way, from the focused one or the top left
    const icons = dkIconEls();
    if (!icons.length) return;
    e.preventDefault();
    const from = icons.find((b) => b === document.activeElement) || icons.find((b) => dk.sel.has(b.dataset.id!));
    const at = (b: HTMLElement) => [Number(b.dataset.c), Number(b.dataset.r)] as const;
    let pick: HTMLButtonElement | undefined;
    if (!from) pick = [...icons].sort((a, b) => at(a)[0] - at(b)[0] || at(a)[1] - at(b)[1])[0];
    else {
      const [c0, r0] = at(from);
      const dc = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
      const dr = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
      let best = Infinity;
      for (const b of icons) {
        const [c, r] = at(b);
        const ac = (c - c0) * dc + (r - r0) * dr;
        if (ac <= 0) continue;
        const side = Math.abs((c - c0) * dr) + Math.abs((r - r0) * dc);
        const d = ac * 4 + side;
        if (d < best) { best = d; pick = b; }
      }
    }
    if (!pick) return;
    pick.focus({ preventScroll: true });
    dk.sel = e.shiftKey ? new Set([...dk.sel, pick.dataset.id!]) : new Set([pick.dataset.id!]);
    dkPaintSel();
  }
}

export function dkRoutes(services: Route[]): void {
  dk.services = services;
  dkIcons();
  dkChips();
  dkGitFrame();
  dkLoginHosts();
}

// a host gone from the mesh: its terminals closed, its chip and places gone until it answers again
export function dkHostsGone(): void {
  const up = new Set([...st.terminalHosts, st.selfHost]);
  for (const w of [...dk.wins.values()]) if (w.kind === 'term' && w.host && !up.has(w.host)) dkClose(w, true);
  dkChips();
  for (const fm of dkFms) appCall('files', false, (m) => m.fmHosts(fm));
}

// --- the apps

export function dkTerminal(host: string, run = '', shared = false): DkWin | undefined {
  const c = dk.creds.get(host);
  if (!c) return;
  const w = dkWin(null, 'terminal', host, 'term');
  if (!w) return;
  w.host = host;
  const t = app('terminal').then((m) => m.startTerminal(w.body, host, newSid(), false, shared, { ...c, run }, { themeFrom: w.body }));
  w.onFocus = () => t.then((x) => x.focus());
  w.onClose = () => t.then((x) => x.close());
  dkFocus(w);
  return w;
}

// --- the wallpaper: a picture of the user's, kept in their home on the mesh

const DK_WALL_MAX = 2560;

// the wallpaper set or removed, for the appearance window's row
export const WALL_EVENT = 'phosphorus-wallpaper';
export function dkWallPaint(): void {
  const at = st.acct?.wallpaper || 0;
  dkView.classList.toggle('dk-walled', !!at);
  if (at) dkView.style.setProperty('--dk-wall', `url("/api/me/wallpaper?v=${at}")`);
  else dkView.style.removeProperty('--dk-wall');
  dispatchEvent(new CustomEvent(WALL_EVENT, { detail: at }));
}

// shrunk to the screen's size at most, a jpeg; '' once set, else why not
export async function dkWallSet(blob: Blob): Promise<string> {
  let url;
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, DK_WALL_MAX / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), { width: Math.round(bmp.width * k), height: Math.round(bmp.height * k) });
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    url = c.toDataURL('image/jpeg', 0.85);
  } catch { return 'not an image'; }
  const r = await acctCall('/api/me/wallpaper', { data: url });
  if (!r.ok) return r.error || 'not saved';
  st.acct!.wallpaper = r.wallpaper;
  dkWallPaint();
  return '';
}

export async function dkWallClear(): Promise<void> {
  const r = await acctCall('/api/me/wallpaper', { data: '' });
  if (!r.ok) return;
  st.acct!.wallpaper = 0;
  dkWallPaint();
}

const dkPick = (accept: string, multiple: boolean, then: (files: File[]) => void) => {
  const input = Object.assign(el('input'), { type: 'file', accept, multiple });
  input.addEventListener('change', () => { if (input.files!.length) then([...input.files!]); });
  input.click();
};
// a picture picked for the wallpaper
export const dkWallPick = (): void => dkPick('image/*', false, ([f]) => dkWallSet(f!).then((why) => why && dkMenuNote(why)));

// files about to land on the desktop held to the cell at x, y (else the
// nearest free ones after it), their icons placed there once they show
function dkPlaceAt(x: number, y: number, names: string[], dir = dkDeskAt()?.dir) {
  if (!dk.desk || !dir || !names.length) return;
  const box = dk.desk.icons.getBoundingClientRect();
  const { cols, rows } = dkGrid();
  const c0 = Math.max(0, Math.min(cols - 1, Math.floor((x - box.left - DK_PAD) / DK_GX)));
  const r0 = Math.max(0, Math.min(rows - 1, Math.floor((y - box.top - DK_PAD) / DK_GY)));
  const ids = new Set(names.map((n) => `doc\n${filesJoin(dir, n)}`));
  const taken = new Set(dkIconEls().filter((b) => !ids.has(b.dataset.id!)).map((b) => dkCell(b.dataset.c!, b.dataset.r!)));
  const saved = dkSaved();
  let i = c0 * rows + r0;
  for (const id of ids) {
    while (i < cols * rows && taken.has(dkCell(Math.floor(i / rows), i % rows))) i += 1;
    const at: [number, number] = i < cols * rows ? [Math.floor(i / rows), i % rows] : [c0, r0];
    taken.add(dkCell(...at));
    saved[id] = at;
  }
  try { localStorage.setItem(DK_POS_KEY, JSON.stringify(saved)); } catch {}
}

// a new empty file on the desktop at x, y, on this host, opened to edit
function dkNewFile(x: number, y: number) {
  const d = dkDeskAt();
  if (!d) return;
  const pop = el('form', 'acct-unlock dk-newfile') as HTMLFormElement & Pop;
  const name = Object.assign(el('input'), { value: 'untitled.txt', spellcheck: false, autocomplete: 'off' as const });
  const why = el('span', 'dk-state');
  const go = Object.assign(el('button', 'primary', 'create'), { type: 'submit' });
  pop.append(el('div', 'home-col-head', 'add file'), name, why, go);
  pop.style.left = `${Math.max(4, Math.min(x, innerWidth - 260))}px`;
  pop.style.top = `${Math.max(4, Math.min(y, innerHeight - 140))}px`;
  const close = () => { pop.remove(); pop.dkRelease?.(); document.removeEventListener('pointerdown', away, true); };
  const away = (e: PointerEvent) => { if (!pop.contains(e.target as Node)) close(); };
  document.addEventListener('pointerdown', away, true);
  pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  pop.addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n || /[\\/]/.test(n)) { why.textContent = 'no slashes'; return; }
    if (dk.deskFiles.some((f) => f.at === d.dir && f.name === n)) { why.textContent = 'exists'; return; }
    const loc = homeAt(st.selfHost);
    const rel = filesJoin(d.dir, n);
    go.disabled = true;
    try { await putFile(loc, rel, new Blob([])); } catch (err) { go.disabled = false; why.textContent = (err as Error).message; return; }
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
async function dkAddFiles(list: File[]) {
  const fm = dk.desk && await filesWin(dkDeskAt() || undefined);
  if (fm && list.length) fm.pendingUpload = list;
}

// a right click on the desk or an icon, a drop of the computer's files
function dkDeskMenu(icons: HTMLElement) {
  icons.addEventListener('contextmenu', (e) => {
    const b = (e.target as Element).closest('.dk-icon') as HTMLElement | null;
    if (e.target !== icons && !b) return;
    e.preventDefault();
    if (b && !dk.sel.has(b.dataset.id!)) { dk.sel = new Set([b.dataset.id!]); dkPaintSel(); }
    const hosts = dkLiveHosts();
    const f = b && dk.deskFiles.find((x) => filesJoin(x.at!, x.name) === b.dataset.file);
    if (f) { dkMenu(e.clientX, e.clientY, dkFileMenu(f)); return; }
    const [kind, name, host] = b ? b.dataset.id!.split('\n') : [];
    const svc = kind === 'service' && dk.services.find((r) => r.host === host && r.name === name);
    const items: MenuItem[] = [
      ...(b ? [['open', () => b.dispatchEvent(new MouseEvent('dblclick')), true] as MenuItem] : []),
      ...(svc && st.acct?.admin ? [[svc.public ? 'make private' : 'make public', () => dkSetPublic(svc, !svc.public), true] as MenuItem] : []),
      ...(b ? [null] : []),
      ['new terminal', hosts.map((h): MenuItem => [h, () => dkTerminal(h), true]), hosts.length > 0],
      null,
      ['add file…', () => dkNewFile(e.clientX, e.clientY), !!dkDeskAt()],
      ['upload files…', () => dkPick('', true, (list) => { dkPlaceAt(e.clientX, e.clientY, list.map((f) => f.name)); dkAddFiles(list); }), homeOnline().length > 0],
      null,
      ['change wallpaper…', dkWallPick, !!st.acct && !st.acct.boot],
      ['appearance…', () => dkAppearanceWin('desktop'), true],
      null,
      ['select all', () => { dk.sel = new Set(dkIconEls().map((x) => x.dataset.id!)); dkPaintSel(); }, true],
      ['arrange icons', dkArrange, true],
    ];
    dkMenu(e.clientX, e.clientY, items);
  });
  icons.addEventListener('dragover', (e) => {
    if (!(dragsFiles(e) || (dk.drag && dkDeskAt()))) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
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
    const list = [...e.dataTransfer!.files];
    dkPlaceAt(e.clientX, e.clientY, list.map((f) => f.name));
    dkAddFiles(list);
  });
}

// a word in the clock's place a moment
export function dkMenuNote(text: string): void {
  if (!dk.clock) return;
  dk.clock.textContent = text;
  setTimeout(dkClock, 4000);
}

// every icon back in the default order
export function dkArrange(): void {
  try { localStorage.setItem(DK_POS_KEY, '{}'); } catch {}
  dkLayout();
}

// one item of a right click's menu: label, its action (or a submenu's items), whether it's
// enabled, a class; null a separator
export type MenuItem = [string, (() => unknown) | MenuItem[], boolean, string?] | null;

export const dkMenuEl = el('div', 'dk-menu') as HTMLElement & Pop & { owner?: Element | null };
dkMenuEl.hidden = true;
dkMenuEl.setAttribute('role', 'menu');
document.body.appendChild(dkMenuEl);
// a press on its owner left to the owner's own toggle
document.addEventListener('pointerdown', (e) => { if (!dkMenuEl.contains(e.target as Node) && !dkMenuEl.owner?.contains(e.target as Node)) dkMenuEl.hidden = true; }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dkMenuEl.hidden = true; }, true);
addEventListener('blur', () => { dkMenuEl.hidden = true; });

export function dkMenu(x: number, y: number, items: MenuItem[], after?: () => void, title?: string): void {
  dkMenuEl.owner = null;
  dkMenuEl.classList.remove('dk-pop');
  dkMenuEl.dkAnchor = null;
  dkMenuEl.style.bottom = '';
  const item = (it: MenuItem): HTMLElement => {
    if (!it) return el('div', 'dk-menu-sep');
    const [label, act, ok, cls] = it;
    const b = Object.assign(el('button', cls || '', label), { type: 'button', disabled: !ok });
    if (!Array.isArray(act)) {
      b.addEventListener('click', () => { dkMenuEl.hidden = true; after?.(); act(); });
      return b;
    }
    // a list for its act: a submenu out to the side on hover, as Windows' own
    b.classList.add('dk-menu-more');
    const wrap = el('div', 'dk-menu-item');
    const sub = el('div', 'dk-menu dk-submenu');
    sub.append(...act.map(item));
    wrap.append(b, sub);
    const open = () => {
      if (b.disabled) return;
      for (const o of wrap.parentElement!.querySelectorAll(':scope > .dk-menu-item.open')) if (o !== wrap) o.classList.remove('open');
      wrap.classList.add('open');
      const r = b.getBoundingClientRect();
      sub.classList.toggle('left', r.right + sub.offsetWidth > innerWidth - 4);
      sub.style.top = `${Math.min(0, innerHeight - 4 - r.top - sub.offsetHeight)}px`;
    };
    wrap.addEventListener('pointerenter', open);
    wrap.addEventListener('pointerleave', () => wrap.classList.remove('open'));
    b.addEventListener('click', open);
    b.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { open(); (sub.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus(); } });
    sub.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { wrap.classList.remove('open'); b.focus(); } });
    return wrap;
  };
  dkMenuEl.replaceChildren(...(title ? [el('div', 'dk-menu-title', title)] : []), ...items.map(item));
  dkMenuEl.hidden = false;
  dkMenuEl.style.left = `${Math.min(x, innerWidth - dkMenuEl.offsetWidth - 4)}px`;
  dkMenuEl.style.top = `${Math.min(y, innerHeight - dkMenuEl.offsetHeight - 4)}px`;
}

// a service behind the phosphorus login or open to all, its owning host's services.export rewritten
async function dkSetPublic(r: Route, on: boolean) {
  const res = await fetch(`/api/services/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}/public`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ public: on }),
  }).catch(() => null);
  const out = res ? await res.json().catch(() => ({})) : {};
  dkMenuNote(res?.ok ? `${r.name} ${on ? 'public' : 'private'}` : out.error || 'not changed');
}

export function dkService(r: Route): DkWin | undefined {
  const w = dkWin(`svc:${serviceKey(r)}`, r.name, r.public ? `${r.host}, public` : r.host, 'svc');
  if (!w) return;
  const url = serviceUrl(r);
  const pop = Object.assign(el('button', 'dk-out'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  pop.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
  w.head.querySelector('.dk-btns')!.prepend(pop);
  const frame: NavFrame = Object.assign(el('iframe', 'dk-frame'), { src: url, title: r.name, allow: 'clipboard-read; clipboard-write; fullscreen' });
  w.body.appendChild(frame);
  dkNav(w, frame);
  // lit on the mesh graph as an open tab of it would be
  const conn: Connection = { win: { closed: false }, host: r.host, name: r.name };
  activeConnections.set(serviceKey(r), conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
  w.onClose = () => { conn.win.closed = true; frame.contentWindow?.location.replace('about:blank'); };
  dkFocus(w);
  return w;
}

// --- the mesh's own apps: each view moved into a window, back to the stash on close

const DK_APPS: Record<string, { title: string; view: string; w: number; h: number }> = {
  chat: { title: 'chat', view: 'view-chat', w: 880, h: 560 },
  apps: { title: 'apps', view: 'view-apps', w: 820, h: 700 },
  status: { title: 'status', view: 'view-status', w: 920, h: 600 },
  about: { title: 'about', view: 'view-about', w: 700, h: 420 },
  games: { title: 'game servers', view: 'view-games', w: 460, h: 420 },
  code: { title: 'code', view: 'view-code', w: 1040, h: 660 },
  agents: { title: 'agents', view: 'view-agents', w: 860, h: 640 },
};

export function dkOpenApp(id: string): void {
  if (!dk.desk) return;
  if (id === 'git') { dkGit(); return; }
  const app = DK_APPS[id];
  const w = app && dkWin(`app:${id}`, app.title, '', `app dk-app-${id}`);
  if (!w) return;
  const view = document.getElementById(app.view)!;
  view.classList.add('active');
  w.body.appendChild(view);
  dkSize(w, app.w, app.h);
  if (id === 'status') pingHosts();
  const fit = new ResizeObserver(() => { if (id === 'status') appCall('status', false, (m) => m.statusDraw()); });
  fit.observe(w.body);
  w.onClose = () => {
    fit.disconnect();
    view.classList.remove('active');
    stash.appendChild(view);
  };
  if (id === 'chat') {
    w.task.appendChild(dkBadge());
    w.onFocus = () => { if (!w.body.contains(document.activeElement)) (joined() ? chatText : chatName).focus({ preventScroll: true }); };
  }
  dkFocus(w);
}

// which apps are up, each view's watcher told of a change
export function dkAppsChanged(): void {
  const was = new Set(deskApps);
  deskApps.clear();
  for (const id of [...Object.keys(DK_APPS), 'git']) {
    const w = dk.wins.get(`app:${id}`);
    if (w && !w.node.hidden && !w.leaving) deskApps.add(id);
  }
  const up = (id: string) => deskApps.has(id) && !was.has(id);
  if (up('status')) appCall('status', true, (m) => m.statusWatch(st.lastState));
  if (up('agents')) appCall('agents', true, (m) => { m.agentsState(st.lastState); m.agentsWatch(true); });
  if (deskApps.has('apps') !== was.has('apps')) appCall('store', deskApps.has('apps'), (m) => m.storeWatch(deskApps.has('apps')));
  if (deskApps.has('code') !== was.has('code')) appCall('code', deskApps.has('code'), (m) => m.codeWatch(deskApps.has('code')));
  // the conversation's news read once it's on screen
  if (up('chat')) setConv(convNow());
}

// a shell from the chat or phosphorus, on a host this desktop is logged into
// one asked for by phosphorus: logged in with the saved login, shared with it
export function dkOpenTerminal(host: string, shared = false): void {
  if (!dk.desk || !dk.creds.has(host)) return;
  const w = dkTerminal(host, '', shared);
  if (shared && agentViewOn()) { agentOwn(w); agentArm(); }
}

// phosphorus's presses, each the app it names
const DK_VIEWS: Record<string, string> = { status: 'status', about: 'about', chat: 'chat', git: 'git', games: 'games', home: 'games', code: 'code', projects: 'code', agents: 'agents', models: 'agents', apps: 'apps', store: 'apps' };
export function dkPressed(a: UiAction): void {
  if (a.kind === 'terminal') dkOpenTerminal(a.host!, a.share === true);
  else if (a.kind === 'host' && phosphorusHosts().includes(a.host!)) switchHost(a.host!);
  else if (a.kind === 'code' && a.host && a.path) { if (dk.desk) dkCode({ host: a.host, share: a.share as string | undefined, path: a.path }); }
  else if (a.kind === 'view') {
    if (a.view === 'chat') openConv('mesh');
    else if (DK_VIEWS[a.view!]) dkOpenApp(DK_VIEWS[a.view!]!);
    else if (a.view === 'files' && dk.desk) filesWin();
    else if (a.view === 'update' && updateModal.hidden) openUpdateModal();
  } else if (a.kind === 'notify') { noteAdd(a.title!, a.body!); notifyOs(String(a.title || ''), String(a.body || '')); }
  else if (a.kind === 'agent') agentStep(a);
}

// --- the optional apps: each one the mesh wants and this host serves, its page in a window

// the apps picked for the mesh that this host has a copy of, each served under /<id>/
export function dkWebApps(): { id: string; mount: string; want: AppWant }[] {
  const wants = st.lastState?.apps || {};
  const mine = st.hostsInfo[st.selfHost]?.apps || {};
  return Object.entries(wants).filter(([id, w]) => w && mine[id]?.version === w.version).map(([id, w]) => ({ id, mount: `/${id}/`, want: w }));
}

// the app's window, the page's url carrying query when given (a file for sulfur to open)
export function dkWebApp(id: string, query?: Record<string, string>): DkWin | undefined {
  const a = dkWebApps().find((x) => x.id === id);
  if (!a) return;
  const w = dkWin(`webapp:${id}`, id, `v${a.want.version}`, 'svc dk-webapp');
  if (!w) return;
  const pop = Object.assign(el('button', 'dk-out'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  pop.addEventListener('click', () => window.open(a.mount, '_blank', 'noopener'));
  w.head.querySelector('.dk-btns')!.prepend(pop);
  const src = query ? `${a.mount}?${new URLSearchParams(query)}` : a.mount;
  const frame: NavFrame = Object.assign(el('iframe', 'dk-frame'), { src, title: id, allow: 'clipboard-read; clipboard-write; fullscreen' });
  w.frame = frame;
  w.body.appendChild(frame);
  dkNav(w, frame);
  dkSize(w, 1100, 680);
  w.onFocus = () => frame.contentWindow?.focus();
  w.onClose = () => { frame.contentWindow?.location.replace('about:blank'); };
  dkFocus(w);
  return w;
}

// a file opened in sulfur: its window made on the file, or the one up told of it; false when
// this host doesn't serve sulfur
export function dkSulfurOpen(f: FileRef): boolean {
  if (!dkWebApps().some((a) => a.id === 'sulfur')) return false;
  const o = { host: f.host, share: String(f.share || 'home'), path: f.path };
  const w = dk.wins.get('webapp:sulfur');
  if (w?.frame) {
    w.frame.contentWindow?.postMessage({ t: 'sulfur-open', ...o }, location.origin);
    dkFocus(w);
    return true;
  }
  return !!dkWebApp('sulfur', o);
}

// --- git: forgejo itself, the master host in the title

const gitMaster = () => st.gitHostsList.find((h) => h.role === 'master' && h.reachable)?.host || st.gitRoute?.host || '';

function dkGit() {
  if (!st.gitRoute) return;
  const w = dkWin('app:git', 'git', gitMaster(), 'svc dk-git');
  if (!w) return;
  const pop = Object.assign(el('button', 'dk-out'), { type: 'button', title: 'open in a browser tab', ariaLabel: 'open in a browser tab' });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  pop.addEventListener('click', () => { if (w.git!.url) window.open(w.git!.url, '_blank', 'noopener'); });
  w.head.querySelector('.dk-btns')!.prepend(pop);
  w.git = { url: '', master: '', conn: null };
  dkSize(w, 1040, 640);
  dkGitFrame();
  w.onClose = () => { if (w.git!.conn) w.git!.conn.win.closed = true; };
  dkFocus(w);
}

// the frame kept while its url holds, the title following the master
function dkGitFrame() {
  const w = dk.wins.get('app:git');
  if (!w) return;
  const master = gitMaster();
  if (master !== w.git!.master) {
    w.git!.master = master;
    const title = w.head.querySelector('.dk-title')!;
    let sub = title.querySelector('.dk-sub');
    if (!sub) sub = title.appendChild(el('span', 'dk-sub'));
    sub.textContent = master ? ` ${master}` : '';
    w.task.title = master ? `git ${master}` : 'git';
  }
  const url = st.gitRoute ? serviceUrl(st.gitRoute) : '';
  if (url === w.git!.url) return;
  w.git!.url = url;
  if (w.git!.conn) w.git!.conn.win.closed = true;
  w.git!.conn = null;
  if (!url) {
    w.body.replaceChildren(el('p', 'dk-note', 'git down'));
    return;
  }
  const frame: NavFrame = Object.assign(el('iframe', 'dk-frame'), { src: url, title: 'git', allow: 'clipboard-read; clipboard-write; fullscreen' });
  w.body.replaceChildren(frame);
  dkNav(w, frame);
  // lit on the mesh graph as the service's window is
  w.git!.conn = { win: { closed: false }, host: st.gitRoute!.host, name: st.gitRoute!.name };
  activeConnections.set(serviceKey(st.gitRoute!), w.git!.conn);
  startPulseLoop();
  drawMesh();
  w.onFocus = () => frame.contentWindow?.focus();
}

// a press inside a service's frame never reaching the page, its window raised by the page's blur
addEventListener('blur', () => setTimeout(() => {
  const f = document.activeElement;
  const w = f?.classList.contains('dk-frame') && [...dk.wins.values()].find((o) => o.body.contains(f));
  if (w && !w.node.classList.contains('focused')) dkFocus(w);
}));

// shells ended with the page, not left for their grace
addEventListener('pagehide', (e) => { if (!(e as PageTransitionEvent).persisted) for (const w of [...dk.wins.values()]) if (w.kind === 'term') dkClose(w, true); });
