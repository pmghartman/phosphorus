// the apps menu: every app on the desktop shown. The shared desktop's: phosphorus's own and the
// apps added to it from any host; a host's: phosphorus's terminal and files there, then every
// app the host has, each one a right click from the shared desktop

import { filesWin } from '../features/home/home.ts';
import { DK_GLYPHS, dkGlyph, el } from '../lib/dom.ts';
import { dk } from '../lib/state.ts';
import { dkSettings } from '../settings/settings.ts';
import { hostInfo, type Item, iconSrc, itemKey } from './desk/hosts.ts';
import { dkTryIcons } from './desk/icons.ts';
import { dkWebApp, dkWebApps } from './desk/webapps.ts';
import { dkMenu, dkOpenApp, dkTermApp } from './desk.ts';
import {
  hostFiles,
  hostTerm,
  isShared,
  itemTip,
  onSpace,
  openHostItem,
  setShared,
  sharedApps,
  spaceName,
} from './spaces.ts';
import { dkAnchor, dkPopReg, dkPopsClose, type Pop } from './taskbar.ts';

type Act = [string, () => void, boolean];
type Tile = {
  name: string;
  title: string;
  glyph?: string;
  src?: string;
  sub?: string;
  open: () => void;
  menu?: () => Act[];
};

let wrap: HTMLElement | undefined;
let pop: Pop | undefined;
let btn: HTMLButtonElement | undefined;
let query = '';

// the menu bar's apps button, made once
export function dkAppsBtn(): HTMLElement {
  if (wrap) return wrap;
  wrap = el('div', 'dk-tray-wrap dk-apps-wrap');
  btn = Object.assign(el('button', 'dk-tray dk-apps-btn'), { type: 'button', title: 'apps', ariaLabel: 'apps' });
  btn.setAttribute('aria-expanded', 'false');
  btn.append(dkGlyph(DK_GLYPHS.grid!), el('span', 'dk-apps-t', 'apps'));
  pop = Object.assign(el('div', 'dk-pop dk-apps-pop'), { hidden: true }) as Pop;
  wrap.append(btn, pop);
  dkAnchor(pop, btn, { fill: 560 });
  btn.addEventListener('click', () => show(!!pop!.hidden));
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target as Element;
      if (pop && !pop.hidden && !wrap!.contains(t) && !t.closest?.('.dk-menu')) show(false);
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pop && !pop.hidden) show(false);
  });
  dkPopReg('apps', show);
  onSpace(() => {
    if (pop && !pop.hidden) fill();
  });
  return wrap;
}

function show(on: boolean) {
  if (!pop || !btn) return;
  if (!on && pop.hidden) return;
  if (on) dkPopsClose('apps');
  pop.hidden = !on;
  btn.setAttribute('aria-expanded', String(on));
  if (on) {
    query = '';
    fill();
  }
}

// a host's app as a tile: its own icon, opened as phosphorus opens it, shared or not by a right click
const hostTile = (h: string, it: Item, sub = ''): Tile => ({
  name: it.name,
  title: itemTip(h, it),
  src: iconSrc(h, it),
  glyph: it.kind === 'cli' ? DK_GLYPHS.terminal! : DK_GLYPHS.app!,
  sub,
  open: () => openHostItem(h, it),
  menu: () => {
    const on = isShared(h, it);
    return [
      ['open', () => openHostItem(h, it), true],
      [on ? 'take off the shared desktop' : 'add to shared', () => setShared(h, it, !on), true],
    ];
  },
});

