import { jsonPost } from '../api.ts';
import { el, pageAsk } from '../dom.ts';
import { st } from '../state.ts';
import { pollState } from '../sync.ts';
import type { AppStatus, AppWant, State } from '../types.ts';
import { newerVersion } from '../util.ts';
import { dkWebApp } from '../desktop/desk.ts';
import { editorPref, EDITORS, setEditorPref } from '../desktop/deskfiles.ts';

// --- apps: optional extras the mesh can take, each a web build installed onto every host --
// the catalogue and the feeds from /api/apps, each host's copy from the state push; an
// admin's install or remove one POST, every host following on its own

const view = document.getElementById('view-apps')!;

// one app as /api/apps lists it
interface StoreApp {
  id: string;
  name: string;
  about: string;
  repo: string;
  mount: string;
  icon: string;
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

// every phosphorus host and its copy: the want's version, behind it, fetching, or failed
function hostRows(a: StoreApp): [string, AppStatus | undefined][] {
  const names = (st.lastState?.tailnet || []).filter((d) => d.phosphorus).map((d) => d.name);
  if (st.selfHost && !names.includes(st.selfHost)) names.push(st.selfHost);
  return names.sort().map((h) => [h, st.hostsInfo[h]?.apps?.[a.id]]);
}

function card(a: StoreApp): HTMLElement {
  const admin = !!st.acct?.admin;
  const want = a.want;
  const mine = st.hostsInfo[st.selfHost]?.apps?.[a.id];
  const here = !!mine?.version && (!want || mine.version === want.version);
  const rows = hostRows(a);
  const on = rows.filter(([, s]) => want && s?.version === want.version).length;
  const card = el('section', `store-card${want ? ' on' : ''}`);
  // the head: its icon once a host serves it, its name and where it comes from
  const head = el('div', 'store-head');
  const tile = el('span', 'store-tile');
  if (here) {
    const img = Object.assign(el('img', 'store-icon'), { src: a.icon, alt: '', draggable: false });
    img.addEventListener('error', () => img.replaceWith(el('span', 'store-mono', a.name[0]!.toUpperCase())));
    tile.append(img);
  } else tile.append(el('span', 'store-mono', a.name[0]!.toUpperCase()));
  const title = el('div', 'store-title');
  const repo = Object.assign(el('a', 'store-repo', a.repo.replace(/^https?:\/\//, '')), { href: a.repo, target: '_blank', rel: 'noopener' });
  title.append(el('b', '', a.name), repo);
  head.append(tile, title);
  // the state, in words, and the buttons
  const state = el('div', 'store-state');
  const line = (cls: string, text: string) => state.append(el('span', `store-line ${cls}`, text));
  if (!want) line('off', a.latest ? `v${a.latest} available` : a.feedError ? `release feed unreachable: ${a.feedError}` : 'checking the release feed');
  else {
    line('on', `v${want.version} on ${on} of ${rows.length} host${rows.length === 1 ? '' : 's'}`);
    if (a.latest && newerVersion(a.latest, want.version)) line('new', `v${a.latest} is out`);
    else if (a.feedError && !a.latest) line('dim', `release feed unreachable: ${a.feedError}`);
  }
  if (a.signed) line('dim', 'signature checked against [apps] key');
  if (a.id === 'sulfur' && editorPref() === 'sulfur') line('dim', 'the default editor');
  const acts = el('div', 'store-actions');
  const btn = (label: string, cls: string, go: () => void, disabled = false) => {
    const b = Object.assign(el('button', cls, label), { type: 'button', disabled: disabled || busyId === a.id });
    b.addEventListener('click', go);
    acts.append(b);
    return b;
  };
  if (here) btn('open', 'primary', () => dkWebApp(a.id));
  if (admin) {
    if (!want) btn(busyId === a.id ? 'installing' : 'install', here ? '' : 'primary', () => act('/api/apps/install', a.id), !a.latest);
    else if (a.latest && newerVersion(a.latest, want.version)) btn(busyId === a.id ? 'updating' : `update to v${a.latest}`, 'primary', () => act('/api/apps/install', a.id));
    if (want) btn('remove', 'danger', async () => {
      if (await pageAsk({ title: `remove ${a.name}`, message: `${a.name} v${want.version} is dropped from every host.`, action: 'remove', danger: true })) act('/api/apps/remove', a.id);
    });
  }
  card.append(head, el('p', 'store-about', a.about), state, acts);
  // each host's copy while something is picked, or any host still holding one
  if (want || rows.some(([, s]) => s)) {
    const list = el('ul', 'store-hosts');
    for (const [h, s] of rows) {
      const li = el('li', 'store-host');
      const cls = !s ? (want ? 'wait' : 'off') : s.error ? 'fail' : s.busy ? 'mid' : want && s.version === want.version ? 'ok' : s.version ? 'old' : 'wait';
      li.className += ` ${cls}`;
      const text = !s ? (want ? 'waiting' : '') : s.error ? s.error : s.busy ? 'installing' : s.version ? `v${s.version}` : 'removing';
      li.append(el('i', 'store-dot'), el('span', `store-host-name${h === st.selfHost ? ' is-self' : ''}`, h), el('span', 'store-host-state', text));
      if (s?.error) li.title = s.error;
      list.append(li);
    }
    card.append(list);
  }
  return card;
}

// the editor files open in: the desktop's own, or sulfur, installed onto the mesh by picking
// it when no host has it yet; the choice kept with the user's settings on every host
function editorRow(): HTMLElement {
  const row = el('div', 'store-editor');
  row.append(el('span', 'store-editor-k', 'default editor'));
  const seg = el('div', 'store-seg');
  const now = editorPref();
  const sulfur = apps?.find((a) => a.id === 'sulfur');
  for (const [id, label] of EDITORS) {
    const b = Object.assign(el('button', `store-seg-btn${now === id ? ' on' : ''}`, label), { type: 'button', ariaPressed: String(now === id) });
    b.addEventListener('click', () => {
      if (editorPref() === id) return;
      setEditorPref(id);
      actError = '';
      // sulfur picked before any host has it: installed for the mesh, as its own button would
      if (id === 'sulfur' && sulfur && !sulfur.want) {
        if (st.acct?.admin) { act('/api/apps/install', 'sulfur'); return; }
        actError = 'sulfur isn’t installed yet: an admin installs it here; the built-in editor until then';
      }
      sig = '';
      draw();
    });
    seg.append(b);
  }
  row.append(seg);
  const mine = st.hostsInfo[st.selfHost]?.apps?.sulfur?.version;
  row.append(el('span', 'store-editor-note', now === 'sulfur'
    ? (mine ? 'files open in sulfur, in its window' : sulfur?.want ? 'files open in sulfur once this host has it' : 'files open in sulfur once it’s installed')
    : 'files open in the desktop’s own editor'));
  return row;
}

function draw() {
  if (!watching) return;
  const next = JSON.stringify([apps, readError, actError, busyId, st.selfHost, st.acct?.admin, st.hostsInfo, editorPref(), (st.lastState?.tailnet || []).map((d) => [d.name, d.phosphorus])]);
  if (next === sig) return;
  sig = next;
  const wrap = el('div', 'store');
  const head = el('div', 'store-top');
  head.append(el('p', 'dk-note', 'Optional apps for the mesh. An install fetches the newest release and every host serves its own copy, beside this desktop.'));
  const refresh = Object.assign(el('button', 'store-refresh', 'check for releases'), { type: 'button', title: 'ask each release feed again' });
  refresh.addEventListener('click', () => read(true));
  head.append(refresh);
  wrap.append(head, editorRow());
  if (!apps) wrap.append(el('div', 'store-empty', readError ? `can't read the catalogue: ${readError}` : 'connecting'));
  else if (!apps.length) wrap.append(el('div', 'store-empty', 'nothing in the catalogue yet'));
  else {
    const cards = el('div', 'store-cards');
    cards.append(...apps.map(card));
    wrap.append(cards);
  }
  if (actError) wrap.append(el('div', 'store-err', actError));
  view.replaceChildren(wrap);
}

export { storeState, storeWatch };
