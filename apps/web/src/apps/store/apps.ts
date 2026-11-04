// what's known of an app, in one place

import type { AppStatus, AppWant } from '@phosphorus/wire';
import { dkWebApp } from '../../desktop/desk.ts';
import { DK_UI, dkGlyph, el, pageAsk } from '../../lib/dom.ts';
import { iconKnown, iconLearn, iconOrder } from '../../lib/iconmem.ts';
import { st } from '../../lib/state.ts';
import { ago2, newerVersion } from '../../lib/util.ts';
import { draw } from './draw.ts';
import { act, type StoreApp, stateVars, storeShow } from './state.ts';

// every phosphorus host and its copy
export function hostRows(a: StoreApp): [string, AppStatus | undefined][] {
  const names = (st.lastState?.tailnet || []).filter((d) => d.phosphorus).map((d) => d.name);
  if (st.selfHost && !names.includes(st.selfHost)) names.push(st.selfHost);
  return names.sort().map((h) => [h, st.hostsInfo[h]?.apps?.[a.id]]);
}

export interface Facts {
  want: AppWant | null;
  // this host serves the picked version
  here: boolean;
  // a newer release than the one picked
  update: string;
  // of the mesh's hosts, those on the picked version
  on: number;
  all: number;
  // a host still fetching or failing
  busy: boolean;
  failed: number;
}

export function facts(a: StoreApp): Facts {
  const want = a.want;
  const mine = st.hostsInfo[st.selfHost]?.apps?.[a.id];
  const rows = hostRows(a);
  return {
    want,
    here: !!want && mine?.version === want.version,
    update: want && a.latest && newerVersion(a.latest, want.version) ? a.latest : '',
    on: rows.filter(([, s]) => want && s?.version === want.version).length,
    all: rows.length,
    busy: rows.some(([, s]) => s?.busy) || stateVars.busyId === a.id,
    failed: rows.filter(([, s]) => s?.error).length,
  };
}

// the one button an app store has: get, open, update; what it does right now while it does
export function pill(a: StoreApp, f: Facts, big = false): HTMLElement {
  const admin = !!st.acct?.admin;
  const b = Object.assign(el('button', `btn store-pill${big ? ' big primary' : ''}`), { type: 'button' });
  const set = (label: string, cls: string, go: (() => void) | null, title = '') => {
    b.textContent = label;
    b.className += ` ${cls}`;
    b.title = title;
    b.disabled = !go;
    if (go)
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        go();
      });
  };
  if (stateVars.busyId === a.id) set(f.want ? 'updating' : 'getting', 'wait', null);
  else if (!f.want) {
    if (admin)
      set(
        'get',
        'get',
        () => act('/api/apps/install', a.id),
        a.latest
          ? `install v${a.latest} onto every host`
          : a.feedError
            ? 'release feed unreachable'
            : 'checking the release feed',
      );
    else set('get', 'get', null, 'an admin installs apps');
  } else if (f.update && admin)
    set('update', 'get', () => act('/api/apps/install', a.id), `v${f.update} onto every host`);
  else if (f.here) set('open', 'open', () => dkWebApp(a.id), `open ${a.name}`);
  else
    set(
      f.busy ? 'installing' : 'not here',
      'wait',
      null,
      f.busy ? 'this host is fetching it' : `${st.selfHost} has no copy yet`,
    );
  if (!a.latest && !f.want && !a.feedError) b.disabled = true;
  return b;
}

// a page's top line, pinned while the page scrolls: the way back to the front's tab, then the
// page's own icon and name
export function crumb(back: string, name: string, icon?: HTMLElement): HTMLElement {
  const row = el('div', 'store-crumb');
  const b = Object.assign(el('button', 'store-back'), { type: 'button' });
  b.append(dkGlyph(DK_UI.back!, 'store-back-ic'), back);
  b.addEventListener('click', () => storeShow(''));
  row.append(b, el('span', 'store-crumb-sep', '/'), ...(icon ? [icon] : []), el('h1', 'store-crumb-name', name));
  return row;
}

