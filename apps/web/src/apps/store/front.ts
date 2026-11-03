// the front: tiles; the services tab an installer, the apps tab the desktop's extras

import type { AppSummary, FoundPage, SourceId, StackView } from '@phosphorus/wire';
import { jsonPost } from '../../lib/api.ts';
import { dkGlyph, el, ICONS } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { pollState } from '../../lib/sync.ts';
import { facts, iconOf, iconTile, pill, tileSub } from './apps.ts';
import {
  agoText,
  catalog,
  catalogError,
  installedAs,
  keyOf,
  openRepo,
  readCatalog,
  repoBox,
  SOURCE_NAMES,
  stackFacts,
  stackViews,
} from './catalog.ts';
import { draw } from './draw.ts';
import { apps, nativeLeft, read, readError, type StoreApp, stateVars, storeShow } from './state.ts';

// whether a tile matches the search: every word in its name, tagline, category or id
function matches(x: { id: string; name: string; tagline: string; category: string }, q: string): boolean {
  const text = `${x.id} ${x.name} ${x.tagline} ${x.category}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => text.includes(w));
}

// the search box, its focus and caret kept by draw across the redraw each keystroke makes
function search(): HTMLElement {
  const box = Object.assign(el('input', 'store-search'), {
    type: 'search',
    placeholder:
      stateVars.tab === 'apps'
        ? `search ${apps?.length ?? 0} apps`
        : catalog
          ? `search ${catalog.apps.length} apps, every source`
          : 'search every source',
    value: stateVars.filter,
    ariaLabel: stateVars.tab === 'apps' ? 'search apps' : 'search services',
  });
  box.dataset.keep = 'search';
  box.addEventListener('input', () => {
    stateVars.filter = box.value;
    stateVars.all = false;
    draw();
  });
  box.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' && box.value) {
      stateVars.filter = '';
      draw();
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
  t.append(iconOf(a, f, 'md'), text, side);
  t.addEventListener('click', () => storeShow(a.id));
  return t;
}

// an installable app's tile: what it is, where it's from, whether the mesh has it
function stackTile(a: AppSummary): HTMLElement {
  const on = installedAs(a.source, a.ref);
  const t = Object.assign(el('button', `store-tile${on ? ' on' : ''}`), { type: 'button' });
  const text = el('span', 'store-tile-text');
  const [cls, sub] = on ? stackFacts(on).sub : ['dim', a.category];
  text.append(
    el('b', 'store-tile-name', a.name),
    el('span', 'store-tile-tag', a.tagline),
    el('span', `store-tile-sub ${cls}`, sub),
  );
  const side = el('span', 'store-tile-side');
  side.append(
    el('span', `store-pill${on ? ' open' : ''}`, on ? 'installed' : 'view'),
    Object.assign(el('span', 'store-tile-badge', SOURCE_NAMES[a.source]), {
      title: `from ${SOURCE_NAMES[a.source]}, ${a.licence}`,
    }),
  );
  t.append(iconTile(a.name, [a.icon], 'md'), text, side);
  t.addEventListener('click', () => storeShow(`stack:${keyOf(a.source, a.ref)}`));
  return t;
}

// an installed app: its active host, its backups, their health and last copy, a takeover
function meshRow(v: StackView): HTMLElement {
  const f = stackFacts(v);
  const row = Object.assign(el('button', 'store-run'), { type: 'button' });
  const text = el('span', 'store-tile-text');
  const where = el('span', 'store-run-where');
  where.append(el('span', 'store-run-role', 'active'), el('span', 'store-run-host', v.active));
  if (v.standbys.length)
    where.append(el('span', 'store-run-role', 'backups'), el('span', 'store-run-host', v.standbys.join(', ')));
  else where.append(el('span', 'store-run-role', 'no backups'));
  text.append(el('b', 'store-tile-name', v.summary.name), where);
  const side = el('span', 'store-run-side');
  side.append(el('span', `store-tile-sub ${f.sub[0]}`, f.sub[1]));
  if (v.standbys.length)
    side.append(
      el(
        'span',
        `store-tile-sub ${f.synced ? '' : 'wait'}`,
        f.synced ? `synced ${agoText(f.synced)}` : 'first copy pending',
      ),
    );
  if (f.event) side.append(el('span', `store-tile-sub ${f.event[0]}`, f.event[1]));
  row.append(iconTile(v.summary.name, [v.summary.icon], 'md'), text, side);
  row.addEventListener('click', () => storeShow(`stack:${keyOf(v.summary.source, v.summary.ref)}`));
  return row;
}

// a public github repo with a compose file, opened by its url
function repoOpener(): HTMLElement {
  const box = el('form', 'store-repo');
  const input = Object.assign(el('input', 'store-repo-url'), {
    type: 'text',
    placeholder: 'github.com/owner/repo',
    value: repoBox.url,
    ariaLabel: 'a GitHub repo’s url',
    spellcheck: false,
  });
  input.dataset.keep = 'repo';
  input.addEventListener('input', () => {
    repoBox.url = input.value;
  });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  const go = Object.assign(
    el('button', `store-pill${repoBox.busy ? ' wait' : ''}`, repoBox.busy ? 'opening' : 'open'),
    {
      type: 'submit',
      disabled: repoBox.busy,
    },
  );
  box.addEventListener('submit', (e) => {
    e.preventDefault();
    repoBox.url = input.value;
    openRepo(storeShow);
  });
  const line = el('div', 'store-repo-line');
  line.append(input, go);
  box.append(
    el('b', 'store-repo-head', 'open a GitHub repo'),
    el(
      'span',
      'store-repo-sub',
      'Any public repo with a compose file: its readme, its files, and whether it installs.',
    ),
    line,
  );
  if (repoBox.error) box.append(el('span', 'store-repo-err', repoBox.error));
  return box;
}

// a row of choices, one picked or none: the sources, the categories
function chips(list: [string, string][], now: string, pick: (v: string) => void): HTMLElement {
  const bar = el('div', 'store-chips');
  for (const [v, label] of list) {
    const b = Object.assign(el('button', `store-chip${now === v ? ' on' : ''}`, label), {
      type: 'button',
      ariaPressed: String(now === v),
    });
    b.addEventListener('click', () => {
      pick(now === v ? '' : v);
      stateVars.all = false;
      draw();
    });
    bar.append(b);
  }
  return bar;
}

// the apps worth a first look, by id in whichever catalogue lists them first
const FEATURED = [
  'uptime-kuma',
  'vaultwarden',
  'jellyfin',
  'immich',
  'nextcloud',
  'home-assistant',
  'paperless-ngx',
  'audiobookshelf',
  'navidrome',
  'syncthing',
  'gitea',
  'adguard-home',
];
const bare = (id: string) => id.toLowerCase().replace(/[^a-z0-9]/g, '');
// tiles shown before 'show all'
const FIRST = 48;
// categories offered: those with a few apps, the most used first
const CAT_MIN = 3;
const CAT_MAX = 24;

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

// the front's two tabs: services onto hosts, apps for the desktop
const TABS = {
  services: {
    title: 'services',
    lead: 'Self-hosted apps from open catalogues or any GitHub repo, installed onto a host you pick, with backup hosts that take over when it fails.',
  },
  apps: {
    title: 'apps',
    lead: 'Extras for the desktop. Get an app and every host serves its own copy, beside this desktop.',
  },
} as const;

function tabs(): HTMLElement {
  const bar = Object.assign(el('div', 'store-tabs'), { role: 'tablist' });
  for (const id of Object.keys(TABS) as (keyof typeof TABS)[]) {
    const on = stateVars.tab === id;
    const b = Object.assign(el('button', `store-tab${on ? ' on' : ''}`, TABS[id].title), {
      type: 'button',
      role: 'tab',
      ariaSelected: String(on),
    });
    b.addEventListener('click', () => {
      if (stateVars.tab === id) return;
      stateVars.tab = id;
      draw();
    });
    bar.append(b);
  }
  return bar;
}

function section(wrap: HTMLElement, name: string, list: HTMLElement[], cls = 'store-grid', count = '') {
  if (!list.length) return;
  const s = el('section', 'store-section');
  const h = el('h2', 'store-section-head', name);
  if (count) h.append(el('span', 'store-count', count));
  const grid = el('div', cls);
  grid.append(...list);
  s.append(h, grid);
  wrap.append(s);
}

function appsTab(wrap: HTMLElement, q: string) {
  if (!apps) {
    wrap.append(el('div', 'store-empty', readError ? `can't read the catalogue: ${readError}` : 'connecting'));
    return;
  }
  const shown = apps.filter((a) => !q || matches(a, q));
  const have = shown.filter((a) => a.want);
  const updates = have.filter((a) => facts(a).update).length;
  section(
    wrap,
    'on the mesh',
    have.map(tile),
    'store-grid',
    updates ? `${updates} update${updates === 1 ? '' : 's'}` : '',
  );
  section(wrap, have.length ? 'more' : 'get', shown.filter((a) => !a.want).map(tile));
  if (!shown.length)
    wrap.append(el('div', 'store-empty', q ? `no app matches “${q}”` : 'no apps in the catalogue yet'));
}

