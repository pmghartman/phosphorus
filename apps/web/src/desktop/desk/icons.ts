// the desktop: icons, windows and a task bar

import type { Route } from '@phosphorus/wire';
import { appCall } from '../../apps/index.ts';
import {
  dkFms,
  filesJoin,
  filesParent,
  filesWin,
  fmMark,
  fmSame,
  fmTransfer,
  fmZones,
  homeLoc,
  may,
} from '../../features/home/home.ts';
import { dkMcpTray, mcpStat } from '../../features/mcp.ts';
import { dkBellTray } from '../../features/notes.ts';
import { DK_GLYPHS, dkGlyph, el, isMobile, mobileQuery, svgEl } from '../../lib/dom.ts';
import { iconKnown, iconLearn, iconOrder } from '../../lib/iconmem.ts';
import { dk, st } from '../../lib/state.ts';
import { dkSettings } from '../../settings/settings.ts';
import { dkControlTray } from '../control.ts';
import { dkView } from '../desk.ts';
import { dkDeskDir, dkDeskView, dkDeskWatch, dkFileIcon } from '../deskfiles.ts';
import { dkMeshQuick, dkUpdateQuick } from '../quick.ts';
import { dkSessionHold, dkSessionRestore, dkSessionTry } from '../session.ts';
import { dkSpotlightTray } from '../spotlight.ts';
import { dkBar, dkChips, dkClock, dkHomeBtn, dkPlaceItems } from '../taskbar.ts';
import { dkClose, dkFocus, dkPlace, dkSnap } from '../windows.ts';
import { dkTermApp, dkTermDrop } from './terminal.ts';
import { dkDeskMenu, dkService, dkWallPaint } from './wallpaper.ts';
import { dkOpenWaiting, dkWebApp, dkWebApps } from './webapps.ts';
import { dkOpenApp } from './windows.ts';

export function dkDesktop(): void {
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
  const mesh = st.acct?.boot ? null : dkMeshQuick();
  const update = st.acct?.boot ? null : dkUpdateQuick();
  bar.append(search, ...[mesh, update, agent].filter((x): x is HTMLElement => !!x), bell, ctl);
  const menubar = el('div', 'dk-bar dk-menubar');
  const app = el('span', 'dk-menubar-app');
  app.append(dkGlyph(DK_GLYPHS.mesh!, 'dk-menubar-app-ic'), el('span', 'dk-menubar-app-t', 'phosphorus'));
  menubar.append(app);
  desk.append(dkArt(), icons, wins, menubar, bar);
  dkView.replaceChildren(desk);
  dkBand(icons);
  dkDeskMenu(icons);
  dk.desk = {
    el: desk,
    icons,
    wins,
    tasks,
    hosts,
    bar,
    menubar,
    app,
    items: { search, hosts, mesh, update, agent, bell, clock: dk.clock!, profile: ctl },
  };
  dkPlaceItems();
  dk.chips = '';
  dkChips();
  new ResizeObserver(() => dkLayout()).observe(icons);
  // the menu bar's width, a dock beside it on the same edge kept clear of it
  new ResizeObserver(() => desk.style.setProperty('--dk-mb-w', `${menubar.offsetWidth}px`)).observe(menubar);
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
  // the mark painted in the theme's glyph colors (about.css)
  const mark = el('span', 'about-mark');
  mark.setAttribute('aria-hidden', 'true');
  art.appendChild(mark);
  return art;
}

// on each minute's turn, not up to 5s after it
(function dkClockTick() {
  dkClock();
  setTimeout(dkClockTick, 60000 - (Date.now() % 60000) + 20);
})();

export function dkLogout(): void {
  // the session kept as it was, never saved empty on the way out
  dkSessionHold(true);
  dk.ctl?.show(false);
  dk.mcp?.show(false);
  // the last user's key and calls never shown to the next
  dk.mcp = null;
  dk.mcpStop?.();
  Object.assign(mcpStat, {
    configured: false,
    seen: 0,
    at: 0,
    now: 0,
    got: 0,
    client: '',
    calls: [],
    recent: [],
    url: '',
  });
  for (const w of [...dk.wins.values()]) dkClose(w, true);
  dk.creds.clear();
  dk.desk = null;
  dkSessionHold(false);
}

