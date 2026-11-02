// the front: tiles

import type { FoundPage } from '@phosphorus/wire';
import { editorPref } from '../../desktop/deskfiles.ts';
import { jsonPost } from '../../lib/api.ts';
import { dkGlyph, el, ICONS } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { pollState } from '../../lib/sync.ts';
import { facts, iconOf, iconTile, pill, tileSub } from './apps.ts';
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
  side.append(
    svcPill(s, f),
    Object.assign(el('span', 'store-tile-badge', s.os.join(' · ')), { title: `runs on ${s.compat}` }),
  );
  t.append(svcIcon(s, f, 'md'), text, side);
  t.addEventListener('click', () => storeShow(s.id));
  return t;
}

// a found page on a host and its host's name
type Discovered = FoundPage & { host: string };

// every host's web pages its services.export doesn't name yet, those already
// routed (published a moment ago, the host's next scan not in) left out
function discovered(): Discovered[] {
  const routed = new Set(dk.services.map((r) => `${r.host}:${r.port}`));
  const out: Discovered[] = [];
  for (const [host, info] of Object.entries(st.hostsInfo))
    for (const f of info.found ?? []) if (!routed.has(`${host}:${f.port}`)) out.push({ ...f, host });
  return out.sort((a, b) => a.host.localeCompare(b.host) || a.port - b.port);
}

// a found page written into its host's services.export under its guessed name,
// the mode and scheme picked there
async function publish(f: Discovered) {
  stateVars.busyId = `found:${f.host}:${f.port}`;
  stateVars.sig = '';
  draw();
  try {
    const r = await fetch(
      `/api/services/${encodeURIComponent(f.host)}/${encodeURIComponent(f.name)}/publish`,
      jsonPost({ port: f.port }),
    );
    const out = await r.json().catch(() => ({}));
    const why = out.outcome && out.outcome.published !== true ? out.outcome.why : '';
    if (!r.ok || why) throw new Error(why || out.error || `status ${r.status}`);
    stateVars.actError = '';
  } catch (e) {
    stateVars.actError = `${f.name} not published: ${(e as Error).message}`;
  }
  stateVars.busyId = '';
  stateVars.sig = '';
  pollState();
  draw();
}

function foundTile(f: Discovered): HTMLElement {
  const busy = stateVars.busyId === `found:${f.host}:${f.port}`;
  const t = el('div', 'store-tile found');
  const text = el('span', 'store-tile-text');
  text.append(
    el('b', 'store-tile-name', f.title),
    el('span', 'store-tile-tag', `${f.host}:${f.port}`),
    el('span', 'store-tile-sub new', `publishes as ${f.name}`),
  );
  const go = Object.assign(el('button', `store-pill${busy ? ' wait' : ''}`, busy ? 'publishing' : 'publish'), {
    type: 'button',
    disabled: !!stateVars.busyId,
    title: `publish ${f.host}:${f.port} as ${f.name}, behind the phosphorus login`,
  });
  go.addEventListener('click', () => publish(f));
  const side = el('span', 'store-tile-side');
  side.append(go);
  t.append(iconTile(f.title, [], 'md'), text, side);
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
  else if (!apps.length && !services.length && !(st.acct?.admin && discovered().length))
    wrap.append(el('div', 'store-empty', 'nothing in the catalogue yet'));
  else {
    const q = stateVars.filter.trim();
    const shown = apps.filter((a) => !q || matches(a, q));
    const svcShown = services.filter((s) => !q || matches(s, q));
    const have = shown.filter((a) => a.want);
    const more = shown.filter((a) => !a.want);
    const svcOn = svcShown.filter((s) => svcFacts(s).on.length);
    const svcMore = svcShown.filter((s) => !svcFacts(s).on.length);
    // the mesh's own services first, the catalogue by category after
    const own = svcMore.filter((s) => !s.native);
    const docked = svcMore.filter((s) => s.native);
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
    // publishing is an admin's: the others aren't shown what they can't do
    if (st.acct?.admin) {
      const found = discovered().filter(
        (f) => !q || matches({ id: f.name, name: f.title, tagline: f.host, category: 'discovered' }, q),
      );
      section('discovered', found.map(foundTile));
    }
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
