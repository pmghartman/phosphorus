// host desktop: a computer on the mesh zoomed into, in a tab of its own named for it or a
// window here, drawn in its OS's style from what its own settings and files say

import { dkUnlock } from '../../features/account.ts';
import { acctCall } from '../../lib/api.ts';
import { DK_UI, dkGlyph, el } from '../../lib/dom.ts';
import { dk } from '../../lib/state.ts';
import { dkSettings } from '../../settings/settings.ts';
import { type DkWin, dkFocus, dkMax, dkWin } from '../windows.ts';
import { binWin, folderWin, openFile, setWin, webWin } from './hostdesk-wins.ts';
import { streamWin } from './hoststream.ts';
import { dkTerminal } from './terminal.ts';
import { dkMenu, dkSay, type MenuItem } from './wallpaper.ts';

export type Kind = 'file' | 'folder' | 'cli' | 'web' | 'gui' | 'bin';
export interface Item {
  name: string;
  kind: Kind;
  path?: string;
  icon?: string;
  iv?: string;
  run?: string;
  url?: string;
  group?: string;
  id?: string;
}
export interface Desk {
  os: 'windows' | 'linux';
  shell: 'win11' | 'win10' | 'gnome' | 'kde' | 'xfce' | 'plain';
  user: string;
  home: string;
  wallpaper: { path: string; fit: string; color: string; iv: string };
  dark: boolean;
  accent: string;
  align: 'center' | 'left';
  icons: Item[];
  pins: Item[];
  binFull: boolean;
  can: { wallpaper: boolean; dark: boolean; accent: boolean; pins: boolean };
  accents: string[];
  dock?: string;
  look?: Look;
}
export interface Look {
  iconSize: number;
  clock: { h24: boolean; seconds: boolean; weekday: boolean };
  transparent: boolean;
  search: '' | 'icon' | 'box';
  taskView: boolean;
  widgets: boolean;
  small: boolean;
  edge: 'bottom' | 'top' | 'left' | 'right';
}

// HD one open host desktop: its window, root, what it last drew
export interface HD {
  host: string;
  // its window, none in a tab of its own
  w?: DkWin;
  root: HTMLElement;
  desk?: Desk;
  apps: Item[];
  start?: HTMLElement;
}

export const api = (h: string, op: string, q: Record<string, string> = {}) =>
  `/api/hostdesk/${encodeURIComponent(h)}/${op}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`;

export const iconSrc = (hd: HD, it: Item) => (it.icon ? api(hd.host, 'icon', { k: it.icon, v: it.iv ?? '' }) : '');

const motion = matchMedia('(prefers-reduced-motion: reduce)');

// the last desk drawn for a host, kept in this browser for a first paint before any answer
const lsKey = (h: string) => `phosphorus-desk:${h}`;
function lsGet(h: string): { desk?: Desk; apps?: Item[] } | undefined {
  try {
    return JSON.parse(localStorage.getItem(lsKey(h)) ?? 'null') ?? undefined;
  } catch {}
}
function lsPut(hd: HD) {
  try {
    localStorage.setItem(lsKey(hd.host), JSON.stringify({ desk: hd.desk, apps: hd.apps }));
  } catch {}
}

// the way in: a computer zoomed into, its own tab grown from where it was asked;
// shift held, or a tab refused, keeps it a window on this desk
export function dkZoom(host: string, from?: Element | null, e?: { shiftKey?: boolean }) {
  if (e?.shiftKey) return void dkHostDesk(host, from);
  let at = '';
  const r = from?.getBoundingClientRect();
  if (r?.width && innerWidth && innerHeight) {
    const f = (n: number) => Math.max(0, Math.min(1, n)).toFixed(3);
    at = `@${f(r.left / innerWidth)},${f(r.top / innerHeight)},${f(r.width / innerWidth)},${f(r.height / innerHeight)}`;
  }
  const w = window.open(`/#desk=${host}${at}`, `phosphorus-desk-${host}`);
  if (!w) dkHostDesk(host, from);
}

