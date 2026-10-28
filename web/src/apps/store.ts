import { jsonPost } from '../api.ts';
import { DK_UI, dkGlyph, el, ICONS, pageAsk } from '../dom.ts';
import { st } from '../state.ts';
import { pollState } from '../sync.ts';
import type { AppStatus, AppWant, State } from '../types.ts';
import { ago2, newerVersion } from '../util.ts';
import { dkOpenApp, dkWebApp } from '../desktop/desk.ts';
import { editorPref, setEditorPref } from '../desktop/deskfiles.ts';

// --- apps: a store for the mesh's optional extras, each a web build installed onto every host --
// the front a grid of tiles, one open at a time as its own page: what it is, what's known of
// its release, every host's copy and its options. The catalogue and the feeds from /api/apps,
// each host's copy from the state push; an admin's get, update or remove one POST, every
// host following on its own

const view = document.getElementById('view-apps')!;

// one app as /api/apps lists it
interface StoreApp {
  id: string;
  name: string;
  tagline: string;
  about: string;
  features: string[];
  category: string;
  by: string;
  repo: string;
  mount: string;
  icon: string;
  agents: string[];
  want: AppWant | null;
  latest: string;
  feedError: string;
  checkedAt: number;
  local: AppStatus;
  signed: boolean;
}

let apps: StoreApp[] | null = null;
let readError = '';
let actError = '';
let busyId = '';
// the app open as its own page, '' for the front
let openId = '';
let sig = '';
let watching = false;
let timer: ReturnType<typeof setInterval> | null = null;

