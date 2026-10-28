import { jsonPost } from '../api.ts';
import { DK_UI, dkGlyph, el, ICONS, pageAsk } from '../dom.ts';
import { dk, st } from '../state.ts';
import { pollState } from '../sync.ts';
import type { AppStatus, AppWant, Route, State } from '../types.ts';
import { ago2, newerVersion } from '../util.ts';
import { dkOpenApp, dkService, dkWebApp } from '../desktop/desk.ts';
import { editorPref, setEditorPref } from '../desktop/deskfiles.ts';

// --- apps: a store for the mesh's optional extras, each a web build installed onto every host,
// or a service run on the hosts a person picks --
// the front a grid of tiles, one open at a time as its own page: what it is, what's known of
// its release, every host's copy and its options. The catalogue and the feeds from /api/apps,
// each host's copy from the state push; an admin's get, update or remove one POST, every
// host following on its own. A service is a git checkout per host, run there as the person's
// own login: anyone logged into a host on the desktop installs, updates or removes it there

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
  // off the repository, until a host serves the app's own
  repoIcon: string;
  agents: string[];
  want: AppWant | null;
  latest: string;
  feedError: string;
  checkedAt: number;
  local: AppStatus;
  signed: boolean;
}

// a service's step on one host, run there as a unit of the login's own; asked from the host
// from, finished by the host itself (packages/webapps services)
type SvcOp = 'install' | 'update' | 'remove';
interface SvcJob { id: string; host: string; op: SvcOp; by: string; login: string; from: string; keep: boolean; at: number; done: number; ok?: boolean; error: string; log: string; exit?: number }
interface SvcHost { published: boolean; route?: Route; version: string; record?: { login: string; by: string; at: number; commit: string }; job?: SvcJob; behind: number | null }

// one service as /api/apps lists it
interface StoreService {
  id: string;
  name: string;
  tagline: string;
  about: string;
  features: string[];
  category: string;
  by: string;
  repo: string;
  icon: string;
  port: number;
  mode: string;
  os: string[];
  needs: string;
  agents: string[];
  data: string[];
  checkout: string;
  kept: string;
  hosts: Record<string, SvcHost>;
}

let apps: StoreApp[] | null = null;
let services: StoreService[] = [];
let readError = '';
let actError = '';
let busyId = '';
// the app or service open as its own page, '' for the front
let openId = '';
// a service's log shown in full, by host
const logsOpen = new Set<string>();
let sig = '';
let watching = false;
let timer: ReturnType<typeof setInterval> | null = null;
let fast: ReturnType<typeof setTimeout> | null = null;