// a tab of its own: #desk=<host>, with @x,y,w,h the rect it was zoomed from as screen fractions
const tabRe = /^#desk=([a-z0-9][a-z0-9-]*)(?:@([\d.]+),([\d.]+),([\d.]+),([\d.]+))?$/;
const cachedDesk = (h: string) =>
  acctCall<{ desk?: Desk; apps?: Item[]; cached?: boolean }>(api(h, 'desktop', { cached: '1' }));
const liveDesk = (h: string) => acctCall<{ desk: Desk }>(api(h, 'desktop'));
let tab: HD | undefined;
let early: { cached: ReturnType<typeof cachedDesk>; live: ReturnType<typeof liveDesk> } | undefined;

// at boot, before the login answers: the tab named for the host, the last desk drawn at
// once, both asks sent; true when this page is a host's tab
export function dkDeskTabBoot(): boolean {
  const m = tabRe.exec(location.hash);
  if (!m) return false;
  const host = m[1]!;
  document.title = host;
  document.documentElement.classList.add('hd-tabmode');
  history.replaceState(null, '', `#desk=${host}`);
  const root = el('div', 'hd hd-tabroot');
  document.body.append(root);
  tab = { host, root, apps: [] };
  early = { cached: cachedDesk(host), live: liveDesk(host) };
  const ls = lsGet(host);
  if (ls?.desk) {
    tab.apps = ls.apps ?? [];
    draw(tab, ls.desk);
  }
  grow(root, m.slice(2, 6).map(Number));
  return true;
}

// grown from the rect it was zoomed from to the whole tab
function grow(node: HTMLElement, at: number[]) {
  if (motion.matches || !node.animate) return;
  const [x = 0, y = 0, w = 0, h = 0] = at;
  const from = w && h ? `translate(${x * 100}vw, ${y * 100}vh) scale(${w}, ${h})` : 'translate(10vw, 10vh) scale(0.8)';
  node.animate(
    [
      { transformOrigin: '0 0', transform: from, opacity: 0.4, borderRadius: '12px' },
      { transformOrigin: '0 0', transform: 'none', opacity: 1, borderRadius: '0' },
    ],
    { duration: 360, easing: 'cubic-bezier(.2,.7,.2,1)' },
  );
}

// the tab's desk under phosphorus's own windows once the desktop is up
function adopt(hd: HD) {
  const desk = dk.desk;
  if (!desk) return;
  desk.el.classList.add('hd-tabdesk');
  desk.el.insertBefore(hd.root, desk.wins);
  if (hd.desk) draw(hd, hd.desk);
  void load(hd);
}

export function dkHostDesk(host: string, from?: Element | null): DkWin | undefined {
  if (!dk.desk) return;
  const key = `hostdesk:${host}`;
  const had = dk.wins.get(key);
  if (had) {
    dkFocus(had);
    return had;
  }
  const w = dkWin(key, host, 'desktop', 'hostdesk');
  if (!w) return;
  const full = Object.assign(el('button', 'dk-out'), {
    type: 'button',
    title: 'full screen',
    ariaLabel: 'full screen',
  });
  full.appendChild(dkGlyph(DK_UI.max!));
  full.addEventListener('click', () => void w.body.requestFullscreen?.().catch(() => {}));
  w.head.querySelector('.dk-btns')!.prepend(full);
  const root = el('div', 'hd');
  w.body.appendChild(root);
  const hd: HD = { host, w, root, apps: [] };
  dkMax(w);
  zoom(w, from);
  void load(hd);
  return w;
}