// icons on a grid, any cell, kept per browser; a press selects, a drag moves
// the selection, a double click (a tap on touch) opens
export const DK_POS_KEY = 'phosphorus-dk-icons';
export const DK_GX = 92;
export const DK_GY = 86;
export const DK_PAD = 8;

// a service with no icon of its own: its initial in a square
export function dkMono(label: string): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: 'ic dk-mono', 'aria-hidden': 'true' });
  svg.appendChild(svgEl('rect', { x: 1.5, y: 1.5, width: 13, height: 13 }));
  const t = svgEl('text', { x: 8, y: 8.6, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  t.textContent = (String(label).match(/[a-z0-9]/i)?.[0] || '?').toUpperCase();
  svg.appendChild(t);
  return svg;
}

// the first of icons that loads, the glyph kept when none does; again: all asked once more
// after that long, doubling, while the tile is on the desk, a host restarting answering later
export function dkTryIcons(tile: HTMLElement, icons: string[], again = 0, retry = false) {
  const srcs = icons.filter(Boolean);
  if (!srcs.length) return;
  const known = retry ? undefined : iconKnown(srcs);
  const order = retry ? srcs : iconOrder(srcs);
  // none loaded last time: the glyph at once, no hole while they're asked
  if (!retry && known !== '') {
    tile.classList.add('dk-wait');
    // the glyph shown after a while, a slow host never leaving a hole
    setTimeout(() => tile.classList.remove('dk-wait'), 600);
  }
  const glyph = [...tile.childNodes];
  const show = (img: HTMLImageElement) => {
    tile.replaceChildren(img, ...tile.querySelectorAll('.dk-public'));
    tile.classList.add('dk-tile-img');
    tile.classList.remove('dk-wait');
  };
  const next = (i: number) => {
    if (i === order.length) {
      tile.classList.remove('dk-wait');
      iconLearn(srcs, '');
      if (again)
        setTimeout(() => {
          if (tile.isConnected) dkTryIcons(tile, srcs, Math.min(again * 2, 600000), true);
        }, again);
      return;
    }
    // the one that loaded last time up at once, the glyph back if it fails now
    const early = i === 0 && !!known;
    const img = Object.assign(el('img', 'dk-favicon'), {
      alt: '',
      decoding: early ? ('sync' as const) : ('async' as const),
      draggable: false,
    });
    img.addEventListener(
      'load',
      () => {
        if (!early) show(img);
        iconLearn(srcs, order[i]!);
      },
      { once: true },
    );
    img.addEventListener(
      'error',
      () => {
        if (early) {
          tile.replaceChildren(...glyph, ...tile.querySelectorAll('.dk-public'));
          tile.classList.remove('dk-tile-img');
        }
        next(i + 1);
      },
      { once: true },
    );
    img.src = order[i]!;
    if (early) show(img);
  };
  next(0);
}

export function dkIcon(
  kind: string,
  label: string,
  sub: string,
  open: () => void,
  icon: string | string[] = '',
  again = 0,
): HTMLButtonElement {
  const b = Object.assign(el('button', `dk-icon dk-${kind}`), {
    type: 'button',
    title: sub ? `${label} on ${sub}` : label,
  });
  const tile = el('span', 'dk-tile');
  tile.appendChild(kind === 'service' ? dkMono(label) : dkGlyph(DK_GLYPHS[kind]!));
  // a site's own icon once it loads
  dkTryIcons(tile, ([] as string[]).concat(icon), again);
  b.append(tile, el('span', 'dk-label', label));
  if (sub) b.appendChild(el('span', 'dk-sub', sub));
  b.dataset.id = `${kind}\n${label}\n${sub}`;
  b.addEventListener('dblclick', open);
  // a phone's icons a grid that scrolls, a tap opening
  b.addEventListener('click', () => {
    if (isMobile()) open();
  });
  b.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      open();
    }
  });
  b.addEventListener('pointerdown', (e) => dkGrab(e, b, open));
  return b;
}