// the feed read on opening, held ten minutes on the server; fresh on the refresh button
async function read(fresh = false) {
  try {
    const r = await fetch(`/api/apps${fresh ? '?fresh=1' : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`status ${r.status}`);
    const got = await r.json();
    apps = got.apps as StoreApp[];
    services = (got.services || []) as StoreService[];
    readError = '';
  } catch (e) {
    readError = (e as Error).message;
  }
  sig = '';
  draw();
  // a service's step under way: read again soon, its log and outcome shown as they come
  if (fast) { clearTimeout(fast); fast = null; }
  if (watching && services.some((s) => Object.values(s.hosts).some((h) => h.job && !h.job.done))) fast = setTimeout(() => read(), 3000);
}

function storeState(_state: State | null): void {
  draw();
}

function storeWatch(on: boolean): void {
  watching = on;
  if (timer) { clearInterval(timer); timer = null; }
  if (fast) { clearTimeout(fast); fast = null; }
  if (!on) return;
  read();
  timer = setInterval(() => read(), 60000);
}

// an app's or service's page shown, the window opened for it when needed
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

// the icon tile: the first of srcs that loads, the initial when none does
function iconTile(name: string, srcs: string[], cls: string): HTMLElement {
  const tile = el('span', `store-icon ${cls}`);
  const mono = () => el('span', 'store-mono', name[0]!.toUpperCase());
  const next = (rest: string[], at: HTMLElement) => {
    const [src, ...more] = rest.filter(Boolean);
    if (!src) { at.replaceWith(mono()); return; }
    const img = Object.assign(el('img'), { src, alt: '', draggable: false });
    img.addEventListener('error', () => next(more, img), { once: true });
    at.replaceWith(img);
  };
  const first = el('span');
  tile.append(first);
  next(srcs, first);
  return tile;
}

// the copy a host serves once one does, the repository's until then
const iconOf = (a: StoreApp, f: Facts, cls: string) => iconTile(a.name, f.here || f.on ? [a.icon, a.repoIcon] : [a.repoIcon], cls);

// a line under a tile's name: on the mesh, an update, or what it is
function tileSub(a: StoreApp, f: Facts): [string, string] {
  if (busyId === a.id) return ['wait', f.want ? 'updating the mesh' : 'installing onto the mesh'];
  if (!f.want) return ['dim', a.category];
  if (f.failed) return ['bad', `v${f.want.version} · ${f.failed} host${f.failed === 1 ? '' : 's'} failed`];
  if (f.busy) return ['wait', `v${f.want.version} · installing on ${f.all - f.on} host${f.all - f.on === 1 ? '' : 's'}`];
  if (f.update) return ['new', `v${f.update} is out`];
  return ['on', `v${f.want.version} · on ${f.on === f.all ? 'every host' : `${f.on} of ${f.all} hosts`}`];
}

// --- what's known of a service: the hosts it can run on, where it runs, who may act ----------

// a host the service's scripts run on: a phosphorus host of one of its OSes, and the one
// this page is on when the tailnet hasn't it yet
function svcEligible(s: StoreService): string[] {
  const names = (st.lastState?.tailnet || []).filter((d) => d.phosphorus && (!d.os || s.os.includes(d.os))).map((d) => d.name);
  if (st.selfHost && !names.includes(st.selfHost) && !(st.lastState?.tailnet || []).some((d) => d.name === st.selfHost)) names.push(st.selfHost);
  return names.sort();
}

// the published route as the desk has it, the summary's own when the state hasn't caught up
function svcRoute(s: StoreService, host: string): Route | undefined {
  return dk.services.find((r) => r.host === host && r.name === s.id) ?? (s.hosts[host]?.route as Route | undefined);
}

// whether this person logged into host on the desktop, so their saved login may act there
const canAct = (host: string) => dk.creds.has(host);

interface SvcFacts {
  // every host it can run on, and for each what's known
  rows: [string, SvcHost | undefined][];
  // hosts serving it
  on: string[];
  // hosts with a step under way
  busy: string[];
  // hosts whose last step failed
  failed: string[];
  // hosts whose checkout main has moved past
  behind: string[];
  // hosts this person may install it onto: logged in, not serving it, nothing under way
  canInstall: string[];
}

function svcFacts(s: StoreService): SvcFacts {
  const rows = svcEligible(s).map((h): [string, SvcHost | undefined] => [h, s.hosts[h]]);
  const on = rows.filter(([h]) => !!svcRoute(s, h)).map(([h]) => h);
  const busy = rows.filter(([, x]) => x?.job && !x.job.done).map(([h]) => h);
  const failed = rows.filter(([, x]) => x?.job && x.job.done && x.job.ok === false).map(([h]) => h);
  const behind = rows.filter(([h, x]) => on.includes(h) && (x?.behind ?? 0) > 0).map(([h]) => h);
  return { rows, on, busy, failed, behind, canInstall: rows.filter(([h]) => canAct(h) && !on.includes(h) && !busy.includes(h)).map(([h]) => h) };
}

const opWord: Record<SvcOp, string> = { install: 'installing', update: 'updating', remove: 'removing' };

// a service's step on a host, as the person's saved login there; keep: a remove leaving
// the checkout's data aside
async function svcAct(op: SvcOp, s: StoreService, host: string, keep = false) {
  busyId = s.id;
  sig = '';
  draw();
  try {
    const r = await fetch(`/api/apps/services/${op}`, jsonPost({ id: s.id, host, keep }));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(out.error || `status ${r.status}`);
    actError = '';
  } catch (e) {
    actError = `${s.name} on ${host}: ${(e as Error).message}`;
  }
  busyId = '';
  read();
}

// the service opened: the one host serving it, or its page to pick one
function svcOpen(s: StoreService, f: SvcFacts, host?: string) {
  const h = host ?? (f.on.length === 1 ? f.on[0] : undefined);
  const r = h ? svcRoute(s, h) : undefined;
  if (r) dkService(r);
  else storeShow(s.id);
}

// where to install: the hosts it can run on, those this person logged into to pick from
function svcPick(s: StoreService, f: SvcFacts): Promise<string[]> {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil page-veil');
    const box = el('form', 'fm-ask store-pick');
    const end = (v: string[]) => { veil.remove(); resolve(v); };
    const list = el('ul', 'store-pick-list');
    const boxes: [string, HTMLInputElement][] = [];
    for (const [h] of f.rows) {
      const li = el('li', 'store-pick-row');
      const cb = Object.assign(el('input'), { type: 'checkbox' });
      const lab = el('label', 'store-pick-label');
      lab.append(cb, el('span', 'store-pick-host', h));
      let why = '';
      if (f.on.includes(h)) { cb.checked = true; cb.disabled = true; why = 'already here'; }
      else if (f.busy.includes(h)) { cb.disabled = true; why = opWord[s.hosts[h]!.job!.op]; }
      else if (!canAct(h)) { cb.disabled = true; why = 'log into it on the desktop first'; }
      else { boxes.push([h, cb]); cb.checked = f.canInstall.length === 1; }
      li.append(lab, el('span', `store-pick-why${why ? '' : ' hidden'}`, why));
      li.classList.toggle('off', cb.disabled);
      list.append(li);
    }
    const go = Object.assign(el('button', 'primary', 'install'), { type: 'submit' });
    const sync = () => { go.disabled = !boxes.some(([, cb]) => cb.checked); };
    for (const [, cb] of boxes) cb.addEventListener('change', sync);
    sync();
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    no.addEventListener('click', () => end([]));
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    const note = f.rows.length
      ? boxes.length ? `Installed as your own login on each host, in ${s.checkout}, and published on the mesh desktop.` : `You're logged into none of these on the desktop: log in from a host's lock in the task bar first.`
      : `${s.name} runs on ${s.os.join(', ')} hosts; the mesh has none.`;
    box.append(el('div', 'fm-ask-title', `install ${s.name} where?`), f.rows.length ? list : el('p', '', ''), el('p', '', note), acts);
    box.addEventListener('submit', (e) => { e.preventDefault(); end(boxes.filter(([, cb]) => cb.checked).map(([h]) => h)); });
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') end([]); });
    veil.addEventListener('pointerdown', (e) => { if (e.target === veil) end([]); });
    veil.appendChild(box);
    document.body.appendChild(veil);
    (boxes[0]?.[1] ?? go).focus();
  });
}

async function svcInstall(s: StoreService, f: SvcFacts) {
  const hosts = await svcPick(s, f);
  for (const h of hosts) await svcAct('install', s, h);
}

// the store's one button for a service: install, open; what it does right now while it does
function svcPill(s: StoreService, f: SvcFacts, big = false): HTMLElement {
  const b = Object.assign(el('button', `store-pill${big ? ' big' : ''}`), { type: 'button' });
  const set = (label: string, cls: string, go: (() => void) | null, title = '') => {
    b.textContent = label;
    b.className += ` ${cls}`;
    b.title = title;
    b.disabled = !go;
    if (go) b.addEventListener('click', (e) => { e.stopPropagation(); go(); });
  };
  if (busyId === s.id) set('starting', 'wait', null);
  else if (f.busy.length && !f.on.length) set(opWord[s.hosts[f.busy[0]!]!.job!.op], 'wait', null, `on ${f.busy.join(', ')}`);
  else if (f.on.length) set('open', 'open', () => svcOpen(s, f), f.on.length === 1 ? `open ${s.name} on ${f.on[0]}` : `${s.name} runs on ${f.on.length} hosts`);
  else if (f.canInstall.length) set('install', 'get', () => svcInstall(s, f), `onto a host you're logged into`);
  else set('install', 'get', null, f.rows.length ? `log into a ${s.os.join(' or ')} host on the desktop first` : `runs on ${s.os.join(', ')} hosts; the mesh has none`);
  return b;
}

// the icon the desktop shows, the running service's own, else the one off its repository
const svcIcon = (s: StoreService, f: SvcFacts, cls: string) => iconTile(s.name, [
  ...f.on.map((h) => `/api/favicon/${encodeURIComponent(h)}/${encodeURIComponent(s.id)}`),
  s.icon,
], cls);

// a line under a service's tile: where it runs, a step under way, or what it is
function svcSub(s: StoreService, f: SvcFacts): [string, string] {
  if (busyId === s.id) return ['wait', 'starting'];
  if (f.busy.length) return ['wait', `${opWord[s.hosts[f.busy[0]!]!.job!.op]} on ${f.busy.join(', ')}`];
  if (f.failed.length) return ['bad', `${s.hosts[f.failed[0]!]!.job!.op} failed on ${f.failed.join(', ')}`];
  if (f.behind.length) return ['new', `main moved: ${behindWords(s.hosts[f.behind[0]!]!.behind!)} past ${f.behind.join(', ')}`];
  if (f.on.length) return ['on', `on ${f.on.join(', ')}`];
  return ['dim', s.category];
}

const behindWords = (n: number) => `${n} commit${n === 1 ? '' : 's'}`;

// remove from a host: a service with data asks whether to keep it aside; null for no
function svcRemoveAsk(s: StoreService, host: string): Promise<{ keep: boolean } | null> {
  return new Promise((resolve) => {
    const veil = el('div', 'fm-veil page-veil');
    const box = el('form', 'fm-ask store-pick');
    const end = (v: { keep: boolean } | null) => { veil.remove(); resolve(v); };
    const keep = Object.assign(el('input'), { type: 'checkbox', checked: s.data.length > 0 });
    const text = el('p', '', `Its unit is stopped, its entry leaves ${host}'s services.export and its checkout in ${s.checkout} is deleted.`);
    const go = Object.assign(el('button', 'danger', 'remove'), { type: 'submit' });
    const no = Object.assign(el('button', '', 'cancel'), { type: 'button' });
    no.addEventListener('click', () => end(null));
    const acts = el('div', 'update-actions');
    acts.append(no, go);
    box.append(el('div', 'fm-ask-title', `remove ${s.name} from ${host}`), text);
    if (s.data.length) {
      const lab = el('label', 'store-pick-label');
      lab.append(keep, el('span', '', `keep its data (${s.data.join(', ')}) aside in ${s.kept}`));
      const note = el('p', 'store-pick-note', 'put back by the next install there');
      const sync = () => { note.textContent = keep.checked ? 'put back by the next install there' : 'its data goes with the checkout'; note.classList.toggle('warn', !keep.checked); };
      keep.addEventListener('change', sync);
      sync();
      box.append(lab, note);
    }
    box.append(acts);
    box.addEventListener('submit', (e) => { e.preventDefault(); end({ keep: s.data.length > 0 && keep.checked }); });
    box.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') end(null); });
    veil.addEventListener('pointerdown', (e) => { if (e.target === veil) end(null); });
    veil.appendChild(box);
    document.body.appendChild(veil);
    go.focus();
  });
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

function svcTile(s: StoreService): HTMLElement {
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

function front(): HTMLElement {
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

// --- a service's page: each host it can run on, with what this person may do there ----------

function svcInfoRows(s: StoreService, f: SvcFacts): HTMLElement {
  const dl = el('dl', 'store-info');
  const row = (k: string, v: string | HTMLElement, cls = '') => {
    dl.append(el('dt', '', k));
    const dd = el('dd', cls);
    dd.append(v);
    dl.append(dd);
  };
  row('on the mesh', f.on.length ? f.on.join(', ') : 'not installed');
  row('source', Object.assign(el('a', '', s.repo.replace(/^https?:\/\//, '').replace(/\.git$/, '')), { href: s.repo.replace(/\.git$/, ''), target: '_blank', rel: 'noopener' }));
  row('installed from', 'the repository’s main, cloned on the host', 'dim');
  if (s.data.length) row('on remove', `its ${s.data.join(', ')} may be kept in ${s.kept}, back on the next install`, 'dim');
  row('runs as', `your own login, a systemd user unit in ${s.checkout}`, 'mono');
  row('published as', `port ${s.port}, ${s.mode} mode, in the host’s services.export`);
  row('runs on', `${s.os.join(', ')} hosts`);
  row('needs', s.needs, 'dim');
  if (s.agents.length) row('asks models as', s.agents.join(', '), 'mono');
  row('category', s.category);
  return dl;
}

// a small button in a host's row
function svcBtn(label: string, title: string, go: () => void, cls = ''): HTMLButtonElement {
  const b = Object.assign(el('button', `store-host-btn ${cls}`.trim(), label), { type: 'button', title });
  b.addEventListener('click', go);
  return b;
}

function svcHostList(s: StoreService, f: SvcFacts): HTMLElement {
  const list = el('ul', 'store-hosts');
  for (const [h, x] of f.rows) {
    const li = el('li', 'store-host svc');
    const route = svcRoute(s, h);
    const job = x?.job;
    const running = !!job && !job.done;
    const failed = !!job && job.done && job.ok === false;
    const can = canAct(h);
    const behind = route && (x?.behind ?? 0) > 0 ? x!.behind! : 0;
    const cls = running ? 'mid' : failed ? 'fail' : route ? 'ok' : x?.record ? 'old' : 'off';
    li.className += ` ${cls}`;
    const text = running ? opWord[job.op]
      : failed ? `${job.op} failed`
      : route ? `${x?.version ? `v${x.version}` : 'running'}${behind ? ` · ${behindWords(behind)} behind main` : ''}`
      : x?.record ? 'installed, not answering'
      : can ? 'not installed' : 'not installed · log in on the desktop to install';
    const top = el('div', 'store-host-top');
    top.append(el('i', 'store-dot'), el('span', `store-host-name${h === st.selfHost ? ' is-self' : ''}`, h), el('span', `store-host-state${behind ? ' behind' : ''}`, text));
    if (failed) top.title = job.error;
    const acts = el('span', 'store-host-acts');
    if (route) acts.append(svcBtn('open', `open ${s.name} on ${h}`, () => svcOpen(s, f, h)));
    if (can && !running && busyId !== s.id) {
      if (route || x?.record) {
        acts.append(svcBtn('update', behind ? `main is ${behindWords(behind)} ahead: pull and rebuild on ${h}` : `pull main and rebuild on ${h}`, () => svcAct('update', s, h), behind ? 'new' : ''));
        acts.append(svcBtn('remove', `stop ${s.name} on ${h} and delete its checkout`, async () => {
          const a = await svcRemoveAsk(s, h);
          if (a) svcAct('remove', s, h, a.keep);
        }, 'danger'));
      } else acts.append(svcBtn('install', `onto ${h}, as your login there`, () => svcAct('install', s, h)));
    }
    if (job && (running || failed || logsOpen.has(`${s.id}/${h}`))) {
      acts.append(svcBtn(logsOpen.has(`${s.id}/${h}`) ? 'hide log' : 'log', 'the step’s output', () => {
        const k = `${s.id}/${h}`;
        if (logsOpen.has(k)) logsOpen.delete(k); else logsOpen.add(k);
        sig = '';
        draw();
      }));
    }
    top.append(acts);
    li.append(top);
    if (job && (running || failed || logsOpen.has(`${s.id}/${h}`))) {
      const who = `${job.op} as ${job.login}${job.by ? `, for ${job.by}` : ''}${job.from && job.from !== h ? `, from ${job.from}` : ''}, ${ago2(job.at)}${job.done ? `, ${job.ok ? 'done' : 'failed'}` : ' · runs on the host itself, this page may close'}`;
      const log = el('pre', `store-log${logsOpen.has(`${s.id}/${h}`) ? ' full' : ''}`, (failed && job.error ? `${job.log.trimEnd()}\n${job.error}` : job.log) || (running ? 'connecting…' : ''));
      li.append(el('div', 'store-log-who', who), log);
      // the newest lines in view
      requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
    }
    if (x?.record && !running) {
      li.append(el('div', 'store-host-note', `installed by ${x.record.by || x.record.login} as ${x.record.login}${x.record.at ? `, ${ago2(x.record.at)}` : ''}${x.record.commit ? `, at ${x.record.commit.slice(0, 7)}` : ''}`));
    }
    list.append(li);
  }
  if (!list.children.length) list.append(el('li', 'store-empty', `${s.name} runs on ${s.os.join(', ')} hosts; the mesh has none`));
  return list;
}

function svcPage(s: StoreService): HTMLElement {
  const f = svcFacts(s);
  const wrap = el('div', 'store-page');
  const back = Object.assign(el('button', 'store-back'), { type: 'button' });
  back.append(dkGlyph(DK_UI.back!, 'store-back-ic'), 'apps');
  back.addEventListener('click', () => storeShow(''));
  wrap.append(back);

  const hero = el('div', 'store-hero');
  const text = el('div', 'store-hero-text');
  const meta = el('div', 'store-hero-meta');
  meta.append(el('span', '', `by ${s.by}`), el('span', 'store-hero-dot', '·'), el('span', '', s.category), el('span', 'store-hero-dot', '·'), el('span', '', 'service'));
  text.append(el('h1', '', s.name), el('p', 'store-hero-tag', s.tagline), meta);
  const acts = el('div', 'store-hero-acts');
  acts.append(svcPill(s, f, true));
  const [cls, sub] = svcSub(s, f);
  acts.append(el('span', `store-hero-sub ${cls}`, sub));
  if (f.on.length && f.canInstall.length) {
    const more = Object.assign(el('button', 'store-link'), { type: 'button' }, { textContent: 'install on another host' });
    more.addEventListener('click', () => svcInstall(s, f));
    acts.append(more);
  }
  hero.append(svcIcon(s, f, 'lg'), text, acts);
  wrap.append(hero);

  const cols = el('div', 'store-cols');
  const main = el('div', 'store-main');
  const aboutSec = el('section', 'store-sec');
  aboutSec.append(el('h2', '', 'about'), el('p', 'store-about', s.about));
  if (s.features.length) {
    const ul = el('ul', 'store-features');
    for (const x of s.features) ul.append(el('li', '', x));
    aboutSec.append(ul);
  }
  main.append(aboutSec);
  const hostsSec = el('section', 'store-sec');
  const hh = el('h2', '', 'hosts');
  if (f.on.length) hh.append(el('span', 'store-count', `on ${f.on.length} of ${f.rows.length}`));
  hostsSec.append(hh, svcHostList(s, f));
  main.append(hostsSec);
  const side = el('aside', 'store-side');
  const infoSec = el('section', 'store-sec');
  infoSec.append(el('h2', '', 'information'), svcInfoRows(s, f));
  side.append(infoSec);
  const who = el('section', 'store-sec');
  who.append(el('h2', '', 'who installs'), el('p', 'store-about dim', 'Anyone logged into a host on this desktop installs, updates or removes it there, as that login. Admins are no different: a host you haven’t logged into is one you can’t install onto.'));
  side.append(who);
  cols.append(main, side);
  wrap.append(cols);
  return wrap;
}

function draw() {
  if (!watching) return;
  const next = JSON.stringify([apps, services, readError, actError, busyId, openId, [...logsOpen], st.selfHost, st.acct?.admin, st.hostsInfo, editorPref(), [...dk.creds.keys()], dk.services.map((r) => [r.host, r.name]), (st.lastState?.tailnet || []).map((d) => [d.name, d.phosphorus, d.os])]);
  if (next === sig) return;
  sig = next;
  // a page kept at its scroll across redraws
  const was = view.firstElementChild as HTMLElement | null;
  const scroll = was?.scrollTop || 0;
  const wrap = el('div', 'store');
  const open = openId ? apps?.find((a) => a.id === openId) : undefined;
  const openSvc = openId && !open ? services.find((s) => s.id === openId) : undefined;
  if (openId && !open && !openSvc && apps) openId = '';
  wrap.append(open ? page(open) : openSvc ? svcPage(openSvc) : front());
  if (actError) wrap.append(el('div', 'store-err', actError));
  view.replaceChildren(wrap);
  wrap.scrollTop = scroll;
}

export { storeShow, storeState, storeWatch };