// each name's slot, in the order first drawn: tiles drawn together spread evenly round the wheel
const slots = new Map<string, number>();
// an app's hue: its slot by the golden ratio over the wheel, orange (the about tab's) skipped
export function hueOf(name: string): number {
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  let n = slots.get(key);
  if (n === undefined) slots.set(key, (n = slots.size));
  return Math.round((75 + ((n * 0.381966 * 315) % 315)) % 360);
}

// the icon tile: the first of srcs that loads, the initial when none does; the one
// that loaded last time tried first, none last time the initial at once, tried behind it
export function iconTile(name: string, srcs: string[], cls: string): HTMLElement {
  const tile = el('span', `store-icon ${cls}`);
  tile.style.setProperty('--hue', String(hueOf(name)));
  const mono = () => el('span', 'store-mono', name[0]!.toUpperCase());
  const list = srcs.filter(Boolean);
  const order = iconOrder(list);
  const known = iconKnown(list);
  const quiet = known === '';
  const next = (i: number) => {
    const src = order[i];
    if (!src) {
      if (!quiet) tile.replaceChildren(mono());
      iconLearn(list, '');
      return;
    }
    // the one that loaded before drawn with the tile, no blank frame on a redraw
    const img = Object.assign(el('img'), {
      src,
      alt: '',
      draggable: false,
      decoding: src === known ? ('sync' as const) : ('async' as const),
    });
    img.addEventListener(
      'load',
      () => {
        if (quiet) tile.replaceChildren(img);
        iconLearn(list, src);
      },
      { once: true },
    );
    img.addEventListener('error', () => next(i + 1), { once: true });
    if (!quiet) tile.replaceChildren(img);
  };
  tile.append(quiet ? mono() : el('span'));
  next(0);
  return tile;
}

// the copy a host serves once one does, the repository's until then
export const iconOf = (a: StoreApp, f: Facts, cls: string) =>
  iconTile(a.name, f.here || f.on ? [a.icon, a.repoIcon] : [a.repoIcon], cls);

// a line under a tile's name: on the mesh, an update, or what it is
export function tileSub(a: StoreApp, f: Facts): [string, string] {
  if (stateVars.busyId === a.id) return ['wait', f.want ? 'updating the mesh' : 'installing onto the mesh'];
  if (!f.want) return ['dim', a.category];
  if (f.failed) return ['bad', `v${f.want.version} · ${f.failed} host${f.failed === 1 ? '' : 's'} failed`];
  if (f.busy)
    return ['wait', `v${f.want.version} · installing on ${f.all - f.on} host${f.all - f.on === 1 ? '' : 's'}`];
  if (f.update) return ['new', `v${f.update} is out`];
  return ['on', `v${f.want.version} · on ${f.on === f.all ? 'every host' : `${f.on} of ${f.all} hosts`}`];
}