// a public one badged with a globe, open to all behind its own login only
export function dkServiceIcon(r: Route): HTMLButtonElement {
  const b = dkIcon(
    'service',
    r.name,
    r.host,
    () => dkService(r),
    `/api/favicon/${encodeURIComponent(r.host)}/${encodeURIComponent(r.name)}`,
    30000,
  );
  return r.public ? dkGlobe(b, 'public: no phosphorus login') : b;
}

// the host serving an installed service: the one its failover made active, the want's until one is
function dkLiveHost(id: string): string {
  const v = st.lastState?.stacks?.[id];
  if (!v) return '';
  return [v.active, ...v.standbys].find((h) => st.hostsInfo[h]?.stacks?.[id]?.role === 'active') ?? v.active;
}

// the route an installed service answers at now: its serving host's, else whichever host has one
const dkStackRoute = (id: string): Route | undefined =>
  dk.services.find((r) => r.name === id && r.host === dkLiveHost(id)) ?? dk.services.find((r) => r.name === id);

// an installed service once, under the host serving it: an install or a takeover moving its
// route between hosts never redraws it, its icon its catalogue's before the page's own
function dkStackIcon(id: string): HTMLButtonElement {
  const v = st.lastState!.stacks![id]!;
  const live = dkLiveHost(id);
  const r = dkStackRoute(id);
  const b = dkIcon(
    'service',
    id,
    live,
    () => {
      const now = dkStackRoute(id);
      if (now) dkService(now);
    },
    [v.summary.icon, `/api/favicon/${encodeURIComponent(r?.host ?? live)}/${encodeURIComponent(id)}`],
    30000,
  );
  return v.public || r?.public ? dkGlobe(b, 'public: no phosphorus login') : b;
}

// the logged in hosts still on the mesh, a dead one's terminal never offered
export function dkLiveHosts(): string[] {
  const up = new Set([...st.terminalHosts, st.selfHost]);
  return [...dk.creds.keys()].filter((h) => up.has(h));
}

// a globe in the tile's corner: reachable without the phosphorus login
export function dkGlobe(b: HTMLButtonElement, why: string): HTMLButtonElement {
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
  const webapps = dkWebApps();
  // installed services by name, the rest by host and name
  const stacks = st.lastState?.stacks ?? {};
  const stackIds = [...new Set(dk.services.filter((r) => stacks[r.name]).map((r) => r.name))];
  const others = dk.services.filter((r) => !stacks[r.name]);
  const stackKey = (id: string) =>
    JSON.stringify(['stack', id, dkLiveHost(id), !!(stacks[id]!.public || dkStackRoute(id)?.public)]);
  const sig = JSON.stringify([
    hosts,
    !!st.acct?.admin,
    others.map((r) => [r.host, r.name, !!r.public]),
    stackIds.map(stackKey),
    webapps.map((a) => a.id),
    dk.deskFiles.map((e) => [e.name, e.dir, e.mtime]),
  ]);
  if (sig === dk.sig) return;
  dk.sig = sig;
  // a host, login or service newly here: a saved window waiting on it opened
  dkSessionTry();
  dkOpenWaiting();
  const files = new Map(dk.deskFiles.map((e) => [`doc\n${filesJoin(dkDeskDir(), e.name)}`, e]));
  // one key per icon and what it shows, an unchanged one kept as it is
  const want: [string, () => HTMLButtonElement][] = [
    ['terminal', () => dkIcon('terminal', 'terminal', '', dkTermApp)],
    ['files', () => dkIcon('files', 'files', '', () => filesWin())],
    ['apps', () => dkIcon('apps', 'service wizard', '', () => dkOpenApp('apps'))],
    ['settings', () => dkIcon('settings', 'settings', '', () => dkSettings())],
    ...webapps.map((a): [string, () => HTMLButtonElement] => [
      `webapp\n${a.id}`,
      () => dkIcon('app', a.id, '', () => dkWebApp(a.id), `${a.mount}icon.svg?v=${a.want.version}`),
    ]),
    ...others.map((r): [string, () => HTMLButtonElement] => [
      JSON.stringify([r.host, r.name, !!r.public]),
      () => dkServiceIcon(r),
    ]),
    ...stackIds.map((id): [string, () => HTMLButtonElement] => [stackKey(id), () => dkStackIcon(id)]),
    ...[...files.values()].map((e): [string, () => HTMLButtonElement] => [
      JSON.stringify([dkDeskDir(), e.name, e.dir, e.mtime]),
      () => dkFileIcon(e),
    ]),
  ];
  const had = new Map(dkIconEls().map((b) => [b.dataset.key, b]));
  dk.desk.icons.replaceChildren(
    ...want.map(([key, make]) => {
      const old = had.get(key);
      if (old) return old;
      const b = make();
      b.dataset.key = key;
      b.classList.add('dk-new');
      return b;
    }),
  );
  dkLayout();
}