function servicesTab(wrap: HTMLElement, q: string) {
  section(
    wrap,
    'on the mesh',
    stackViews()
      .filter((v) => !q || matches(v.summary, q))
      .map(meshRow),
    'store-runs',
  );
  // publishing is an admin's: the others aren't shown what they can't do
  const found = st.acct?.admin
    ? discovered().filter(
        (f) => !q || matches({ id: f.name, name: f.title, tagline: f.host, category: 'discovered' }, q),
      )
    : [];
  section(wrap, 'discovered', found.map(foundTile));
  // services the retired installer left on hosts, nothing following them now
  if (nativeLeft.length && !q)
    wrap.append(
      el(
        'p',
        'store-empty',
        `Left by the old installer, no longer managed: ${nativeLeft.join(', ')}. Remove them on their hosts by hand, or install them again from here.`,
      ),
    );
  if (!q) wrap.append(repoOpener());
  if (!catalog) {
    wrap.append(
      el(
        'div',
        `store-empty${catalogError ? ' bad' : ''}`,
        catalogError ? `can't read the catalogues: ${catalogError}` : 'reading the catalogues',
      ),
    );
    return;
  }
  const sources = catalog.sources.filter((s) => s.id !== 'github');
  const filters = el('div', 'store-filters');
  filters.append(
    chips(
      [['', 'every source'], ...sources.map((s): [string, string] => [s.id, `${s.name} · ${s.apps}`])],
      stateVars.source,
      (v) => {
        stateVars.source = v;
        stateVars.category = '';
      },
    ),
  );
  // a catalogue this host couldn't fetch, said beside its name
  for (const s of sources) if (s.error) filters.append(el('span', 'store-repo-err', `${s.name}: ${s.error}`));
  wrap.append(filters);
  const inSource = catalog.apps.filter((a) => !stateVars.source || a.source === stateVars.source);
  if (!q && !stateVars.category) {
    const featured: AppSummary[] = [];
    for (const id of FEATURED) {
      const a = inSource.find((x) => bare(x.id) === bare(id));
      if (a) featured.push(a);
    }
    section(wrap, 'featured', featured.slice(0, 8).map(stackTile));
  }
  const cats = new Map<string, number>();
  for (const a of inSource) if (a.category) cats.set(a.category, (cats.get(a.category) ?? 0) + 1);
  // the catalogues' own words, many used once: the common ones, the picked one always
  const common = [...cats]
    .filter(([c, n]) => n >= CAT_MIN || c === stateVars.category)
    .sort(([a, n], [b, m]) => m - n || a.localeCompare(b))
    .slice(0, CAT_MAX);
  if (common.length > 1) {
    const s = el('section', 'store-section');
    s.append(
      el('h2', 'store-section-head', 'categories'),
      chips(
        common.map(([c, n]): [string, string] => [c, `${c} · ${n}`]),
        stateVars.category,
        (v) => {
          stateVars.category = v;
        },
      ),
    );
    wrap.append(s);
  }
  const picked = inSource.filter(
    (a) => (!stateVars.category || a.category === stateVars.category) && (!q || matches(a, q)),
  );
  const name = q
    ? 'matches'
    : stateVars.category || (stateVars.source ? SOURCE_NAMES[stateVars.source as SourceId] : 'every app');
  section(
    wrap,
    name,
    (stateVars.all ? picked : picked.slice(0, FIRST)).map(stackTile),
    'store-grid',
    `${picked.length}`,
  );
  if (picked.length > FIRST && !stateVars.all) {
    const more = Object.assign(el('button', 'store-more', `show all ${picked.length}`), { type: 'button' });
    more.addEventListener('click', () => {
      stateVars.all = true;
      draw();
    });
    wrap.append(more);
  }
  if (!picked.length)
    wrap.append(
      el(
        'div',
        'store-empty',
        q
          ? `no app matches “${q}”${stateVars.source || stateVars.category ? ' here; try every source' : ''}`
          : catalog.apps.length
            ? 'nothing here'
            : 'no catalogue fetched yet',
      ),
    );
  const credit = Object.assign(el('button', 'store-link store-credit', 'sources and licences'), { type: 'button' });
  credit.addEventListener('click', () => storeShow('sources'));
  wrap.append(credit);
}

export function front(): HTMLElement {
  const wrap = el('div', 'store-front');
  const onApps = stateVars.tab === 'apps';
  const head = el('div', 'store-head');
  const title = el('div', 'store-title');
  title.append(tabs(), el('p', 'store-lead', TABS[stateVars.tab].lead));
  const refresh = Object.assign(el('button', 'store-link'), {
    type: 'button',
    title: onApps ? 'ask each release feed again' : 'read the catalogues again',
  });
  refresh.append(dkGlyph(ICONS.refresh!, 'store-link-ic'), onApps ? 'check for updates' : 'refresh');
  refresh.addEventListener('click', () => (onApps ? read(true) : readCatalog()));
  const tools = el('div', 'store-tools');
  tools.append(search(), refresh);
  head.append(title, tools);
  wrap.append(head);
  const q = stateVars.filter.trim();
  if (onApps) appsTab(wrap, q);
  else servicesTab(wrap, q);
  return wrap;
}