export function infoRows(a: StoreApp, f: Facts): HTMLElement {
  const dl = el('dl', 'store-info');
  const row = (k: string, v: string | HTMLElement, cls = '') => {
    dl.append(el('dt', '', k));
    const dd = el('dd', cls);
    dd.append(v);
    dl.append(dd);
  };
  row('on the mesh', f.want ? `v${f.want.version}` : 'not installed');
  row(
    'latest release',
    a.latest ? `v${a.latest}` : a.feedError ? `feed unreachable: ${a.feedError}` : 'checking',
    a.latest ? '' : 'dim',
  );
  if (f.want?.from) row('installed by', `${f.want.from}${f.want.at ? `, ${ago2(f.want.at)}` : ''}`);
  row('served at', Object.assign(el('a', '', a.mount), { href: a.mount, target: '_blank', rel: 'noopener' }));
  row(
    'source',
    Object.assign(el('a', '', a.repo.replace(/^https?:\/\//, '')), { href: a.repo, target: '_blank', rel: 'noopener' }),
  );
  row('verified by', a.signed ? 'sha256 and the signature against the app key' : 'sha256 from the release feed');
  if (a.agents.length) row('asks models as', a.agents.join(', '), 'mono');
  row('category', a.category);
  return dl;
}

export function hostList(a: StoreApp, f: Facts): HTMLElement {
  const list = el('ul', 'store-hosts');
  for (const [h, s] of hostRows(a)) {
    const li = el('li', 'store-host');
    const want = f.want;
    const cls = !s
      ? want
        ? 'wait'
        : 'off'
      : s.error
        ? 'fail'
        : s.busy
          ? 'mid'
          : want && s.version === want.version
            ? 'ok'
            : s.version
              ? 'old'
              : 'wait';
    li.className += ` ${cls}`;
    const text = !s
      ? want
        ? 'waiting'
        : 'none'
      : s.error
        ? s.error
        : s.busy
          ? 'installing'
          : s.version
            ? `v${s.version}${want && s.version !== want.version ? ', behind' : ''}`
            : 'removing';
    li.append(
      el('i', 'store-dot'),
      el('span', `store-host-name${h === st.selfHost ? ' is-self' : ''}`, h),
      el('span', 'store-host-state', text),
    );
    if (s?.error) li.title = s.error;
    list.append(li);
  }
  if (!list.children.length) list.append(el('li', 'store-empty', 'no hosts in view'));
  return list;
}

export function page(a: StoreApp): HTMLElement {
  const f = facts(a);
  const admin = !!st.acct?.admin;
  const wrap = el('div', 'store-page');
  wrap.append(crumb('apps', a.name, iconOf(a, f, 'sm')));

  // get, update or remove, and how it is, at the top of the side column
  const acts = el('section', 'store-sec store-acts-sec');
  acts.append(pill(a, f, true));
  const [cls, sub] = tileSub(a, f);
  acts.append(el('span', `store-tile-sub ${cls}`, sub));
  if (f.here && f.update && admin) {
    const open = Object.assign(
      el('button', 'store-link'),
      { type: 'button' },
      { textContent: `open v${f.want!.version}` },
    );
    open.addEventListener('click', () => dkWebApp(a.id));
    acts.append(open);
  }

  const cols = el('div', 'store-cols');
  const main = el('div', 'store-main');
  const aboutSec = el('section', 'store-sec');
  aboutSec.append(el('p', 'store-tag', a.tagline), el('h2', '', 'about'), el('p', 'store-about', a.about));
  if (a.features.length) {
    const ul = el('ul', 'store-features');
    for (const x of a.features) ul.append(el('li', '', x));
    aboutSec.append(ul);
  }
  main.append(aboutSec);
  const hostsSec = el('section', 'store-sec');
  const hh = el('h2', '', 'on the mesh');
  if (f.want) hh.append(el('span', 'store-count', f.on === f.all ? 'every host' : `${f.on} of ${f.all} hosts`));
  hostsSec.append(hh, hostList(a, f));
  main.append(hostsSec);
  const side = el('aside', 'store-side');
  side.append(acts);
  const infoSec = el('section', 'store-sec');
  infoSec.append(el('h2', '', 'information'), infoRows(a, f));
  side.append(infoSec);
  if (f.want && admin) {
    const danger = el('section', 'store-sec');
    const rm = Object.assign(el('button', 'store-remove', `remove ${a.name} from the mesh`), {
      type: 'button',
      disabled: stateVars.busyId === a.id,
    });
    rm.addEventListener('click', async () => {
      if (
        await pageAsk({
          title: `remove ${a.name}`,
          message: `${a.name} v${f.want!.version} is dropped from every host. Nothing of yours is deleted; it can be got again.`,
          action: 'remove',
          danger: true,
        })
      )
        act('/api/apps/remove', a.id);
    });
    danger.append(rm);
    side.append(danger);
  }
  cols.append(main, side);
  wrap.append(cols);
  return wrap;
}