function sections(): [string, Tile[]][] {
  const h = dk.space;
  if (h) {
    const i = hostInfo(h);
    const own: Tile[] = [
      { name: 'terminal', title: `a terminal on ${h}`, glyph: DK_GLYPHS.terminal!, open: () => hostTerm(h) },
      { name: 'files', title: `every drive on ${h}`, glyph: DK_GLYPHS.files!, open: () => hostFiles(h) },
    ];
    const pins = (i.desk?.pins ?? []).map((it) => hostTile(h, it));
    const seen = new Set();
    const all = [...i.apps]
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter((it) => !seen.has(itemKey(it)) && seen.add(itemKey(it)))
      .map((it) => hostTile(h, it));
    return [
      [`phosphorus on ${h}`, own],
      ['pinned', pins],
      [i.apps.length ? 'all apps' : i.error ? i.error : 'reading the apps', all],
    ];
  }
  const own: Tile[] = [
    { name: 'terminal', title: 'terminal', glyph: DK_GLYPHS.terminal!, open: dkTermApp },
    { name: 'files', title: 'files', glyph: DK_GLYPHS.files!, open: () => void filesWin() },
    ...dkWebApps().map(
      (a): Tile => ({
        name: a.id,
        title: a.id,
        glyph: DK_GLYPHS.app!,
        src: `${a.mount}icon.svg?v=${a.want.version}`,
        open: () => void dkWebApp(a.id),
      }),
    ),
    { name: 'service wizard', title: 'service wizard', glyph: DK_GLYPHS.apps!, open: () => dkOpenApp('apps') },
    { name: 'settings', title: 'settings', glyph: DK_GLYPHS.settings!, open: () => dkSettings() },
  ];
  const shared = sharedApps()
    .filter((a) => dk.creds.has(a.host))
    .map((a) => hostTile(a.host, a, a.host));
  return [
    ['phosphorus', own],
    [
      shared.length ? 'shared from your hosts' : 'shared from your hosts: right click an app on a host to add it',
      shared,
    ],
  ];
}

function tile(t: Tile): HTMLButtonElement {
  const b = Object.assign(el('button', 'dk-app-tile'), { type: 'button', title: t.title });
  const ic = el('span', 'dk-app-ic');
  ic.append(dkGlyph(t.glyph ?? DK_GLYPHS.app!));
  // the host's own icon, asked again while it's still being read from the host
  if (t.src) dkTryIcons(ic, [t.src], 3000);
  b.append(ic, el('span', 'dk-app-n', t.name));
  if (t.sub) b.append(el('span', 'dk-app-s', t.sub));
  b.addEventListener('click', () => {
    show(false);
    t.open();
  });
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items: Act[] = t.menu?.() ?? [['open', t.open, true]];
    dkMenu(
      e.clientX,
      e.clientY,
      items.map(
        ([label, f, on]): Act => [
          label,
          () => {
            show(false);
            f();
          },
          on,
        ],
      ),
      undefined,
      t.name,
    );
  });
  return b;
}

function fill() {
  if (!pop) return;
  const head = el('div', 'dk-apps-head');
  const where = el('span', 'dk-apps-where', `${spaceName()} apps`);
  const search = Object.assign(el('input', 'dk-apps-search'), {
    placeholder: 'search',
    spellcheck: false,
    value: query,
  });
  head.append(where, search);
  const body = el('div', 'dk-apps-body');
  const paint = () => {
    const q = query.trim().toLowerCase();
    const parts: HTMLElement[] = [];
    for (const [label, tiles] of sections()) {
      const hit = tiles.filter((t) => !q || t.name.toLowerCase().includes(q));
      if (!hit.length && (q || !tiles.length) && !/reading|right click/.test(label)) continue;
      parts.push(el('div', 'dk-apps-h', label));
      if (hit.length) {
        const g = el('div', 'dk-apps-grid');
        g.append(...hit.map(tile));
        parts.push(g);
      }
    }
    if (!parts.length) parts.push(el('p', 'dk-apps-none', 'nothing matches'));
    body.replaceChildren(...parts);
  };
  search.addEventListener('input', () => {
    query = search.value;
    paint();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') body.querySelector<HTMLButtonElement>('.dk-app-tile')?.click();
  });
  paint();
  pop.replaceChildren(head, body);
  requestAnimationFrame(() => search.focus({ preventScroll: true }));
}
