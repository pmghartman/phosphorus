// the front: tiles
import { dkGlyph, el, ICONS } from '../../lib/dom.ts';
import { editorPref } from '../../desktop/deskfiles.ts';
import { facts, iconOf, pill, tileSub } from './apps.ts';
import { svcFacts, svcIcon, svcPill, svcSub } from './services.ts';
import { apps, read, readError, services, storeShow, type StoreApp, type StoreService } from './state.ts';

export function tile(a: StoreApp): HTMLElement {
  const f = facts(a);
  const t = Object.assign(el('button', `store-tile${f.want ? ' on' : ''}`), { type: 'button' });
  const text = el('span', 'store-tile-text');
  const [cls, sub] = tileSub(a, f);
  text.append(el('b', 'store-tile-name', a.name), el('span', 'store-tile-tag', a.tagline), el('span', `store-tile-sub ${cls}`, sub));
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
  text.append(el('b', 'store-tile-name', s.name), el('span', 'store-tile-tag', s.tagline), el('span', `store-tile-sub ${cls}`, sub));
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
  title.append(el('h1', '', 'apps'), el('p', 'store-lead', 'Extras for the mesh. Get an app and every host serves its own copy, beside this desktop; install a service onto the hosts you pick, as your own login there.'));
  const refresh = Object.assign(el('button', 'store-link'), { type: 'button', title: 'ask each release feed again' });
  refresh.append(dkGlyph(ICONS.refresh!, 'store-link-ic'), 'check for updates');
  refresh.addEventListener('click', () => read(true));
  head.append(title, refresh);
  wrap.append(head);
  if (!apps) wrap.append(el('div', 'store-empty', readError ? `can't read the catalogue: ${readError}` : 'connecting'));
  else if (!apps.length && !services.length) wrap.append(el('div', 'store-empty', 'nothing in the catalogue yet'));
  else {
    const have = apps.filter((a) => a.want);
    const more = apps.filter((a) => !a.want);
    const svcOn = services.filter((s) => svcFacts(s).on.length);
    const svcMore = services.filter((s) => !svcFacts(s).on.length);
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
    section(have.length || svcOn.length ? 'more' : 'discover', [...more.map(tile), ...svcMore.map(svcTile)]);
    const updates = have.filter((a) => facts(a).update).length;
    if (updates) wrap.querySelector('.store-section-head')!.append(el('span', 'store-count', `${updates} update${updates === 1 ? '' : 's'}`));
  }
  return wrap;
}
