// the catalogues the services tab draws on, their repos and licences, and whose the logos are

import { el } from '../../lib/dom.ts';
import { crumb } from './apps.ts';
import { agoText, catalog, catalogError } from './catalog.ts';

// how each catalogue's terms let phosphorus use it
const USE: Record<string, string> = {
  phosphorus:
    'Written for the mesh and shipped with phosphorus: each app’s compose file and manifest under phosphorus’s licence, the app itself under its own.',
  casaos:
    'Fetched by each host at run time; its terms would let phosphorus bundle it, keeping its licence and this credit.',
  runtipi: 'Fetched by each host at run time, never shipped with phosphorus.',
  cosmos: 'Fetched by each host at run time, never shipped with phosphorus.',
};

export function sourcesPage(): HTMLElement {
  const wrap = el('div', 'store-page');
  wrap.append(
    crumb('services', 'sources and licences'),
    el(
      'p',
      'store-about',
      'The services tab lists apps from open catalogues, each fetched from its repo by your own hosts, and any public GitHub repo you open. Every app shows where it came from and under what licence.',
    ),
  );
  const list = el('div', 'store-sources');
  for (const s of catalog?.sources ?? []) {
    if (s.id === 'github') continue;
    const card = el('section', 'store-source');
    const head = el('div', 'store-source-head');
    head.append(el('b', '', s.name), el('span', 'store-badge-lic', s.licence));
    const repo = Object.assign(el('a', 'store-source-repo', s.repo.replace(/^https?:\/\/(www\.)?/, '')), {
      href: s.repo,
      target: '_blank',
      rel: 'noopener',
    });
    card.append(
      head,
      repo,
      el('p', 'store-pick-note', USE[s.id] ?? 'Fetched by each host at run time.'),
      el(
        'span',
        `store-tile-sub${s.error ? ' bad' : ''}`,
        s.error
          ? `not fetched: ${s.error}`
          : `${s.apps} apps${s.fetchedAt ? `, fetched ${agoText(s.fetchedAt)}` : ', not fetched yet'}`,
      ),
    );
    list.append(card);
  }
  const gh = el('section', 'store-source');
  const head = el('div', 'store-source-head');
  head.append(el('b', '', 'GitHub repos'), el('span', 'store-badge-lic', 'each its own'));
  gh.append(
    head,
    el(
      'p',
      'store-pick-note',
      'A repo you open is read through GitHub’s API and installed from its own compose file; its licence is the repo’s, shown on its page.',
    ),
  );
  list.append(gh);
  if (!catalog)
    list.append(el('div', 'store-empty', catalogError ? `can't read the catalogues: ${catalogError}` : 'reading'));
  wrap.append(
    list,
    el(
      'p',
      'store-about dim',
      'Logos and app names belong to their projects. Phosphorus ships none: each icon is loaded from its source as you browse.',
    ),
  );
  return wrap;
}
