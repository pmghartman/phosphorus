// the front: tiles

import { editorPref } from '../../desktop/deskfiles.ts';
import { dkGlyph, el, ICONS } from '../../lib/dom.ts';
import { facts, iconOf, pill, tileSub } from './apps.ts';
import { draw, svcFacts, svcIcon, svcPill, svcSub } from './services.ts';
import { apps, read, readError, type StoreApp, type StoreService, services, stateVars, storeShow } from './state.ts';

// whether a tile matches the search: every word in its name, tagline, category or id
function matches(x: { id: string; name: string; tagline: string; category: string }, q: string): boolean {
  const text = `${x.id} ${x.name} ${x.tagline} ${x.category}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w));
}

// the search box, its focus and caret kept across the redraw each keystroke makes
function search(): HTMLElement {
  const box = Object.assign(el('input', 'store-search'), {
    type: 'search',
    placeholder: `search ${services.length + (apps?.length ?? 0)} apps and services`,
    value: stateVars.filter,
    ariaLabel: 'search apps and services',
  });
  box.addEventListener('input', () => {
    const at = box.selectionStart;
    stateVars.filter = box.value;
    draw();
    const next = document.querySelector<HTMLInputElement>('.store-search');
    if (next && next !== box) {
      next.focus();
      next.setSelectionRange(at, at);
    }
  });
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && box.value) {
      stateVars.filter = '';
      draw();
      document.querySelector<HTMLInputElement>('.store-search')?.focus();
    }
  });
  return box;
}

export function tile(a: StoreApp): HTMLElement {
  const f = facts(a);
  const t = Object.assign(el('button', `store-tile${f.want ? ' on' : ''}`), { type: 'button' });
  const text = el('span', 'store-tile-text');
  const [cls, sub] = tileSub(a, f);
  text.append(
    el('b', 'store-tile-name', a.name),
    el('span', 'store-tile-tag', a.tagline),
    el('span', `store-tile-sub ${cls}`, sub),
  );
  const side = el('span', 'store-tile-side');
  side.append(pill(a, f));
  if (a.id === 'sulfur' && editorPref() === 'sulfur') side.append(el('span', 'store-tile-badge', 'default editor'));
  t.append(iconOf(a, f, 'md'), text, side);
  t.addEventListener('click', () => storeShow(a.id));
  return t;
}

export function svcTile(s: StoreService): HTMLElement {
  const f = svcFacts(s);
  const t = Object.assign(el('button', `store-tile${f.on.length ? ' on' : ''}`), { type: 'button' });
  const text = el('span', 'store-tile-text');
  const [cls, sub] = svcSub(s, f);
  text.append(
    el('b', 'store-tile-name', s.name),
    el('span', 'store-tile-tag', s.tagline),
    el('span', `store-tile-sub ${cls}`, sub),
  );
  const side = el('span', 'store-tile-side');
  side.append(svcPill(s, f), el('span', 'store-tile-badge', 'service'));
  t.append(svcIcon(s, f, 'md'), text, side);
  t.addEventListener('click', () => storeShow(s.id));
  return t;
}

export function front(): HTMLElement {
  const wrap = el('div', 'store-front');
  const head = el('div', 'store-head');
  const title = el('div', 'store-title');
  title.append(
    el('h1', '', 'apps'),
    el(
      'p',
      'store-lead',
      'Extras for the mesh. Get an app and every host serves its own copy, beside this desktop; install a service onto the hosts you pick, as your own login there.',
    ),
  );
  const refresh = Object.assign(el('button', 'store-link'), { type: 'button', title: 'ask each release feed again' });
  refresh.append(dkGlyph(ICONS.refresh!, 'store-link-ic'), 'check for updates');
  refresh.addEventListener('click', () => read(true));
  const tools = el('div', 'store-tools');
  tools.append(search(), refresh);
  head.append(title, tools);
  wrap.append(head);
  if (!apps) wrap.append(el('div', 'store-empty', readError ? `can't read the catalogue: ${readError}` : 'connecting'));
  else if (!apps.length && !services.length) wrap.append(el('div', 'store-empty', 'nothing in the catalogue yet'));
  else {
    const q = stateVars.filter.trim();
    const shown = apps.filter((a) => !q || matches(a, q));
    const svcShown = services.filter((s) => !q || matches(s, q));
    const have = shown.filter((a) => a.want);
    const more = shown.filter((a) => !a.want);
    const svcOn = svcShown.filter((s) => svcFacts(s).on.length);
    const svcMore = svcShown.filter((s) => !svcFacts(s).on.length);
    // the mesh's own services first, the Docker catalogue by category after
    const own = svcMore.filter((s) => !s.docker);
    const docked = svcMore.filter((s) => s.docker);
    const section = (name: string, list: HTMLElement[]) => {
      if (!list.length) return;
      const s = el('section', 'store-section');
      s.append(el('h2', 'store-section-head', name));
      const grid = el('div', 'store-grid');
      grid.append(...list);
      s.append(grid);
      wrap.append(s);
    };
    section('on the mesh', [...have.map(tile), ...svcOn.map(svcTile)]);
    section(have.length || svcOn.length ? 'more' : 'discover', [...more.map(tile), ...own.map(svcTile)]);
    if (q) section('self-hosted', docked.map(svcTile));
    else
      for (const c of [...new Set(docked.map((s) => s.category))].sort())
        section(c, docked.filter((s) => s.category === c).map(svcTile));
    if (q && !shown.length && !svcShown.length) wrap.append(el('div', 'store-empty', `nothing matches “${q}”`));
    const updates = have.filter((a) => facts(a).update).length;
    if (updates)
      wrap
        .querySelector('.store-section-head')!
        .append(el('span', 'store-count', `${updates} update${updates === 1 ? '' : 's'}`));
  }
  return wrap;
}