// the feed read on opening, held ten minutes on the server; fresh on the refresh button
async function read(fresh = false) {
  try {
    const r = await fetch(`/api/apps${fresh ? '?fresh=1' : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    apps = (await r.json()).apps as StoreApp[];
    readError = '';
  } catch (e) {
    readError = (e as Error).message;
  }
  sig = '';
  draw();
}

function storeState(_state: State | null): void {
  draw();
}

function storeWatch(on: boolean): void {
  watching = on;
  if (timer) { clearInterval(timer); timer = null; }
  if (!on) return;
  read();
  timer = setInterval(() => read(), 60000);
}

// an app's page shown, the window opened for it when needed
function storeShow(id: string): void {
  openId = id;
  sig = '';
  if (!watching) dkOpenApp('apps');
  draw();
}

async function act(path: string, id: string) {
  busyId = id;
  sig = '';
  draw();
  try {
    const r = await fetch(path, jsonPost({ id }));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `status ${r.status}`);
    actError = '';
  } catch (e) {
    actError = (e as Error).message;
  }
  busyId = '';
  pollState();
  read();
}

// --- what's known of an app, in one place ---------------------------------------

// every phosphorus host and its copy
function hostRows(a: StoreApp): [string, AppStatus | undefined][] {
  const names = (st.lastState?.tailnet || []).filter((d) => d.phosphorus).map((d) => d.name);
  if (st.selfHost && !names.includes(st.selfHost)) names.push(st.selfHost);
  return names.sort().map((h) => [h, st.hostsInfo[h]?.apps?.[a.id]]);
}

interface Facts {
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

function facts(a: StoreApp): Facts {
  const want = a.want;
  const mine = st.hostsInfo[st.selfHost]?.apps?.[a.id];
  const rows = hostRows(a);
  return {
    want,
    here: !!want && mine?.version === want.version,
    update: want && a.latest && newerVersion(a.latest, want.version) ? a.latest : '',
    on: rows.filter(([, s]) => want && s?.version === want.version).length,
    all: rows.length,
    busy: rows.some(([, s]) => s?.busy) || busyId === a.id,
    failed: rows.filter(([, s]) => s?.error).length,
  };
}

// the one button an app store has: get, open, update; what it does right now while it does
function pill(a: StoreApp, f: Facts, big = false): HTMLElement {
  const admin = !!st.acct?.admin;
  const b = Object.assign(el('button', `store-pill${big ? ' big' : ''}`), { type: 'button' });
  const set = (label: string, cls: string, go: (() => void) | null, title = '') => {
    b.textContent = label;
    b.className += ` ${cls}`;
    b.title = title;
    b.disabled = !go;
    if (go) b.addEventListener('click', (e) => { e.stopPropagation(); go(); });
  };
  if (busyId === a.id) set(f.want ? 'updating' : 'getting', 'wait', null);
  else if (!f.want) {
    if (admin) set('get', 'get', () => act('/api/apps/install', a.id), a.latest ? `install v${a.latest} onto every host` : a.feedError ? 'release feed unreachable' : 'checking the release feed');
    else set('get', 'get', null, 'an admin installs apps');
  } else if (f.update && admin) set('update', 'get', () => act('/api/apps/install', a.id), `v${f.update} onto every host`);
  else if (f.here) set('open', 'open', () => dkWebApp(a.id), `open ${a.name}`);
  else set(f.busy ? 'installing' : 'not here', 'wait', null, f.busy ? 'this host is fetching it' : `${st.selfHost} has no copy yet`);
  if (!a.latest && !f.want && !a.feedError) b.disabled = true;
  return b;
}

const iconOf = (a: StoreApp, f: Facts, cls: string) => {
  const tile = el('span', `store-icon ${cls}`);
  if (f.here || f.on) {
    const img = Object.assign(el('img'), { src: a.icon, alt: '', draggable: false });
    img.addEventListener('error', () => img.replaceWith(el('span', 'store-mono', a.name[0]!.toUpperCase())));
    tile.append(img);
  } else tile.append(el('span', 'store-mono', a.name[0]!.toUpperCase()));
  return tile;
};

// a line under a tile's name: on the mesh, an update, or what it is
function tileSub(a: StoreApp, f: Facts): [string, string] {
  if (busyId === a.id) return ['wait', f.want ? 'updating the mesh' : 'installing onto the mesh'];
  if (!f.want) return ['dim', a.category];
  if (f.failed) return ['bad', `v${f.want.version} · ${f.failed} host${f.failed === 1 ? '' : 's'} failed`];
  if (f.busy) return ['wait', `v${f.want.version} · installing on ${f.all - f.on} host${f.all - f.on === 1 ? '' : 's'}`];
  if (f.update) return ['new', `v${f.update} is out`];
  return ['on', `v${f.want.version} · on ${f.on === f.all ? 'every host' : `${f.on} of ${f.all} hosts`}`];
}

// --- the front: tiles -------------------------------------------------------------

function tile(a: StoreApp): HTMLElement {
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

function front(): HTMLElement {
  const wrap = el('div', 'store-front');
  const head = el('div', 'store-head');
  const title = el('div', 'store-title');
  title.append(el('h1', '', 'apps'), el('p', 'store-lead', 'Extras for the mesh. Get one and every host serves its own copy, beside this desktop.'));
  const refresh = Object.assign(el('button', 'store-link'), { type: 'button', title: 'ask each release feed again' });
  refresh.append(dkGlyph(ICONS.refresh!, 'store-link-ic'), 'check for updates');
  refresh.addEventListener('click', () => read(true));
  head.append(title, refresh);
  wrap.append(head);
  if (!apps) wrap.append(el('div', 'store-empty', readError ? `can't read the catalogue: ${readError}` : 'connecting'));
  else if (!apps.length) wrap.append(el('div', 'store-empty', 'nothing in the catalogue yet'));
  else {
    const have = apps.filter((a) => a.want);
    const more = apps.filter((a) => !a.want);
    const section = (name: string, list: StoreApp[]) => {
      if (!list.length) return;
      const s = el('section', 'store-section');
      s.append(el('h2', 'store-section-head', name));
      const grid = el('div', 'store-grid');
      grid.append(...list.map(tile));
      s.append(grid);
      wrap.append(s);
    };
    section('on the mesh', have);
    section(have.length ? 'more' : 'discover', more);
    const updates = have.filter((a) => facts(a).update).length;
    if (updates) wrap.querySelector('.store-section-head')!.append(el('span', 'store-count', `${updates} update${updates === 1 ? '' : 's'}`));
  }
  return wrap;
}

// --- an app's page ----------------------------------------------------------------

function infoRows(a: StoreApp, f: Facts): HTMLElement {
  const dl = el('dl', 'store-info');
  const row = (k: string, v: string | HTMLElement, cls = '') => {
    dl.append(el('dt', '', k));
    const dd = el('dd', cls);
    dd.append(v);
    dl.append(dd);
  };
  row('on the mesh', f.want ? `v${f.want.version}` : 'not installed');
  row('latest release', a.latest ? `v${a.latest}` : a.feedError ? `feed unreachable: ${a.feedError}` : 'checking', a.latest ? '' : 'dim');
  if (f.want?.from) row('installed by', `${f.want.from}${f.want.at ? `, ${ago2(f.want.at)}` : ''}`);
  row('served at', Object.assign(el('a', '', a.mount), { href: a.mount, target: '_blank', rel: 'noopener' }));
  row('source', Object.assign(el('a', '', a.repo.replace(/^https?:\/\//, '')), { href: a.repo, target: '_blank', rel: 'noopener' }));
  row('verified by', a.signed ? 'sha256 and the signature against [apps] key' : 'sha256 from the release feed');
  if (a.agents.length) row('asks models as', a.agents.join(', '), 'mono');
  row('category', a.category);
  return dl;
}

function hostList(a: StoreApp, f: Facts): HTMLElement {
  const list = el('ul', 'store-hosts');
  for (const [h, s] of hostRows(a)) {
    const li = el('li', 'store-host');
    const want = f.want;
    const cls = !s ? (want ? 'wait' : 'off') : s.error ? 'fail' : s.busy ? 'mid' : want && s.version === want.version ? 'ok' : s.version ? 'old' : 'wait';
    li.className += ` ${cls}`;
    const text = !s ? (want ? 'waiting' : 'none') : s.error ? s.error : s.busy ? 'installing' : s.version ? `v${s.version}${want && s.version !== want.version ? ', behind' : ''}` : 'removing';
    li.append(el('i', 'store-dot'), el('span', `store-host-name${h === st.selfHost ? ' is-self' : ''}`, h), el('span', 'store-host-state', text));
    if (s?.error) li.title = s.error;
    list.append(li);
  }
  if (!list.children.length) list.append(el('li', 'store-empty', 'no hosts in view'));
  return list;
}

// the editor files open in: the desktop's own, or sulfur, got for the mesh by picking it when
// no host has it yet; the choice kept with the user's settings on every host
function editorOption(a: StoreApp, f: Facts): HTMLElement {
  const row = el('div', 'store-option');
  const text = el('div', 'store-option-text');
  const now = editorPref();
  text.append(el('b', '', 'default editor'), el('span', 'store-option-sub', now === 'sulfur'
    ? (f.here ? 'files on the desktop open in Sulfur' : f.want ? 'files open in Sulfur once this host has it; the built-in editor until then' : 'files open in Sulfur once it’s on the mesh')
    : 'files on the desktop open in the built-in editor'));
  const seg = el('div', 'store-seg');
  for (const [id, label] of [['', 'built-in'], ['sulfur', 'Sulfur']] as [string, string][]) {
    const b = Object.assign(el('button', `store-seg-btn${now === id ? ' on' : ''}`, label), { type: 'button', ariaPressed: String(now === id) });
    b.addEventListener('click', () => {
      if (editorPref() === id) return;
      setEditorPref(id);
      actError = '';
      // sulfur picked before any host has it: got for the mesh, as the pill would
      if (id === 'sulfur' && !f.want) {
        if (st.acct?.admin) { act('/api/apps/install', a.id); return; }
        actError = 'Sulfur isn’t on the mesh yet: an admin gets it here; the built-in editor until then';
      }
      sig = '';
      draw();
    });
    seg.append(b);
  }
  row.append(text, seg);
  return row;
}

function page(a: StoreApp): HTMLElement {
  const f = facts(a);
  const admin = !!st.acct?.admin;
  const wrap = el('div', 'store-page');
  const back = Object.assign(el('button', 'store-back'), { type: 'button' });
  back.append(dkGlyph(DK_UI.back!, 'store-back-ic'), 'apps');
  back.addEventListener('click', () => storeShow(''));
  wrap.append(back);

  const hero = el('div', 'store-hero');
  const text = el('div', 'store-hero-text');
  const meta = el('div', 'store-hero-meta');
  meta.append(el('span', '', `by ${a.by}`), el('span', 'store-hero-dot', '·'), el('span', '', a.category));
  text.append(el('h1', '', a.name), el('p', 'store-hero-tag', a.tagline), meta);
  const acts = el('div', 'store-hero-acts');
  acts.append(pill(a, f, true));
  const [cls, sub] = tileSub(a, f);
  acts.append(el('span', `store-hero-sub ${cls}`, sub));
  if (f.here && f.update && admin) {
    const open = Object.assign(el('button', 'store-link'), { type: 'button' }, { textContent: `open v${f.want!.version}` });
    open.addEventListener('click', () => dkWebApp(a.id));
    acts.append(open);
  }
  hero.append(iconOf(a, f, 'lg'), text, acts);
  wrap.append(hero);

  const cols = el('div', 'store-cols');
  const main = el('div', 'store-main');
  const aboutSec = el('section', 'store-sec');
  aboutSec.append(el('h2', '', 'about'), el('p', 'store-about', a.about));
  if (a.features.length) {
    const ul = el('ul', 'store-features');
    for (const x of a.features) ul.append(el('li', '', x));
    aboutSec.append(ul);
  }
  main.append(aboutSec);
  if (a.id === 'sulfur') {
    const opt = el('section', 'store-sec');
    opt.append(el('h2', '', 'options'), editorOption(a, f));
    main.append(opt);
  }
  const hostsSec = el('section', 'store-sec');
  const hh = el('h2', '', 'on the mesh');
  if (f.want) hh.append(el('span', 'store-count', f.on === f.all ? 'every host' : `${f.on} of ${f.all} hosts`));
  hostsSec.append(hh, hostList(a, f));
  main.append(hostsSec);
  const side = el('aside', 'store-side');
  const infoSec = el('section', 'store-sec');
  infoSec.append(el('h2', '', 'information'), infoRows(a, f));
  side.append(infoSec);
  if (f.want && admin) {
    const danger = el('section', 'store-sec');
    const rm = Object.assign(el('button', 'store-remove', `remove ${a.name} from the mesh`), { type: 'button', disabled: busyId === a.id });
    rm.addEventListener('click', async () => {
      if (await pageAsk({ title: `remove ${a.name}`, message: `${a.name} v${f.want!.version} is dropped from every host. Nothing of yours is deleted; it can be got again.`, action: 'remove', danger: true })) act('/api/apps/remove', a.id);
    });
    danger.append(rm);
    side.append(danger);
  }
  cols.append(main, side);
  wrap.append(cols);
  return wrap;
}

function draw() {
  if (!watching) return;
  const next = JSON.stringify([apps, readError, actError, busyId, openId, st.selfHost, st.acct?.admin, st.hostsInfo, editorPref(), (st.lastState?.tailnet || []).map((d) => [d.name, d.phosphorus])]);
  if (next === sig) return;
  sig = next;
  // a page kept at its scroll across redraws
  const was = view.firstElementChild as HTMLElement | null;
  const scroll = was?.scrollTop || 0;
  const wrap = el('div', 'store');
  const open = openId ? apps?.find((a) => a.id === openId) : undefined;
  if (openId && !open && apps) openId = '';
  wrap.append(open ? page(open) : front());
  if (actError) wrap.append(el('div', 'store-err', actError));
  view.replaceChildren(wrap);
  wrap.scrollTop = scroll;
}

export { storeShow, storeState, storeWatch };