export function dkSaved(): Record<string, [number, number]> {
  try {
    const v = JSON.parse(localStorage.getItem(DK_POS_KEY)!);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
export const dkIconEls = () => (dk.desk ? [...dk.desk.icons.querySelectorAll<HTMLButtonElement>('.dk-icon')] : []);
export const dkGrid = () => {
  const { icons } = dk.desk!;
  return {
    cols: Math.max(1, Math.floor((icons.clientWidth - DK_PAD) / DK_GX)),
    rows: Math.max(1, Math.floor((icons.clientHeight - DK_PAD) / DK_GY)),
  };
};
export const dkCell = (c: number | string, r: number | string) => `${c},${r}`;

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
      if (id.startsWith('doc\n') && !here.has(id)) {
        delete saved[id];
        placed = true;
      }
    }
  }
  // an icon not in yet keeps its cell, none of the others spilling into it
  const held = new Set(
    Object.entries(saved)
      .filter(([id, p]) => !here.has(id) && Array.isArray(p))
      .map(([, p]) => dkCell(...p)),
  );
  const taken = new Set<string>();
  const rest: HTMLButtonElement[] = [];
  for (const b of dkIconEls()) {
    const p = saved[b.dataset.id!];
    if (Array.isArray(p) && p[0] < cols && p[1] < rows && !taken.has(dkCell(...p))) {
      taken.add(dkCell(...p));
      dkPut(b, p[0], p[1]);
    } else rest.push(b);
  }
  const busy = (i: number, skipHeld: boolean) =>
    taken.has(dkCell(Math.floor(i / rows), i % rows)) || (skipHeld && held.has(dkCell(Math.floor(i / rows), i % rows)));
  let i = 0;
  for (const b of rest) {
    let j = i;
    while (j < cols * rows && busy(j, true)) j += 1;
    // a full grid: held cells given up before overlapping
    if (j >= cols * rows) {
      j = i;
      while (j < cols * rows && busy(j, false)) j += 1;
    } else i = j;
    const c = Math.floor(j / rows);
    const r = j % rows;
    taken.add(dkCell(c, r));
    dkPut(b, c, r);
    // its cell kept, off the grid only while the desk is too small
    const p = saved[b.dataset.id!];
    if (!(Array.isArray(p) && (p[0] >= cols || p[1] >= rows))) {
      saved[b.dataset.id!] = [c, r];
      placed = true;
    }
  }
  if (placed)
    try {
      localStorage.setItem(DK_POS_KEY, JSON.stringify(saved));
    } catch {}
  for (const id of [...dk.sel]) if (!dkIconEls().some((b) => b.dataset.id === id)) dk.sel.delete(id);
  dkPaintSel();
}

export function dkPut(b: HTMLElement, c: number, r: number) {
  b.dataset.c = String(c);
  b.dataset.r = String(r);
  b.style.transform = `translate(${DK_PAD + c * DK_GX}px, ${DK_PAD + r * DK_GY}px)`;
  if (b.classList.contains('dk-new'))
    requestAnimationFrame(() => requestAnimationFrame(() => b.classList.remove('dk-new')));
}

export function dkSave() {
  const saved = dkSaved();
  for (const b of dkIconEls()) saved[b.dataset.id!] = [Number(b.dataset.c), Number(b.dataset.r)];
  try {
    localStorage.setItem(DK_POS_KEY, JSON.stringify(saved));
  } catch {}
}