// grown from the element pressed into the window it fills
function zoom(w: DkWin, from?: Element | null) {
  if (!from || motion.matches || !w.node.animate) return;
  const a = from.getBoundingClientRect();
  const b = w.node.getBoundingClientRect();
  if (!a.width || !b.width) return;
  const sx = a.width / b.width;
  const sy = a.height / b.height;
  w.node.animate(
    [
      {
        transformOrigin: '0 0',
        transform: `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${sx}, ${sy})`,
        opacity: 0.3,
      },
      { transformOrigin: '0 0', transform: 'none', opacity: 1 },
    ],
    { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' },
  );
}

async function load(hd: HD) {
  const pre = hd === tab ? early : undefined;
  early = undefined;
  const say = (msg: string, acts: [string, () => void][] = []) => {
    const box = el('div', 'hd-say');
    box.append(el('p', '', msg));
    for (const [label, f] of acts) {
      const b = Object.assign(el('button', 'btn', label), { type: 'button' });
      b.addEventListener('click', f);
      box.append(b);
    }
    hd.root.replaceChildren(box);
  };
  if (!hd.desk) {
    const ls = lsGet(hd.host);
    if (ls?.desk) {
      hd.apps = ls.apps ?? [];
      draw(hd, ls.desk);
    } else say(`opening ${hd.host}`);
  }
  // both asked at once: the cache paints, the live desk replaces it
  let liveP = pre?.live ?? liveDesk(hd.host);
  let cached = await (pre?.cached ?? cachedDesk(hd.host));
  // asked before the login answered: asked again now it has
  if (pre && cached.status === 401) {
    liveP = liveDesk(hd.host);
    cached = await cachedDesk(hd.host);
  }
  if (!cached.ok) return refused(hd, cached.status, cached.error ?? '', say);
  if (cached.desk) {
    if (cached.apps?.length) hd.apps = cached.apps;
    draw(hd, cached.desk);
  }
  let r = await liveP;
  if (pre && r.status === 401) r = await liveDesk(hd.host);
  if (!r.ok || !r.desk) {
    if (hd.desk) return dkSay(`${hd.host}: ${r.error || 'no answer'}`);
    return refused(hd, r.status, r.error ?? '', say);
  }
  draw(hd, r.desk);
  lsPut(hd);
  const a = await acctCall<{ apps: Item[] }>(api(hd.host, 'apps'));
  if (a.ok && a.apps) {
    hd.apps = a.apps;
    lsPut(hd);
  }
}

function refused(hd: HD, status: number, error: string, say: (m: string, a?: [string, () => void][]) => void) {
  const again: [string, () => void] = ['try again', () => void load(hd)];
  if (status === 403 && /save a login/.test(error))
    return say(error, [['host logins', () => dkSettings('profile', 'host logins')], again]);
  say(error || `${hd.host} didn't answer`, [again]);
}

// the whole desktop drawn again from what the host says
export function draw(hd: HD, d: Desk) {
  hd.desk = d;
  const r = hd.root;
  const lk = d.look;
  r.className = [
    'hd',
    hd === tab ? 'hd-tabroot' : '',
    `hd-${d.shell}`,
    d.dark ? 'hd-dark' : 'hd-light',
    d.dock ? `hd-dock-${d.dock}` : '',
    lk && !lk.transparent ? 'hd-solid' : '',
    lk?.small ? 'hd-small' : '',
    lk && lk.edge !== 'bottom' ? `hd-edge-${lk.edge}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  r.style.setProperty('--hd-accent', d.accent || 'var(--accent)');
  // the host's own icon size, kept to what fits here
  r.style.setProperty('--hd-icon', `${Math.round(Math.max(24, Math.min(96, lk?.iconSize ?? 48)))}px`);
  const wall = el('div', 'hd-wall');
  if (d.wallpaper.color) wall.style.backgroundColor = d.wallpaper.color;
  if (d.wallpaper.path) {
    wall.style.backgroundImage = `url("${api(hd.host, 'wallpaper', { v: d.wallpaper.iv || d.wallpaper.path })}")`;
    wall.dataset.fit = d.wallpaper.fit;
  }
  wall.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    dkMenu(e.clientX, e.clientY, [
      ['personalize', () => setWin(hd), true],
      ['recycle bin', () => binWin(hd), true],
      ['refresh', () => void load(hd), true],
    ]);
  });
  const icons = el('div', 'hd-icons');
  for (const it of d.icons) icons.append(iconBtn(hd, it, 'hd-icon'));
  wall.addEventListener('pointerdown', (e) => {
    if (e.target === wall || e.target === icons)
      for (const x of icons.querySelectorAll('.on')) x.classList.remove('on');
  });
  wall.append(icons);
  const layer = el('div', 'hd-layer');
  r.replaceChildren(wall, chrome(hd, d), layer);
  // phosphorus's own windows as running tasks on the host's bar, in a tab of its own
  if (hd === tab && dk.desk) r.querySelector('.hd-pins')?.after(dk.desk.tasks);
}

// one launcher: its icon and name, opened by a double click on the desk, one press elsewhere
export function iconBtn(hd: HD, it: Item, cls: string, single = false): HTMLButtonElement {
  const b = Object.assign(el('button', `${cls} hd-k-${it.kind}`), { type: 'button', title: tip(it) });
  b.append(pic(hd, it), el('span', 'hd-name', it.name));
  if (it.kind === 'gui' && !streams(hd)) b.classList.add('off');
  const go = () => openItem(hd, it, b);
  if (single) b.addEventListener('click', go);
  else {
    b.addEventListener('click', () => {
      for (const x of b.parentElement?.querySelectorAll('.on') ?? []) x.classList.remove('on');
      b.classList.add('on');
    });
    b.addEventListener('dblclick', go);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
  }
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dkMenu(e.clientX, e.clientY, itemMenu(hd, it, b), undefined, it.name);
  });
  return b;
}

// the host's own icon, its first letter while there's none
export function pic(hd: HD, it: Item): HTMLElement {
  const glyph = () => el('span', 'hd-noicon', it.name.slice(0, 1).toLowerCase());
  const src = iconSrc(hd, it);
  if (!src) return glyph();
  const img = Object.assign(el('img'), { alt: '', draggable: false, loading: 'lazy', decoding: 'async', src });
  // a miss asked once more, a slow host's icon often there a moment later
  let tries = 0;
  img.addEventListener('error', () => {
    if (tries++) return img.replaceWith(glyph());
    setTimeout(() => {
      if (img.isConnected) img.src = `${src}&again=1`;
    }, 1500);
  });
  return img;
}

// window apps stream from Linux hosts; Windows' wait
const streams = (hd: HD) => hd.desk?.os === 'linux';

const tip = (it: Item) =>
  it.kind === 'gui' && !it.path ? `${it.name}: a window app` : it.path ? `${it.name}\n${it.path}` : it.name;

const imageRe = /\.(png|jpe?g|webp|bmp|svg)$/i;

function itemMenu(hd: HD, it: Item, b: HTMLElement): MenuItem[] {
  const d = hd.desk!;
  const items: MenuItem[] = [['open', () => openItem(hd, it, b), it.kind !== 'gui' || streams(hd)]];
  if (it.path && imageRe.test(it.path) && d.can.wallpaper)
    items.push(['set as desktop background', () => void setWin(hd, { wallpaper: it.path }), true]);
  if (it.id && d.can.pins) {
    const pinned = d.pins.some((p) => p.id === it.id);
    items.push([pinned ? 'unpin' : 'pin', () => void setWin(hd, { pin: it.id!, on: !pinned }), true]);
  }
  if (it.path && it.kind !== 'bin') {
    items.push(null, ['delete', () => void binWin(hd, { delete: it.path! }), true, 'danger']);
  }
  return items;
}

// what a launcher does: the viewer, a folder, a terminal tab, a window; window apps wait
export function openItem(hd: HD, it: Item, from?: Element) {
  switch (it.kind) {
    case 'bin':
      return binWin(hd);
    case 'folder':
      return folderWin(hd, it.path!);
    case 'file':
      return void openFile(hd, it.path!);
    case 'web':
      return it.url ? webWin(it.url, it.name) : undefined;
    case 'cli': {
      if (!dk.creds.has(hd.host)) {
        if (from) dkUnlock(hd.host, from as HTMLElement, () => openItem(hd, it));
        return;
      }
      dkTerminal(hd.host, it.run ?? '');
      return;
    }
    case 'gui':
      if (streams(hd) && it.path) return streamWin(hd, it);
      return dkSay(`${it.name} is a window app; streaming runs from Linux hosts for now`);
  }
}

// --- the shell around the desk: a taskbar, a top bar and dock, a panel ---------------

function chrome(hd: HD, d: Desk): HTMLElement {
  const bar = el('div', 'hd-bar');
  const startBtn = Object.assign(el('button', 'hd-start'), { type: 'button', title: 'start', ariaLabel: 'start' });
  startBtn.append(el('span', 'hd-start-mark'));
  if (d.shell === 'gnome') startBtn.append(el('span', 'hd-start-t', 'activities'));
  if (d.shell === 'xfce') startBtn.append(el('span', 'hd-start-t', 'applications'));
  if (d.shell === 'plain') startBtn.append(el('span', 'hd-start-t', 'apps'));
  startBtn.addEventListener('click', () => toggleStart(hd, startBtn));
  const pins = el('div', 'hd-pins');
  for (const p of d.pins) pins.append(iconBtn(hd, p, 'hd-pin', true));
  const tray = el('div', 'hd-tray');
  const clock = el('span', 'hd-clock');
  // the clock as the host shows it: 12 or 24 hours, seconds, the weekday
  const ck = d.look?.clock;
  const fmt: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  if (ck) fmt.hour12 = !ck.h24;
  if (ck?.seconds) fmt.second = '2-digit';
  if (ck ? ck.weekday : d.shell === 'gnome') fmt.weekday = 'short';
  const tick = () => {
    clock.textContent = new Date().toLocaleString([], fmt).toLowerCase();
  };
  tick();
  const t = setInterval(() => (clock.isConnected ? tick() : clearInterval(t)), ck?.seconds ? 1000 : 15000);
  tray.append(el('span', 'hd-user', d.user), clock);
  if (d.shell === 'gnome') {
    bar.append(startBtn, el('span', 'hd-gap'), clock, el('span', 'hd-gap'), el('span', 'hd-user', d.user));
    const wrap = el('div', 'hd-gchrome');
    const dock = el('div', 'hd-dock');
    dock.append(pins);
    const all = Object.assign(el('button', 'hd-pin hd-grid'), { type: 'button', title: 'show apps' });
    all.append(el('span', 'hd-grid-dots'));
    all.addEventListener('click', () => toggleStart(hd, all));
    dock.append(all);
    wrap.append(bar, dock);
    return wrap;
  }
  if (d.shell === 'xfce') {
    bar.append(startBtn, pins, el('span', 'hd-gap'), tray);
    return bar;
  }
  // the search, task view and widgets buttons the host shows
  const lk = d.look;
  const extra: HTMLElement[] = [];
  if (lk?.search) {
    const b = Object.assign(el('button', lk.search === 'box' ? 'hd-sbox' : 'hd-pin hd-sic'), {
      type: 'button',
      title: 'search',
    });
    b.append(el('span', 'hd-sbox-ic'));
    if (lk.search === 'box') b.append(el('span', 'hd-sbox-t', 'search'));
    b.addEventListener('click', () => toggleStart(hd, b));
    extra.push(b);
  }
  if (lk?.taskView) extra.push(Object.assign(el('span', 'hd-pin hd-tview'), { title: 'task view' }));
  if (lk?.widgets) bar.append(Object.assign(el('span', 'hd-widgets'), { title: 'widgets' }));
  bar.append(startBtn, ...extra, pins, tray);
  bar.dataset.align = d.shell === 'win11' ? d.align : 'left';
  return bar;
}

function toggleStart(hd: HD, btn: HTMLElement) {
  if (hd.start?.isConnected) {
    hd.start.remove();
    hd.root.classList.remove('hd-open');
    hd.start = undefined;
    return;
  }
  const d = hd.desk!;
  const m = el('div', 'hd-menu');
  const shut = () => {
    m.remove();
    hd.root.classList.remove('hd-open');
  };
  const search = Object.assign(el('input', 'hd-search'), {
    placeholder: d.os === 'windows' ? 'search for apps' : 'type to search',
    spellcheck: false,
  });
  const list = el('div', 'hd-apps');
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const apps = hd.apps.filter((a) => !q || a.name.toLowerCase().includes(q));
    const rows: HTMLElement[] = [];
    let head = '';
    const grouped = d.shell === 'kde' || d.shell === 'xfce';
    const sorted = grouped
      ? [...apps].sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.name.localeCompare(b.name))
      : apps;
    for (const a of sorted) {
      const h = grouped
        ? a.group || 'other'
        : d.os === 'windows'
          ? /^[a-z]/i.test(a.name)
            ? a.name[0]!.toLowerCase()
            : '#'
          : '';
      if (h && h !== head && !q) {
        head = h;
        rows.push(el('div', 'hd-apps-head', h));
      }
      const b = iconBtn(hd, a, 'hd-app', true);
      b.addEventListener('click', () => {
        if (a.kind !== 'gui' || streams(hd)) shut();
      });
      rows.push(b);
    }
    if (!rows.length) rows.push(el('p', 'hd-empty', hd.apps.length ? 'nothing matches' : 'reading the apps'));
    list.replaceChildren(...rows);
  };
  search.addEventListener('input', fill);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') shut();
    if (e.key === 'Enter') (list.querySelector('.hd-app:not(.off)') as HTMLButtonElement | null)?.click();
  });
  const foot = el('div', 'hd-menu-foot');
  const who = el('span', 'hd-user', d.user);
  const gear = Object.assign(el('button', 'hd-menu-btn', 'personalize'), { type: 'button' });
  gear.addEventListener('click', () => {
    shut();
    setWin(hd);
  });
  const bin = Object.assign(el('button', 'hd-menu-btn', d.os === 'windows' ? 'recycle bin' : 'trash'), {
    type: 'button',
  });
  bin.addEventListener('click', () => {
    shut();
    binWin(hd);
  });
  foot.append(who, el('span', 'hd-gap'), bin, gear);
  m.append(search, list, foot);
  // apps already streaming from here, taken up again
  if (streams(hd))
    void acctCall<{ apps: { id: string; title: string; name: string }[] }>(api(hd.host, 'running')).then((r) => {
      if (!r.ok || !r.apps?.length || !m.isConnected) return;
      const run = el('div', 'hd-apps hd-running');
      run.append(el('div', 'hd-apps-head', 'open'));
      for (const a of r.apps) {
        const b = Object.assign(el('button', 'hd-app'), { type: 'button', title: a.title || a.name });
        b.append(
          el('span', 'hd-noicon', (a.name || '?').slice(0, 1).toLowerCase()),
          el('span', 'hd-name', a.title || a.name),
        );
        b.addEventListener('click', () => {
          shut();
          streamWin(hd, { id: a.id, name: a.name });
        });
        run.append(b);
      }
      m.insertBefore(run, list);
    });
  hd.root.append(m);
  hd.root.classList.add('hd-open');
  hd.start = m;
  fill();
  search.focus();
  const away = (e: PointerEvent) => {
    if (!m.isConnected) return document.removeEventListener('pointerdown', away, true);
    const dock = hd.root.querySelector('.hd-dock');
    if (!m.contains(e.target as Node) && !btn.contains(e.target as Node) && !dock?.contains(e.target as Node)) {
      shut();
      document.removeEventListener('pointerdown', away, true);
    }
  };
  document.addEventListener('pointerdown', away, true);
  if (!hd.apps.length)
    void acctCall<{ apps: Item[] }>(api(hd.host, 'apps')).then((a) => {
      if (a.ok && a.apps) {
        hd.apps = a.apps;
        if (m.isConnected) fill();
      }
    });
}

// once the desktop is up: a host's tab takes its desk; elsewhere #desk=<host> opens
// it as a window here, then on each change of it
export function dkHostDeskHash(): void {
  if (tab) {
    if (!tab.root.closest('.dk-desk')) adopt(tab);
    return;
  }
  const m = tabRe.exec(location.hash);
  if (m && dk.desk) dkHostDesk(m[1]!);
}
addEventListener('hashchange', () => {
  const m = tabRe.exec(location.hash);
  // zoomed into again from another tab: grown again, the hash kept plain
  if (tab && m?.[1] === tab.host) {
    history.replaceState(null, '', `#desk=${tab.host}`);
    return grow(tab.root, m.slice(2, 6).map(Number));
  }
  if (!tab) dkHostDeskHash();
});
