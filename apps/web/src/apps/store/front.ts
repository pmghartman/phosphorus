// the front: tiles; the services tab an installer, the apps tab the desktop's extras, the
// running tab what the mesh runs: installed services, every host's published ones, the apps got

import type { AppSummary, FoundPage, Route, SourceId, StackView } from '@phosphorus/wire';
import { serviceUrl } from '../../features/mesh/routes.ts';
import { jsonPost } from '../../lib/api.ts';
import { dkGlyph, el, ICONS } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { pollState } from '../../lib/sync.ts';
import { facts, iconOf, iconTile, pill, tileSub } from './apps.ts';
import {
  agoText,
  bare,
  catalog,
  catalogError,
  hostUp,
  installedAs,
  keyOf,
  lead,
  openRepo,
  readCatalog,
  repoBox,
  SOURCE_NAMES,
  services,
  stackFacts,
  stackViews,
  twinsNamed,
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
        : stateVars.tab === 'running'
          ? 'search by name or host'
          : catalog
            ? `search ${services().length} apps, every source`
            : 'search every source',
    value: stateVars.filter,
    ariaLabel: `search ${stateVars.tab}`,
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

// an installable app's tile, once however many catalogues list it: what it is, where it's from,
// whether the mesh has it; its icon the first of theirs that loads
function stackTile(list: AppSummary[]): HTMLElement {
  const a = lead(list, stateVars.source);
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
  const more = list.length - 1;
  side.append(
    el('span', `store-pill${on ? ' open' : ''}`, on ? 'installed' : 'view'),
    Object.assign(el('span', 'store-tile-badge', `${SOURCE_NAMES[a.source]}${more ? ` +${more}` : ''}`), {
      title: more
        ? `in ${list.map((x) => SOURCE_NAMES[x.source]).join(', ')}; ${on ? 'installed' : 'shown'} from ${SOURCE_NAMES[a.source]}, ${a.licence}`
        : `from ${SOURCE_NAMES[a.source]}, ${a.licence}`,
    }),
  );
  t.append(iconTile(a.name, [a.icon, ...list.map((x) => x.icon)], 'md'), text, side);
  t.addEventListener('click', () => storeShow(`stack:${keyOf(a.source, a.ref)}`));
  return t;
}

// an installed app: its active host, its backups, their health and last copy, a takeover
function meshRow(v: StackView): HTMLElement {
  const f = stackFacts(v);
  const row = Object.assign(el('button', 'store-run'), { type: 'button' });
  const text = el('span', 'store-tile-text');
  const where = el('span', 'store-run-where');
  where.append(el('span', 'store-run-role', 'active'), el('span', 'store-run-host', f.live));
  if (f.hosts.length > 1)
    where.append(el('span', 'store-run-role', 'backups'), el('span', 'store-run-host', f.hosts.slice(1).join(', ')));
  else where.append(el('span', 'store-run-role', 'no backups'));
  text.append(el('b', 'store-tile-name', v.summary.name), where);
  const side = el('span', 'store-run-side');
  side.append(el('span', `store-tile-sub ${f.sub[0]}`, f.sub[1]));
  if (f.hosts.length > 1)
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
  'forgejo',
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
  // its icon the catalogues', when one lists a service of its name
  t.append(
    iconTile(
      f.title,
      twinsNamed(f.name).map((a) => a.icon),
      'md',
    ),
    text,
    side,
  );
  return t;
}

// the front's tabs: services onto hosts, apps for the desktop, what runs now
const TABS = {
  services: {
    title: 'services',
    lead: 'Self-hosted apps from open catalogues or any GitHub repo, installed onto a host you pick, with backup hosts that take over when it fails.',
  },
  apps: {
    title: 'apps',
    lead: 'Extras for the desktop. Get an app and every host serves its own copy, beside this desktop.',
  },
  running: {
    title: 'running',
    lead: 'What the mesh runs now: the services installed from here, every host’s published services, and the apps got for the desktop.',
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

// a catalogue not yet in on this host and not failed: its first download under way
const fetching = (s: { fetchedAt: number; error?: string; apps: number }) => !s.fetchedAt && !s.error && !s.apps;

function servicesTab(wrap: HTMLElement, q: string) {
  section(
    wrap,
    'on the mesh',
    stackViews()
      .filter((v) => !q || matches(v.summary, q))
      .map(meshRow),
    'store-runs',
  );
  // publishing is an admin's: the others aren't shown what they can't do; after what's
  // featured, so the catalogue leads
  const found = st.acct?.admin
    ? discovered().filter(
        (f) => !q || matches({ id: f.name, name: f.title, tagline: f.host, category: 'discovered' }, q),
      )
    : [];
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
      [
        ['', 'every source'],
        ...sources.map((s): [string, string] => [s.id, `${s.name} · ${fetching(s) ? '…' : s.apps}`]),
      ],
      stateVars.source,
      (v) => {
        stateVars.source = v;
        stateVars.category = '';
      },
    ),
  );
  // the catalogues this host couldn't fetch, said once with each one's why on hover; one being
  // fetched for the first time said by name
  const failed = sources.filter((s) => s.error);
  if (failed.length) {
    const n = el(
      'span',
      'store-repo-note store-unfetched',
      `${failed.map((s) => s.name).join(', ')} couldn’t be reached from this host; refresh tries again`,
    );
    n.title = failed.map((s) => `${s.name}: ${s.error}`).join('\n');
    filters.append(n);
  }
  for (const s of sources)
    if (!s.error && fetching(s)) filters.append(el('span', 'store-repo-note', `fetching ${s.name}…`));
  wrap.append(filters);
  // each service once, the catalogue filtered on one of those listing it
  const inSource = services().filter((l) => !stateVars.source || l.some((a) => a.source === stateVars.source));
  const leadOf = (l: AppSummary[]) => lead(l, stateVars.source);
  if (!q && !stateVars.category) {
    const featured: AppSummary[][] = [];
    for (const id of FEATURED) {
      const l = inSource.find((x) => x.some((a) => bare(a.id) === bare(id)));
      if (l) featured.push(l);
    }
    section(wrap, 'featured', featured.slice(0, 8).map(stackTile));
  }
  section(wrap, 'discovered', found.map(foundTile));
  const cats = new Map<string, number>();
  for (const l of inSource) {
    const c = leadOf(l).category;
    if (c) cats.set(c, (cats.get(c) ?? 0) + 1);
  }
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
    (l) => (!stateVars.category || leadOf(l).category === stateVars.category) && (!q || l.some((a) => matches(a, q))),
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

// a published service's row: its name opening it, its address, port and who may open it
function routeRow(r: Route): HTMLElement {
  const up = hostUp(r.host);
  const row = el('li', `store-route${up ? '' : ' off'}`);
  const url = serviceUrl(r);
  const name = up
    ? Object.assign(el('a', 'store-route-name', r.name), { href: url, target: '_blank', rel: 'noopener' })
    : el('span', 'store-route-name', r.name);
  const stack = stackViews().find((v) => v.summary.id === r.name);
  row.append(
    name,
    el('span', 'store-route-addr', url.replace(/^https:\/\//, '').replace(/\/$/, '')),
    el('span', 'store-route-port', r.port ? `:${r.port}` : ''),
    el('span', `store-route-tag${r.public ? ' warn' : ''}`, r.public ? 'public' : 'login'),
    el(
      'span',
      `store-route-tag${up ? (stack ? ' on' : '') : ' bad'}`,
      !up ? 'not answering' : stack ? (r.master ? 'installed, active' : 'installed') : r.auto ? 'found' : 'declared',
    ),
  );
  return row;
}

function runningTab(wrap: HTMLElement, q: string) {
  const hit = (...words: string[]) => !q || matches({ id: '', name: words.join(' '), tagline: '', category: '' }, q);
  const views = stackViews().filter((v) => hit(v.summary.name, v.summary.id, ...stackFacts(v).hosts));
  section(wrap, 'installed services', views.map(meshRow), 'store-runs', `${views.length}`);
  // each host's published services, this host first, the rest by name; game servers aside
  const routes = dk.services.filter((r) => !r.type && hit(r.name, r.host));
  const hosts = [...new Set(routes.map((r) => r.host))].sort(
    (a, b) => Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b),
  );
  for (const h of hosts) {
    const list = routes.filter((r) => r.host === h).sort((a, b) => a.name.localeCompare(b.name));
    const ul = el('ul', 'store-routes');
    ul.append(...list.map(routeRow));
    const s = el('section', 'store-section');
    const head = el('h2', 'store-section-head', `${h}${h === st.selfHost ? ' · this host' : ''}`);
    head.append(el('span', `store-count${hostUp(h) ? '' : ' bad'}`, hostUp(h) ? `${list.length}` : 'not answering'));
    s.append(head, ul);
    wrap.append(s);
  }
  const got = (apps ?? []).filter((a) => a.want && (!q || matches(a, q)));
  section(wrap, 'desktop apps', got.map(tile), 'store-grid', `${got.length}`);
  if (!hosts.length && !got.length && !views.length)
    wrap.append(el('div', 'store-empty', q ? `nothing running matches “${q}”` : 'nothing published on the mesh yet'));
}

export function front(): HTMLElement {
  const wrap = el('div', 'store-front');
  const onApps = stateVars.tab === 'apps';
  // its tabs and what the one open is for, no banner over them
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
  else if (stateVars.tab === 'running') runningTab(wrap, q);
  else servicesTab(wrap, q);
  return wrap;
}