export function dkPaintSel() {
  for (const b of dkIconEls()) b.classList.toggle('sel', dk.sel.has(b.dataset.id!));
}

export function dkGrab(e: PointerEvent, b: HTMLButtonElement, open: () => void) {
  if (e.button !== 0 || isMobile()) return;
  e.preventDefault();
  dkFocus(null);
  b.focus({ preventScroll: true });
  const id = b.dataset.id!;
  const add = e.ctrlKey || e.metaKey;
  const was = dk.sel.has(id);
  if (add) {
    if (!was) dk.sel.add(id);
  } else if (!was) dk.sel = new Set([id]);
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
    if (zone && zone !== z) zone.classList.remove('drop');
    zone = got && t && may(t.loc, 'w') ? z : null;
    if (zone) fmMark(zone);
  };
  // a copy riding the pointer above every window
  let ghost: HTMLElement | null = null;
  const paint = () => {
    frame = 0;
    for (const x of moving)
      x.style.transform = `translate(${DK_PAD + Number(x.dataset.c) * DK_GX + dx}px, ${DK_PAD + Number(x.dataset.r) * DK_GY + dy}px)`;
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
    if (!dragged) {
      dragged = true;
      dk.desk!.el.classList.add('dk-moving');
      for (const x of moving) x.classList.add('dk-lift');
    }
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const onUp = (ev: PointerEvent) => {
    b.removeEventListener('pointermove', onMove);
    b.removeEventListener('pointerup', onUp);
    b.removeEventListener('pointercancel', onUp);
    cancelAnimationFrame(frame);
    if (!dragged) {
      if (add && was) {
        dk.sel.delete(id);
        dkPaintSel();
      } else if (!add && ev.type === 'pointerup') {
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
      const { v, where } = fmZones.get(zone)!;
      const t = where()!;
      zone.classList.remove('drop');
      for (const x of moving) dkPut(x, Number(x.dataset.c), Number(x.dataset.r));
      const home = homeLoc();
      const items = files
        .map((x) => dk.deskFiles.find((f) => filesJoin(dkDeskDir(), f.name) === x.dataset.file))
        .filter((f): f is NonNullable<typeof f> => !!f)
        .map((f) => ({ rel: filesJoin(dkDeskDir(), f.name), dir: !!f.dir, name: f.name }))
        .filter((it) => !(fmSame(home, t.loc) && filesParent(it.rel) === t.dir));
      if (items.length) fmTransfer(v, home, items, t.loc, t.dir, fmSame(home, t.loc) && !ev.ctrlKey && !ev.altKey);
      return;
    }
    dkDrop(moving, Math.round(dx / DK_GX), Math.round(dy / DK_GY));
  };
  b.addEventListener('pointermove', onMove);
  b.addEventListener('pointerup', onUp);
  b.addEventListener('pointercancel', onUp);
}

// each moved icon its own cell, else the nearest free one
export function dkDrop(moving: HTMLElement[], dc: number, dr: number) {
  const { cols, rows } = dkGrid();
  const taken = new Set(
    dkIconEls()
      .filter((x) => !moving.includes(x))
      .map((x) => dkCell(x.dataset.c!, x.dataset.r!)),
  );
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
export function dkBand(icons: HTMLElement) {
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
  if (!dk.desk || e.defaultPrevented || (e.ctrlKey && e.altKey)) return;
  const t = e.target as Node;
  if (t !== document.body && !dk.desk.icons.contains(t)) return;
  if (e.key === 'Escape') {
    dk.sel.clear();
    dkPaintSel();
  } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
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
        if (d < best) {
          best = d;
          pick = b;
        }
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
}

// a host gone from the mesh: its terminals closed, its chip and places gone until it answers again
export function dkHostsGone(): void {
  const up = new Set([...st.terminalHosts, st.selfHost]);
  dkTermDrop((h) => !up.has(h));
  dkChips();
  for (const fm of dkFms) appCall('files', false, (m) => m.fmHosts(fm));
}
