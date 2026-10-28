import { wsBase } from '../lib/api.ts';
import { el, noFill } from '../lib/dom.ts';
import { renderMd } from '../lib/md.ts';
import { deskApps, dk, st } from '../lib/state.ts';
import type { CodeHarness, CodeHarnesses, CodeLs, CodeModel, CodeOptions, CodeSession, CodeWsMessage } from '@phosphorus/wire';
import { esc } from '../lib/util.ts';
import { dkTerminal } from '../desktop/desk.ts';
import { dkCode } from '../desktop/deskfiles.ts';

// --- code: claude code sessions on any mesh host, as the desktop app's code tab
// draws them: the sessions down the side, one's transcript streamed over a
// socket, a composer under it; every action a REST call

const view = document.getElementById('view-code')!;

const PERMS: [string, string][] = [
  ['default', 'ask first'],
  ['acceptEdits', 'accept edits'],
  ['plan', 'plan only'],
  ['bypassPermissions', 'bypass all'],
];
const PICK_LS = 'phosphorus-code-pick';
const DIR_LS = 'phosphorus-code-dirs';
const RECENT_LS = 'phosphorus-code-recent';
const SIDE_LS = 'phosphorus-code-side';
const LIST_MS = 4000;
// an upload's bytes at most, as the server takes
const UP_MAX = 50 * 1024 * 1024;
const ANTH = ['opus', 'sonnet', 'haiku'];
const provOf = (id: string | undefined) => (ANTH.includes(id!) ? 'anthropic' : 'mesh');
// a tool's output kept to this on screen, the rest counted
const OUT_MAX = 16000;

// a tool call's card in the transcript
interface Card { el: HTMLElement; body: HTMLElement; out: HTMLElement; sub: HTMLElement; name: string; input: Record<string, any> }
// a block still streaming
interface Live { kind: string; el: HTMLElement; index: number; text: string; timer?: ReturnType<typeof setTimeout> | 0 }
interface Todo { status: string; content: string; activeForm?: string }
// why an api call failed, in words
interface Why { text: string; auth: boolean }
// id -> transcript: its node, last seq, open cards, live blocks, its socket
interface Transcript {
  id: string;
  node: HTMLElement;
  seq: number;
  cards: Map<string, Card>;
  live: Live[];
  perms: Map<string, { el: HTMLElement; done: (allow: boolean, always: boolean, cancelled?: boolean) => void }>;
  todos: Todo[];
  sock: WebSocket | null;
  retry: number;
  lastErr: string;
  closed?: boolean;
  todoEl?: HTMLElement;
  todoFold?: boolean;
  apiWhy?: Why | null;
  retryEl?: HTMLElement | null;
}

const cd = {
  list: [] as CodeSession[], opts: null as CodeOptions | null, pick: '', filter: '', armed: '', renaming: '', listSig: '',
  // id -> transcript: its node, last seq, open cards, live blocks, its socket
  logs: new Map<string, Transcript>(), tick: 0 as ReturnType<typeof setInterval> | 0, on: false, drawer: false,
  err: '', login: false,
};

const lsGet = <T>(k: string, d: T): T => { try { return JSON.parse(localStorage.getItem(k)!) ?? d; } catch { return d; } };
const lsSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const shQuote = (s: unknown) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tilde = (d: unknown) => String(d || '').replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~').replace(/^\/root(?=\/|$)/, '~');
const base = (d: unknown) => String(d || '').replace(/\/+$/, '').split('/').pop() || '/';
const parent = (d: unknown) => String(d || '').replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
const qs = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(String(v ?? ''))}`).join('&');
const bytes = (n: number | undefined) => (n! >= 1 << 30 ? `${(n! / (1 << 30)).toFixed(1)}G` : n! >= 1 << 20 ? `${(n! / (1 << 20)).toFixed(1)}M` : n! >= 1024 ? `${(n! / 1024).toFixed(1)}K` : `${n || 0}B`);
const kfmt = (n: number | undefined) => (n! >= 1e6 ? `${(n! / 1e6).toFixed(1)}m` : n! >= 1e3 ? `${(n! / 1e3).toFixed(1)}k` : String(n || 0));
const ago = (ms: number) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const live = (r: CodeSession | null | undefined) => r && (r.status === 'working' || r.status === 'starting');
const svg = (d: string) => `<svg viewBox="0 0 16 16" class="ic" aria-hidden="true"><path d="${d}"/></svg>`;
const GL: Record<string, string> = {
  term: 'M2 3h12v10H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
  folder: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  side: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  attach: 'M10.5 4.5l-4.8 4.8a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.3-4.3',
  send: 'M8 12.5V3.5M4 7.5L8 3.5l4 4',
  stop: 'M4.5 4.5h7v7h-7z',
  host: 'M2 3.5h12v7H2zM5.5 13h5M8 10.5V13',
  model: 'M8 2l1.6 4.4L14 8l-4.4 1.6L8 14l-1.6-4.4L2 8l4.4-1.6z',
  shield: 'M8 1.8l5 2v4c0 3-2.2 5.3-5 6.4-2.8-1.1-5-3.4-5-6.4v-4z',
};

async function call(url: string, method = 'GET', body?: unknown): Promise<any> {
  const init: RequestInit = { method, cache: 'no-store' };
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  const r = await fetch(url, init);
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `status ${r.status}`);
  return out;
}
const sapi = (id: string, op = '') => `/api/code/sessions/${encodeURIComponent(id)}${op ? `/${op}` : ''}`;

// --- the frame: side list, main pane ---

const root = el('div', 'cd');
const side = el('div', 'cd-side');
const grip = Object.assign(el('div', 'cd-grip'), { tabIndex: 0, role: 'separator', title: 'drag to resize, double click to reset' });
grip.setAttribute('aria-orientation', 'vertical');
const main = el('div', 'cd-main');
const scrim = el('div', 'cd-scrim');
root.append(side, grip, main, scrim);
view.replaceChildren(root);
scrim.addEventListener('click', () => drawer(false));

// the side's width dragged on its grip, kept per browser
function sideWidth(px: number): number {
  if (!px) { root.style.removeProperty('--cd-side'); return 0; }
  const w = Math.round(Math.min(Math.max(220, root.clientWidth * 0.45), Math.max(150, px)));
  root.style.setProperty('--cd-side', `${w}px`);
  return w;
}
if (lsGet(SIDE_LS, 0)) root.style.setProperty('--cd-side', `${lsGet(SIDE_LS, 0)}px`);
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const x0 = e.clientX;
  const w0 = side.getBoundingClientRect().width;
  root.classList.add('cd-resizing');
  const move = (ev: PointerEvent) => sideWidth(w0 + ev.clientX - x0);
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    root.classList.remove('cd-resizing');
    lsSet(SIDE_LS, Math.round(side.getBoundingClientRect().width));
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});
grip.addEventListener('keydown', (e) => {
  const d = ({ ArrowLeft: -16, ArrowRight: 16 } as Record<string, number>)[e.key];
  if (!d) return;
  e.preventDefault();
  e.stopPropagation();
  lsSet(SIDE_LS, sideWidth(side.getBoundingClientRect().width + d));
});
grip.addEventListener('dblclick', () => { sideWidth(0); lsSet(SIDE_LS, 0); });

const sideTop = el('div', 'cd-side-top');
const newBtn = Object.assign(el('button', 'cd-new', '+ new session'), { type: 'button', title: 'new session' });
// a plain text box: a search or password-looking field gets a saved login filled in
const find = noFill(Object.assign(el('input', 'cd-find'), { placeholder: 'filter sessions', spellcheck: false }));
sideTop.append(newBtn, find);
const listEl = Object.assign(el('nav', 'cd-list'), { ariaLabel: 'sessions' });
// the Claude account at the side's foot: its state, the token box opened over it
const acct = el('div', 'cd-acct');
const acctBox = el('div', 'cd-acct-box');
acctBox.hidden = true;
const acctBtn = Object.assign(el('button', 'cd-acct-btn'), { type: 'button', title: 'your Claude subscription, for Opus, Sonnet and Haiku' });
acctBtn.setAttribute('aria-expanded', 'false');
acct.append(acctBox, acctBtn);
side.append(sideTop, listEl, acct);
acctBtn.addEventListener('click', () => acctOpen(acctBox.hidden as boolean));
newBtn.addEventListener('click', () => go('new'));
find.addEventListener('input', () => { cd.filter = find.value.trim().toLowerCase(); cd.listSig = ''; paintList(); });
find.addEventListener('keydown', (e) => e.stopPropagation());

function drawer(on: boolean) {
  cd.drawer = on;
  root.classList.toggle('cd-drawer', on);
}

// --- the list ---

async function loadList() {
  try {
    const r = await call('/api/code/sessions');
    cd.list = r.sessions || [];
    cd.err = '';
  } catch (e) { cd.err = (e as Error).message; }
  if (!cd.pick) cd.pick = cd.list.some((s) => s.id === lsGet(PICK_LS, '')) ? lsGet(PICK_LS, '') : cd.list[0]?.id || 'new';
  if (cd.pick !== 'new' && !cd.list.some((s) => s.id === cd.pick) && !cd.err) { go(cd.list[0]?.id || 'new'); return; }
  paintList();
  if (cd.pick === 'new' && !main.querySelector('.cd-newform')) paintNew();
  else if (cd.pick !== 'new') paintHead();
}

async function loadOpts(fresh?: boolean): Promise<CodeOptions> {
  if (cd.opts && !fresh) return cd.opts;
  try { cd.opts = await call('/api/code/options'); } catch (e) { cd.opts = { hosts: [], models: [], anthropic: false, error: (e as Error).message }; }
  return cd.opts!;
}

const rec = (id = cd.pick) => cd.list.find((s) => s.id === id) || null;

function paintList() {
  const sig = JSON.stringify([cd.list, cd.pick, cd.filter, cd.armed, cd.renaming, cd.err, Math.floor(Date.now() / 60000)]);
  if (sig === cd.listSig) return;
  cd.listSig = sig;
  const f = cd.filter;
  const shown = cd.list.filter((s) => !f || [s.title, s.host, s.dir, s.model].some((x) => String(x || '').toLowerCase().includes(f)));
  const rows: HTMLElement[] = [];
  if (cd.err) rows.push(el('div', 'cw-empty cd-bad', `failed: ${cd.err}`));
  else if (!cd.list.length) rows.push(el('div', 'cw-empty', 'no sessions yet'));
  else if (!shown.length) rows.push(el('div', 'cw-empty', 'nothing matches'));
  for (const s of shown) {
    const row = el('div', `cd-item${s.id === cd.pick ? ' on' : ''}`);
    row.dataset.id = s.id;
    if (cd.renaming === s.id) {
      const inp = Object.assign(el('input', 'cd-rename'), { value: s.title || '', maxLength: 120, spellcheck: false });
      const done = (save: boolean) => {
        if (cd.renaming !== s.id) return;
        cd.renaming = '';
        const t = inp.value.trim();
        if (save && t && t !== s.title) {
          s.title = t;
          call(sapi(s.id, 'rename'), 'POST', { title: t }).then(loadList, (e) => say(e.message));
        }
        cd.listSig = '';
        paintList();
        paintHead();
      };
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      });
      inp.addEventListener('blur', () => done(true));
      row.append(inp);
      rows.push(row);
      setTimeout(() => { inp.focus(); inp.select(); });
      continue;
    }
    const b = Object.assign(el('button', 'cd-pick'), { type: 'button', title: `${s.title}\n${s.host}:${s.dir}` });
    const top = el('span', 'cd-item-top');
    top.append(el('span', `cd-dot cd-st-${s.status}`), el('span', 'cw-name', s.title || 'untitled'), el('span', 'cw-sub', ago(s.updated || s.created)));
    const sub = el('span', 'cd-item-sub');
    sub.append(el('span', 'cd-host', s.host), ` ${tilde(s.dir)} · `, el('span', 'cd-model', s.model));
    b.append(top, sub);
    b.addEventListener('click', () => { go(s.id); drawer(false); });
    const acts = el('span', 'cd-item-acts');
    const ren = Object.assign(el('button', 'cd-mini', 'rename'), { type: 'button' });
    ren.addEventListener('click', () => { cd.renaming = s.id; cd.listSig = ''; paintList(); });
    const del = Object.assign(el('button', `cd-mini danger${cd.armed === `del:${s.id}` ? ' armed' : ''}`, cd.armed === `del:${s.id}` ? 'delete?' : 'delete'), { type: 'button' });
    del.title = 'ends it and forgets its transcript; its files stay';
    del.addEventListener('click', () => remove(s));
    acts.append(ren, del);
    row.append(b, acts);
    rows.push(row);
  }
  const focused = (document.activeElement?.closest?.('.cd-item') as HTMLElement | null)?.dataset.id;
  listEl.replaceChildren(...rows);
  if (focused && !cd.renaming) (listEl.querySelector(`.cd-item[data-id="${CSS.escape(focused)}"] .cd-pick`) as HTMLElement | null)?.focus();
}

// twice to confirm, the first press arming it a few seconds
function arm(what: string): boolean {
  if (cd.armed === what) { cd.armed = ''; return true; }
  cd.armed = what;
  cd.listSig = '';
  paintList();
  setTimeout(() => { if (cd.armed === what) { cd.armed = ''; cd.listSig = ''; paintList(); } }, 4000);
  return false;
}

function remove(s: CodeSession) {
  if (!arm(`del:${s.id}`)) return;
  call(sapi(s.id), 'DELETE').then(() => {
    const t = cd.logs.get(s.id);
    if (t) { t.closed = true; t.sock?.close(); cd.logs.delete(s.id); }
    cd.list = cd.list.filter((x) => x.id !== s.id);
    if (cd.pick === s.id) { cd.pick = ''; go(cd.list[0]?.id || 'new'); } else loadList();
  }, (e) => say(e.message));
}

function go(id: string) {
  if (id === cd.pick && main.childElementCount) return;
  const was = cd.logs.get(cd.pick);
  if (was) { was.closed = true; was.sock?.close(); was.sock = null; }
  cd.pick = id;
  if (id !== 'new') lsSet(PICK_LS, id);
  cd.listSig = '';
  paintList();
  if (id === 'new') paintNew(); else paintOne();
}

// --- one session: header, transcript, todos, composer ---

let head: HTMLElement | null = null;
let headSig = '';
let composer: { node: HTMLElement; text: HTMLTextAreaElement; state: (r: CodeSession | null) => void } | null = null;

function paintOne() {
  const id = cd.pick;
  let t = cd.logs.get(id);
  if (!t) {
    t = { id, node: el('div', 'cd-log'), seq: 0, cards: new Map(), live: [], perms: new Map(), todos: [], sock: null, retry: 0, lastErr: '' };
    t.node.append(el('div', 'st-wait cd-wait', 'loading'));
    cd.logs.set(id, t);
  }
  t.closed = false;
  head = el('div', 'cd-head');
  headSig = '';
  const todo = el('div', 'cd-todos');
  composer = makeComposer(t);
  main.replaceChildren(head, t.node, todo, composer.node);
  t.todoEl = todo;
  paintTodos(t);
  paintHead();
  connect(t);
  requestAnimationFrame(() => { t!.node.scrollTop = t!.node.scrollHeight; });
  if (!view.closest('[hidden]')) composer.text.focus({ preventScroll: true });
}

function sideBtn(): HTMLButtonElement {
  const b = Object.assign(el('button', 'cd-icon cd-side-btn'), { type: 'button', title: 'sessions', ariaLabel: 'sessions' });
  b.innerHTML = svg(GL.side!);
  b.addEventListener('click', () => drawer(!cd.drawer));
  return b;
}

// the share holding a host's absolute folder, its path inside it
function shareOf(host: string, dir: string) {
  const shares = st.hostsInfo[String(host).toLowerCase()]?.files?.shares || [];
  const clean = (p: unknown) => String(p || '').replace(/\/+$/, '');
  const d = clean(dir);
  const sh = shares.filter((x) => x.label && (d === clean(x.label) || d.startsWith(`${clean(x.label)}/`)))
    .sort((a, b) => clean(b.label).length - clean(a.label).length)[0];
  if (!sh) return null;
  return { loc: { host, share: sh.id, root: sh.label, perms: sh.perms || '' }, rel: d.slice(clean(sh.label).length + 1) };
}

function paintHead() {
  const r = rec();
  if (!head || !r || cd.pick === 'new') return;
  const opts = cd.opts;
  const sig = JSON.stringify([r, opts, cd.renaming, !!dk.creds?.has(r.host)]);
  if (sig === headSig) return;
  headSig = sig;
  const top = el('div', 'cd-head-top');
  const title = el('span', 'cd-title', r.title || 'untitled');
  title.title = 'double click to rename';
  title.addEventListener('dblclick', () => { cd.renaming = r.id; cd.listSig = ''; paintList(); });
  const state = el('span', `cd-state cd-st-${r.status}`, r.status === 'working' ? 'working' : r.status);
  const tools = el('span', 'cd-head-tools');
  const term = Object.assign(el('button', 'cd-icon'), { type: 'button', ariaLabel: 'terminal here' });
  term.innerHTML = svg(GL.term!);
  const can = dk.creds?.has(r.host);
  term.disabled = !can;
  term.title = can ? `terminal on ${r.host} in ${r.dir}` : `log into ${r.host} on the desktop for a terminal`;
  term.addEventListener('click', () => dkTerminal(r.host, `cd ${shQuote(r.dir)}`));
  const folder = Object.assign(el('button', 'cd-icon'), { type: 'button', ariaLabel: 'open folder' });
  folder.innerHTML = svg(GL.folder!);
  folder.title = `browse ${r.host}:${r.dir}`;
  folder.addEventListener('click', () => openBrowser(r.host, r.dir));
  tools.append(term, folder);
  top.append(sideBtn(), title, state, tools);

  const bar = el('div', 'cd-head-bar');
  const where = el('span', 'cd-where');
  where.append(el('span', 'cd-host', r.host), el('span', 'st-dim', ':'), tilde(r.dir));
  where.title = `${r.host}:${r.dir}`;
  const hx = (opts?.harnesses || []).find((h) => h.id === (r.harness || 'claude'));
  if (hx) where.prepend(el('span', 'cd-harness', hx.label.toLowerCase()));
  const model = modelSelect(opts, r.model, true);
  model.addEventListener('change', () => {
    const v = model.value;
    call(sapi(r.id, 'model'), 'POST', { model: v }).then(() => { r.model = v; loadList(); }, (e) => { say(e.message); model.value = r.model; });
  });
  const perm = el('select', 'cd-sel');
  perm.innerHTML = PERMS.map(([v, l]) => `<option value="${v}"${v === r.perm ? ' selected' : ''}>${esc(l)}</option>`).join('');
  perm.title = 'permission mode';
  perm.addEventListener('change', () => {
    const v = perm.value;
    call(sapi(r.id, 'perm'), 'POST', { mode: v }).then(() => { r.perm = v; loadList(); }, (e) => { say(e.message); perm.value = r.perm; });
  });
  const u = r.usage || {};
  const use = el('span', 'cd-use', u.in || u.out ? `↑${kfmt(u.in)} ↓${kfmt(u.out)}${u.costUSD ? ` · $${u.costUSD.toFixed(u.costUSD < 1 ? 3 : 2)}` : ''}` : '');
  bar.append(where, model, perm, use);
  head.replaceChildren(top, bar);
  composer?.state(r);
}

// the models by provider; lock, a running session's, the other provider's
// shown but off: a switch across is a new session's
function modelSelect(opts: CodeOptions | null, cur: string, lock?: boolean): HTMLSelectElement {
  const s = el('select', 'cd-sel');
  const CROSS = 'start a new session to change provider';
  s.title = lock ? `model; ${CROSS}` : 'model';
  const models = (opts?.models || []).filter((m) => m.provider !== 'anthropic' || opts!.anthropic);
  const mesh = models.filter((m) => m.provider !== 'anthropic');
  const anth = models.filter((m) => m.provider === 'anthropic');
  const off = (m: CodeModel) => lock && provOf(m.id) !== provOf(cur);
  const opt = (m: CodeModel) => `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}${(m.ready === false && m.id !== cur) || off(m) ? ' disabled' : ''}`
    + `${off(m) ? ` title="${CROSS}"` : ''}>${esc(m.label || m.id)}${m.ready === false ? ` · ${esc(m.why || 'not ready')}` : ''}</option>`;
  const group = (label: string, ms: CodeModel[]) => `<optgroup label="${label}"${ms.length && ms.every(off) ? ` title="${CROSS}"` : ''}>${ms.map(opt).join('')}</optgroup>`;
  let html = '';
  if (mesh.length) html += group('mesh', mesh);
  if (anth.length) html += group('anthropic', anth);
  if (cur && !models.some((m) => m.id === cur)) html += `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  s.innerHTML = html || '<option value="">no models</option>';
  return s;
}

// a line in the composer's corner
function say(text: string) {
  const m = main.querySelector('.cd-msg') as (HTMLElement & { t?: ReturnType<typeof setTimeout> }) | null;
  if (m) { m.textContent = text; clearTimeout(m.t); m.t = setTimeout(() => { m.textContent = ''; }, 6000); }
}

// --- the socket: everything after the last seq seen, then live ---

function connect(t: Transcript) {
  if (t.sock || t.closed || !cd.on) return;
  const ws = new WebSocket(`${wsBase()}/api/code/ws/${encodeURIComponent(t.id)}?since=${t.seq}`);
  t.sock = ws;
  ws.onopen = () => { t.retry = 0; };
  ws.onmessage = (e) => {
    let m: CodeWsMessage | null = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m!.seq && m!.seq <= t.seq) return;
    t.node.querySelector(':scope > .cd-wait')?.remove();
    const stick = t.node.scrollHeight - t.node.scrollTop - t.node.clientHeight < 40;
    take(t, m!);
    if (m!.seq) t.seq = m!.seq;
    if (stick) t.node.scrollTop = t.node.scrollHeight;
  };
  ws.onclose = () => {
    if (t.sock !== ws) return;
    t.sock = null;
    t.node.querySelector(':scope > .cd-wait')?.replaceWith(el('div', 'st-wait cd-wait', 'no transcript yet'));
    if (t.closed || !cd.on) return;
    t.retry = Math.min(10000, (t.retry || 500) * 2);
    setTimeout(() => { if (cd.pick === t.id && cd.on) connect(t); }, t.retry);
  };
}

function take(t: Transcript, m: CodeWsMessage) {
  // a line too big for the log, kept only as its kind
  if (m.truncated) { addNote(t, m.ev?.type || m.kind || 'event', 'too large to keep in the transcript').classList.add('cd-quiet'); return; }
  switch (m.kind) {
    case 'claude': claudeEv(t, m.ev || {}); break;
    case 'user': {
      flushLive(t);
      const u = el('div', 'cd-user');
      u.append(el('span', 'cd-prompt', '>'), el('span', 'cd-user-text', m.text || ''));
      t.node.append(u);
      break;
    }
    case 'permission': permCard(t, m); break;
    case 'permission_done': {
      const c = t.perms.get(m.reqId!);
      if (c) c.done(m.allow!, false, m.cancelled);
      break;
    }
    case 'status': {
      const r = m.record;
      if (!r) break;
      const i = cd.list.findIndex((s) => s.id === r.id);
      if (i >= 0) cd.list[i] = r; else cd.list.unshift(r);
      paintList();
      if (r.id === cd.pick) paintHead();
      if (!live(r)) flushLive(t);
      break;
    }
    case 'error': flushLive(t); addNote(t, 'error', m.text || 'error'); break;
    default: break;
  }
}

function addNote(t: Transcript, kind: string, text: string): HTMLElement {
  const n = el('div', `cd-note cd-note-${kind}`);
  n.append(el('span', 'cd-note-tag', kind), el('span', 'cd-note-text', text));
  t.node.append(n);
  return n;
}

// --- claude's stream-json, one event at a time ---

function claudeEv(t: Transcript, ev: Record<string, any>) {
  const where = ev.parent_tool_use_id ? t.cards.get(ev.parent_tool_use_id)?.sub || t.node : t.node;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        const bits = [ev.model, ev.permissionMode, ev.cwd && tilde(ev.cwd)].filter(Boolean);
        addNote(t, 'session', bits.join(' · ') || 'started').classList.add('cd-quiet');
      } else if (ev.subtype === 'api_retry') retryNote(t, ev);
      else if (ev.subtype && ev.subtype !== 'status') addNote(t, ev.subtype.replace(/_/g, ' '), ev.message || ev.content || '').classList.add('cd-quiet');
      break;
    case 'stream_event': if (!ev.parent_tool_use_id) streamEv(t, ev.event || {}); break;
    case 'assistant': {
      const content = ev.message?.content || [];
      for (const b of content) {
        if (b.type === 'text') { if (b.text?.trim()) place(t, 'text', textBlock(b.text), where); }
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') place(t, 'thinking', thinkBlock(b.thinking || '(redacted)'), where);
        else if (b.type === 'tool_use') place(t, 'tool', toolCard(t, b), where);
      }
      if (ev.error) addNote(t, 'error', String(ev.error));
      break;
    }
    case 'user': {
      const content = ev.message?.content;
      if (!Array.isArray(content)) break;
      for (const b of content) if (b.type === 'tool_result') toolResult(t, b);
      break;
    }
    case 'result': {
      flushLive(t);
      const u = ev.usage || {};
      const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      const bad = ev.is_error || (ev.subtype && ev.subtype !== 'success');
      const bits = [bad ? (ev.subtype || 'error').replace(/_/g, ' ') : 'done'];
      if (ev.num_turns) bits.push(`${ev.num_turns} turn${ev.num_turns === 1 ? '' : 's'}`);
      if (ev.duration_ms) bits.push(`${(ev.duration_ms / 1000).toFixed(1)}s`);
      if (tin || u.output_tokens) bits.push(`↑${kfmt(tin)} ↓${kfmt(u.output_tokens)}`);
      const billed = Object.keys(ev.modelUsage || {}).some((k) => ANTH.includes(k) || k.startsWith('claude-'));
      if (ev.total_cost_usd && billed) bits.push(`$${ev.total_cost_usd.toFixed(4)}`);
      const f = el('div', `cd-foot${bad ? ' bad' : ''}`);
      f.append(el('span', '', bits.join(' · ')));
      t.node.append(f);
      if (bad && ev.result && typeof ev.result === 'string') addNote(t, 'error', ev.result);
      if (bad && Array.isArray(ev.errors)) {
        for (const e of ev.errors) {
          // claude's own diagnostic when no answer ever came: the last retry's reason in its place
          if (/^\[ede_diagnostic\]/.test(String(e))) noAnswer(t, String(e));
          else addNote(t, 'error', String(e));
        }
      }
      t.apiWhy = null;
      t.retryEl = null;
      break;
    }
    default: break;
  }
}

// why an api call failed, by its status, in words that say where to look
function apiWhy(t: Transcript, status: number | undefined, kind: string | undefined): Why {
  const anth = provOf(rec(t.id)?.model) === 'anthropic';
  const who = anth ? 'Anthropic' : "the mesh's model gateway";
  if (!status) return { text: `couldn't reach ${who}${anth ? '' : ` from ${rec(t.id)?.host || 'the host'}`}`, auth: false };
  if (status === 401 || status === 403 || kind === 'authentication_failed') {
    return { text: anth ? 'Anthropic refused the token: sign in to Claude again' : 'the model gateway refused your phosphorus key', auth: anth };
  }
  if (status === 429) return { text: `${who} is rate limiting (429)`, auth: false };
  if (status === 529 || status === 503) return { text: anth ? 'Anthropic is overloaded (529)' : `the model isn't loaded or is busy (${status}): check models in status`, auth: false };
  if (status === 404) return { text: `${who} has no such model (404)`, auth: false };
  return { text: `${who} failed (${status}${kind && kind !== 'unknown' ? ` ${kind.replace(/_/g, ' ')}` : ''})`, auth: false };
}

// claude retrying a failed call: one line, kept current while nothing else lands
function retryNote(t: Transcript, ev: Record<string, any>) {
  const why = apiWhy(t, ev.error_status, ev.error);
  t.apiWhy = why;
  const text = `${why.text} · try ${ev.attempt || '?'} of ${ev.max_retries || '?'}`;
  if (t.retryEl && t.node.lastElementChild === t.retryEl) t.retryEl.querySelector('.cd-note-text')!.textContent = text;
  else { t.retryEl = addNote(t, 'retrying', text); t.retryEl.classList.add('cd-note-warn'); }
}

function noAnswer(t: Transcript, raw: string) {
  const why = t.apiWhy;
  const n = addNote(t, 'error', `no answer from the model${why ? `: ${why.text}` : ''}`);
  n.title = raw;
  if (why?.auth) {
    const b = Object.assign(el('button', 'cd-mini primary', 'sign in to Claude'), { type: 'button' });
    b.addEventListener('click', () => { cd.login = true; if (cd.pick === 'new') paintNew(); else go('new'); });
    n.append(b);
  }
}

// a final block in place of its streamed draft, else at the end
function place(t: Transcript, kind: string, node: HTMLElement, where: HTMLElement) {
  const i = where === t.node ? t.live.findIndex((x) => x.kind === kind) : -1;
  if (i >= 0) {
    const [x] = t.live.splice(i, 1);
    x!.el.replaceWith(node);
  } else where.append(node);
}

function flushLive(t: Transcript) {
  for (const x of t.live) x.el.remove();
  t.live = [];
}

function streamEv(t: Transcript, e: Record<string, any>) {
  if (e.type === 'content_block_start') {
    const kind = ({ text: 'text', thinking: 'thinking', tool_use: 'tool', server_tool_use: 'tool' } as Record<string, string>)[e.content_block?.type];
    if (!kind) return;
    let node: HTMLElement;
    if (kind === 'text') node = el('div', 'cd-text cd-streaming');
    else if (kind === 'thinking') node = thinkBlock('');
    else {
      node = el('div', 'cd-tool run cd-streaming');
      const h = el('div', 'cd-tool-head');
      h.append(el('span', 'cd-pip'), el('span', 'cd-tool-name', e.content_block.name || 'tool'), el('span', 'cd-tool-arg', '…'));
      node.append(h);
    }
    const x: Live = { kind, el: node, index: e.index, text: '' };
    t.live.push(x);
    t.node.append(node);
  } else if (e.type === 'content_block_delta') {
    const x = t.live.findLast((y) => y.index === e.index);
    if (!x) return;
    const d = e.delta || {};
    if (d.type === 'text_delta') {
      x.text += d.text || '';
      if (!x.timer) {
        x.timer = setTimeout(() => {
          x.timer = 0;
          if (!x.el.isConnected) return;
          const stick = t.node.scrollHeight - t.node.scrollTop - t.node.clientHeight < 40;
          // plain while it streams, the server's markdown only for the final block
          x.el.textContent = x.text;
          if (stick) t.node.scrollTop = t.node.scrollHeight;
        }, 120);
      }
    } else if (d.type === 'thinking_delta') {
      x.text += d.thinking || '';
      x.el.querySelector('.cd-think-body')!.textContent = x.text;
      x.el.querySelector('.cd-think-sum')!.textContent = 'thinking…';
    }
  } else if (e.type === 'message_stop') {
    // drafts never confirmed by a final block (none arrive for an interrupted turn) left till the turn ends
  }
}

function textBlock(text: string): HTMLElement {
  const d = el('div', 'cd-text md');
  renderMd(d, text);
  return d;
}

function thinkBlock(text: string): HTMLElement {
  const d = el('details', 'cd-think');
  const s = el('summary', 'cd-think-sum', text ? `thought · ${kfmt(text.length)} chars` : 'thinking…');
  d.append(s, el('div', 'cd-think-body', text));
  return d;
}

// --- tool calls: a line like a coding agent's log, its outcome under it, the detail folded ---

const COMPACT = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'BashOutput', 'KillShell', 'KillBash']);

function toolArg(name: string, x: Record<string, any> = {}): string {
  switch (name) {
    case 'Bash': return x.description || x.command || '';
    case 'Read': return `${x.file_path || ''}${x.offset ? ` :${x.offset}${x.limit ? `-${x.offset + x.limit}` : ''}` : ''}`;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return x.file_path || x.notebook_path || '';
    case 'Glob': return `${x.pattern || ''}${x.path ? ` in ${x.path}` : ''}`;
    case 'Grep': return `${x.pattern || ''}${x.path ? ` in ${x.path}` : ''}${x.glob ? ` (${x.glob})` : ''}`;
    case 'WebFetch': return x.url || '';
    case 'WebSearch': return x.query || '';
    case 'Task': case 'Agent': return x.description || x.subagent_type || '';
    case 'TodoWrite': return `${(x.todos || []).filter((y: Todo) => y.status === 'completed').length}/${(x.todos || []).length} done`;
    default: {
      const v = Object.values(x).find((y) => typeof y === 'string') as string | undefined;
      return v ? v.slice(0, 120) : '';
    }
  }
}

// mcp__phosphorus__files_list as phosphorus · files_list
const toolName = (n: string) => (n.startsWith('mcp__') ? n.slice(5).replace('__', ' · ') : n);

function toolCard(t: Transcript, b: Record<string, any>): HTMLElement {
  const name: string = b.name || 'tool';
  const x = b.input || {};
  const c = el('div', `cd-tool run cd-tool-${name.replace(/[^\w-]/g, '_')}`);
  const h = Object.assign(el('button', 'cd-tool-head'), { type: 'button' });
  h.append(el('span', 'cd-pip'), el('span', 'cd-tool-name', toolName(name)));
  const arg = toolArg(name, x);
  if (arg) h.append(el('span', 'cd-tool-arg', arg));
  const stat = editStat(name, x);
  if (stat) h.append(stat);
  const out = el('div', 'cd-tool-out', 'running');
  const body = el('div', 'cd-tool-body');
  const sub = el('div', 'cd-tool-sub');
  // edits shown open as the desktop app does, the rest folded
  const open = ['Edit', 'MultiEdit', 'Write'].includes(name);
  body.hidden = !open;
  c.classList.toggle('open', open);
  h.addEventListener('click', () => { body.hidden = !body.hidden; c.classList.toggle('open', !body.hidden); });
  body.append(...toolInput(name, x));
  c.append(h, out, body, sub);
  if (name === 'Task' || name === 'Agent') sub.hidden = false; else sub.hidden = true;
  t.cards.set(b.id, { el: c, body, out, sub, name, input: x });
  if (name === 'TodoWrite') { t.todos = x.todos || []; paintTodos(t); }
  return c;
}

function editStat(name: string, x: Record<string, any>): HTMLElement | null {
  let add = 0;
  let del = 0;
  if (name === 'Write') add = lines(x.content).length;
  else if (name === 'Edit') ({ add, del } = countDiff(x.old_string, x.new_string));
  else if (name === 'MultiEdit') for (const e of x.edits || []) { const n = countDiff(e.old_string, e.new_string); add += n.add; del += n.del; }
  else return null;
  const s = el('span', 'cd-tool-stat');
  s.append(el('span', 'cd-add', `+${add}`), ' ', el('span', 'cd-del', `−${del}`));
  return s;
}

function toolInput(name: string, x: Record<string, any>): HTMLElement[] {
  switch (name) {
    case 'Bash': {
      const p = el('pre', 'cd-cmd');
      p.append(el('span', 'cd-prompt', '$ '), x.command || '');
      return [p];
    }
    case 'Edit': return [diffView(x.old_string, x.new_string)];
    case 'MultiEdit': return (x.edits || []).map((e: Record<string, string>) => diffView(e.old_string, e.new_string));
    case 'Write': return [diffView('', x.content)];
    case 'TodoWrite': return [todoList(x.todos || [])];
    default:
      if (COMPACT.has(name)) return [];
      return [Object.assign(el('pre', 'cd-json'), { textContent: JSON.stringify(x, null, 2) })];
  }
}

const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : '')).join('\n') : c == null ? '' : JSON.stringify(c, null, 2));
const clip = (s: string) => (s.length > OUT_MAX ? `${s.slice(0, OUT_MAX)}\n… ${kfmt(s.length - OUT_MAX)} more chars` : s);

function toolResult(t: Transcript, b: Record<string, any>) {
  const c = t.cards.get(b.tool_use_id);
  if (!c) return;
  const text = resultText(b.content).replace(/\s+$/, '');
  const bad = !!b.is_error;
  c.el.classList.remove('run');
  c.el.classList.add(bad ? 'bad' : 'ok');
  const n = text ? text.split('\n').length : 0;
  let out;
  if (bad) out = text.split('\n')[0] || 'failed';
  else if (c.name === 'Bash') out = text ? `${text.split('\n')[0]!.slice(0, 160)}${n > 1 ? `  (+${n - 1} lines)` : ''}` : '(no output)';
  else if (c.name === 'Read') out = `${n} lines`;
  else if (c.name === 'Glob') out = /^no files/i.test(text) ? 'no files' : `${n} files`;
  else if (c.name === 'Grep') out = text.split('\n')[0]!.slice(0, 160) || 'no matches';
  else if (['Edit', 'MultiEdit', 'Write'].includes(c.name)) out = 'applied';
  else if (c.name === 'TodoWrite') out = 'todos updated';
  else out = text ? `${text.split('\n')[0]!.slice(0, 160)}${n > 1 ? `  (+${n - 1} lines)` : ''}` : 'done';
  c.out.textContent = out;
  // what came back, folded with the input, unless an edit's "updated" line
  if (text && (bad || !['Edit', 'MultiEdit', 'Write', 'TodoWrite'].includes(c.name))) {
    const p = el('pre', `cd-result${bad ? ' bad' : ''}`, clip(text));
    c.body.append(p);
  }
}

// --- diffs: old and new as lines, the shortest edit between, 3 lines of context ---

const lines = (s: unknown) => (s ? String(s).replace(/\n$/, '').split('\n') : []);

function lineDiff(a: string[], b: string[]): [string, string][] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const mid: [string, string][] = [];
  if (A.length * B.length > 600000) {
    for (const l of A) mid.push(['-', l]);
    for (const l of B) mid.push(['+', l]);
  } else {
    const n = A.length;
    const m = B.length;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(L[(i + 1) * (m + 1) + j]!, L[i * (m + 1) + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { mid.push([' ', A[i]!]); i++; j++; }
      else if (j < m && (i >= n || L[i * (m + 1) + j + 1]! >= L[(i + 1) * (m + 1) + j]!)) { mid.push(['+', B[j]!]); j++; }
      else { mid.push(['-', A[i]!]); i++; }
    }
  }
  return [...a.slice(0, p).map((l): [string, string] => [' ', l]), ...mid, ...a.slice(a.length - s).map((l): [string, string] => [' ', l])];
}

function countDiff(a: unknown, b: unknown): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const [k] of lineDiff(lines(a), lines(b))) { if (k === '+') add++; else if (k === '-') del++; }
  return { add, del };
}

function diffView(a: unknown, b: unknown): HTMLElement {
  const ops = lineDiff(lines(a), lines(b));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach(([k], i) => { if (k !== ' ') for (let j = Math.max(0, i - 3); j <= Math.min(ops.length - 1, i + 3); j++) keep[j] = true; });
  const box = el('div', 'cd-diff');
  let gap = false;
  let shown = 0;
  ops.forEach(([k, l], i) => {
    if (!keep[i]) { gap = true; return; }
    if (gap) { box.append(el('div', 'cd-dl gap', '⋯')); gap = false; }
    if (++shown > 600) return;
    const r = el('div', `cd-dl${k === '+' ? ' add' : k === '-' ? ' del' : ''}`);
    r.append(el('span', 'cd-dm', k), el('span', 'cd-dt', l || ' '));
    box.append(r);
  });
  if (shown > 600) box.append(el('div', 'cd-dl gap', `… ${shown - 600} more lines`));
  if (!ops.length) box.append(el('div', 'cd-dl gap', '(empty)'));
  return box;
}

// --- todos: TodoWrite's list pinned above the composer, a bar of how far ---

const cdBar = (frac: number, n = 20) => {
  const k = Math.max(0, Math.min(n, Math.round(frac * n)));
  return `[<span class="cd-cells">${'█'.repeat(k)}<i>${'░'.repeat(n - k)}</i></span>]`;
};

function todoList(todos: Todo[]): HTMLElement {
  const ul = el('ul', 'cd-todo-list');
  for (const x of todos) {
    const li = el('li', `cd-todo-${x.status}`);
    li.append(el('span', 'cd-box', x.status === 'completed' ? '[x]' : x.status === 'in_progress' ? '[~]' : '[ ]'), ' ',
      x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content);
    ul.append(li);
  }
  return ul;
}

function paintTodos(t: Transcript) {
  const box = t.todoEl;
  if (!box) return;
  const todos = t.todos || [];
  box.hidden = !todos.length;
  if (!todos.length) return;
  const done = todos.filter((x) => x.status === 'completed').length;
  const now = todos.find((x) => x.status === 'in_progress');
  const h = Object.assign(el('button', 'cd-todo-head'), { type: 'button' });
  h.innerHTML = `<span class="cd-todo-t">todos</span> ${cdBar(done / todos.length)} <span class="st-dim">${done}/${todos.length}</span>`
    + (now ? ` <span class="cd-todo-now">${esc(now.activeForm || now.content)}</span>` : '');
  const list = todoList(todos);
  list.hidden = !!t.todoFold;
  h.addEventListener('click', () => { t.todoFold = !t.todoFold; list.hidden = t.todoFold; });
  box.replaceChildren(h, list);
}

// --- permission requests: inline, answered once ---

function permCard(t: Transcript, m: CodeWsMessage) {
  flushLive(t);
  const c = el('div', 'cd-perm');
  const h = el('div', 'cd-perm-head');
  h.append(el('span', 'cd-perm-tag', 'permission'), el('span', 'cd-tool-name', toolName(m.tool || 'tool')));
  const arg = toolArg(m.tool!, m.input || {});
  if (arg) h.append(el('span', 'cd-tool-arg', arg));
  const body = el('div', 'cd-perm-body');
  if (m.reason) body.append(el('div', 'cd-perm-reason', m.reason));
  const shown = toolInput(m.tool!, m.input || {});
  body.append(...(shown.length ? shown : [Object.assign(el('pre', 'cd-json'), { textContent: JSON.stringify(m.input || {}, null, 2) })]));
  const why = Object.assign(el('input', 'cd-perm-why'), { type: 'text', placeholder: 'tell claude why, if denying (optional)', spellcheck: false });
  why.addEventListener('keydown', (e) => e.stopPropagation());
  const acts = el('div', 'update-actions cd-perm-acts');
  const msg = el('span', 'cd-perm-msg');
  const btn = (label: string, cls: string, allow: boolean, always: boolean) => {
    const b = Object.assign(el('button', cls, label), { type: 'button' });
    b.addEventListener('click', () => {
      for (const x of acts.querySelectorAll('button')) x.disabled = true;
      msg.textContent = 'sending';
      call(sapi(t.id, 'permission'), 'POST', { reqId: m.reqId, allow, always, message: allow ? '' : why.value.trim() })
        .then(() => done(allow, always), (e) => { msg.textContent = e.message; for (const x of acts.querySelectorAll('button')) x.disabled = false; });
    });
    return b;
  };
  acts.append(msg, btn('deny', 'danger', false, false), btn('always allow', '', true, true), btn('allow once', 'primary', true, false));
  c.append(h, body, why, acts);
  const done = (allow: boolean, always: boolean, cancelled?: boolean) => {
    if (c.classList.contains('answered')) return;
    c.classList.add('answered', allow ? 'allowed' : 'denied');
    why.remove();
    acts.replaceChildren(el('span', `cd-perm-msg ${allow ? 'good' : cancelled ? '' : 'bad'}`, allow ? (always ? 'always allowed' : 'allowed') : cancelled ? 'no longer asked' : 'denied'));
  };
  t.perms.set(m.reqId!, { el: c, done });
  t.node.append(c);
}

// --- composer ---

function makeComposer(t: Transcript) {
  const node = el('div', 'cd-compose');
  const atts = el('div', 'cd-atts');
  const form = el('form', 'chat-form cd-form');
  const text = Object.assign(el('textarea', 'cd-text-in'), { rows: 1, placeholder: 'message', title: 'enter sends, shift+enter a new line, esc stops a turn', spellcheck: false });
  const attach = Object.assign(el('button', 'chat-icon chat-attach cd-attach'), { type: 'button', ariaLabel: 'attach' });
  attach.innerHTML = svg(GL.attach!);
  const stop = Object.assign(el('button', 'cd-stop'), { type: 'button', title: 'stop this turn', ariaLabel: 'stop' });
  stop.innerHTML = `${svg(GL.stop!)}<span>stop</span>`;
  const go = Object.assign(el('button', 'chat-go'), { type: 'submit', title: 'send (enter)', ariaLabel: 'send', disabled: true });
  go.innerHTML = svg(GL.send!);
  const input = Object.assign(el('input'), { type: 'file', multiple: true, hidden: true });
  form.append(el('span', 'chat-prompt', '>'), text, attach, stop, go);
  const foot = el('div', 'cd-compose-foot');
  foot.append(el('span', 'cd-msg'));
  node.append(atts, form, foot, input);
  const grow = () => { text.style.height = 'auto'; text.style.height = `${Math.min(text.scrollHeight, 200)}px`; go.disabled = !text.value.trim(); };
  text.addEventListener('input', grow);
  text.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
    if (e.key === 'Escape' && live(rec(t.id))) { e.preventDefault(); stop.click(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = text.value.trim();
    if (!v) return;
    go.disabled = true;
    call(sapi(t.id, 'send'), 'POST', { text: v }).then(() => {
      text.value = '';
      grow();
      const r = rec(t.id);
      if (r && !live(r)) { r.status = 'working'; paintHead(); paintList(); }
    }, (err) => { say(err.message); go.disabled = false; });
  });
  stop.addEventListener('click', () => call(sapi(t.id, 'stop'), 'POST', {}).then(() => say('stopping'), (e) => say(e.message)));
  attach.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { upload(t, [...input.files!], atts, text, grow); input.value = ''; });
  form.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  form.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    upload(t, [...e.dataTransfer.files], atts, text, grow);
  });
  text.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); upload(t, files, atts, text, grow); }
  });
  const state = (r: CodeSession | null) => {
    const working = !!live(r);
    stop.hidden = !working;
    attach.disabled = !r;
    attach.title = r ? `attach files: uploaded into ${r.host}:${r.dir}` : 'attach files';
    form.classList.toggle('cd-busy', working);
  };
  state(rec(t.id));
  return { node, text, state };
}

// a file posted raw, its progress told
function sendFile(url: string, f: File, progress: (n: number) => void): Promise<Record<string, any>> {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => progress(e.loaded);
    x.onload = () => {
      let o: Record<string, any> = {};
      try { o = JSON.parse(x.responseText); } catch {}
      if (x.status >= 200 && x.status < 300) ok(o); else bad(new Error(o.error || `status ${x.status}`));
    };
    x.onerror = () => bad(new Error('upload failed'));
    x.send(f);
  });
}

// files sent into the session's folder over the user's login there, an
// existing name never overwritten (the server picks "name (1).ext"), then
// @mentioned in the prompt
async function upload(t: Transcript, files: File[], atts: HTMLElement, text: HTMLTextAreaElement, grow: () => void) {
  const r = rec(t.id);
  if (!r) return;
  for (const f of files) {
    const chip = el('span', 'cd-att');
    const st = el('span', 'cd-att-st', '0%');
    chip.append(el('span', '', f.name || 'pasted'), st);
    atts.append(chip);
    try {
      if (f.size > UP_MAX) throw new Error('50MB at most');
      const o = await sendFile(`/api/code/upload?${qs({ host: r.host, dir: r.dir, name: f.name || 'pasted' })}`, f,
        (n) => { st.textContent = `${Math.round((n / (f.size || 1)) * 100)}%`; });
      chip.remove();
      const name = base(o.path);
      const at = /\s/.test(name) ? `@"${name}"` : `@${name}`;
      text.value = `${text.value}${text.value && !/\s$/.test(text.value) ? ' ' : ''}${at} `;
      grow();
      text.focus();
    } catch (e) {
      chip.classList.add('bad');
      st.textContent = (e as Error).message;
      setTimeout(() => chip.remove(), 6000);
    }
  }
}

// --- a new session: as the desktop app starts one, a prompt box with its
// choices in a row of chips under it ---

// a select dressed as a chip, its glyph before it
function chip(glyph: string, sel: HTMLSelectElement, title: string): HTMLElement {
  const c = el('label', 'cd-chip');
  c.title = title;
  const g = el('span', 'cd-chip-ic');
  g.innerHTML = svg(GL[glyph]!);
  sel.classList.add('cd-chip-sel');
  c.append(g, sel);
  return c;
}

// the Anthropic token box: plain text masked by css, so no password manager fills it
function tokenInput(cls = ''): HTMLInputElement {
  const i = noFill(Object.assign(el('input', cls), { placeholder: 'sk-ant-oat…', spellcheck: false }), true);
  i.addEventListener('keydown', (e) => e.stopPropagation());
  return i;
}

async function saveToken(token: string): Promise<boolean> {
  const r = await call('/api/me/anthropic', 'POST', { token });
  if (cd.opts) cd.opts.anthropic = !!r.anthropic;
  paintAcct();
  return !!r.anthropic;
}

// signing in to Claude: claude setup-token run in a terminal, its token pasted back
function loginPanel(hostOf: () => string, done: () => void): HTMLElement & { focusIn: () => void } {
  const box = el('div', 'cd-login') as unknown as HTMLElement & { focusIn: () => void };
  const shut = Object.assign(el('button', 'cd-mini', 'close'), { type: 'button' });
  shut.addEventListener('click', () => { box.hidden = true; });
  const t = el('div', 'cd-login-t');
  t.append(el('span', '', 'Sign in to Claude'), shut);
  const how = el('ol', 'cd-login-steps');
  const s1 = el('li');
  s1.innerHTML = 'Run <code>claude setup-token</code> in a terminal and finish signing in in the browser it opens.';
  const run = Object.assign(el('button', 'cd-mini primary'), { type: 'button' });
  const paintRun = () => {
    const h = hostOf();
    const can = h && dk.creds?.has(h);
    run.textContent = can ? `run it on ${h}` : 'copy the command';
    run.title = can ? `opens a terminal on ${h} running claude setup-token` : 'log into a computer on the desktop to run it here';
  };
  run.addEventListener('click', () => {
    const h = hostOf();
    // where claude's installer puts it, a non-login shell's PATH may lack it
    if (h && dk.creds?.has(h)) dkTerminal(h, 'PATH="$HOME/.local/bin:$HOME/.claude/local:$PATH" claude setup-token');
    else navigator.clipboard?.writeText('claude setup-token').then(() => { run.textContent = 'copied'; }, () => {});
  });
  s1.append(' ', run);
  const s2 = el('li', '', 'Paste the token it prints (sk-ant-oat…) here.');
  how.append(s1, s2);
  const inp = tokenInput('update-pass cd-login-in');
  const save = Object.assign(el('button', 'primary', 'save'), { type: 'button' });
  const msg = el('span', 'cd-login-msg');
  const bar = el('div', 'cd-login-bar');
  bar.append(inp, save);
  const put = async () => {
    const v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    save.disabled = true;
    msg.textContent = 'saving';
    try {
      if (!(await saveToken(v))) throw new Error('not saved');
      inp.value = '';
      msg.textContent = '';
      box.hidden = true;
      done();
    } catch (e) { msg.textContent = (e as Error).message; }
    save.disabled = false;
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); put(); } });
  save.addEventListener('click', put);
  box.append(t, el('p', 'cd-login-p', 'Opus, Sonnet and Haiku run on your own Claude subscription.'), how, bar, msg);
  box.focusIn = () => { paintRun(); inp.focus(); };
  return box;
}

async function paintNew() {
  head = null;
  composer = null;
  const form = el('form', 'cd-newform');
  main.replaceChildren(form);
  form.append(el('div', 'st-wait', 'loading'));
  const opts = await loadOpts(true);
  if (cd.pick !== 'new' || !form.isConnected) return;
  const top = el('div', 'cd-head-top');
  top.append(sideBtn(), el('span', 'cd-title', 'new session'));
  // no login of the user's own on any computer: nowhere to run
  if (opts.blocked) {
    const box = el('div', 'cd-empty');
    const again = Object.assign(el('button', 'cd-mini primary', 'check again'), { type: 'button' });
    again.addEventListener('click', () => paintNew());
    box.append(el('div', 'cd-empty-t', opts.blocked),
      el('p', 'cd-intro', 'Code runs an agent harness on one of your computers, signed in as you over ssh, so it needs a login of yours saved for that computer.'),
      el('p', 'cd-intro', 'Open a terminal on a computer from the desktop, log in and save the login, then come back here.'),
      again);
    form.replaceChildren(top, box);
    return;
  }
  const hosts = opts.hosts || [];
  const dirs = lsGet<Record<string, string>>(DIR_LS, {});
  const lastHost = lsGet(`${DIR_LS}-host`, '');
  const host = el('select');
  host.innerHTML = hosts.map((h) => `<option value="${esc(h)}"${h === lastHost ? ' selected' : ''}>${esc(h)}</option>`).join('') || '<option value="">no hosts</option>';
  let dir = dirs[host.value] || '';
  const dirBtn = Object.assign(el('button', 'cd-chip cd-chip-dir'), { type: 'button' });
  const picker = el('div', 'cd-picker');
  picker.hidden = true;
  const paintDir = () => {
    dirBtn.innerHTML = `<span class="cd-chip-ic">${svg(GL.folder!)}</span>`;
    dirBtn.append(el('span', `cd-chip-t${dir ? '' : ' cd-chip-want'}`, dir ? base(tilde(dir)) || dir : 'pick a folder'));
    dirBtn.title = dir ? `${host.value}:${dir}` : 'the folder the agent works in';
  };
  // the harnesses the code service offers, the last one used picked
  const harnesses: CodeHarness[] = opts.harnesses || [];
  const lastHarness = lsGet(`${DIR_LS}-harness`, '');
  const harness = el('select');
  harness.innerHTML = harnesses.map((h) => `<option value="${esc(h.id)}"${h.id === lastHarness ? ' selected' : ''}>${esc(h.label.toLowerCase())}</option>`).join('') || '<option value="">no harnesses</option>';
  const hxOf = () => harnesses.find((h) => h.id === harness.value) || null;
  // each host's harnesses as the code service found them
  const found = new Map<string, CodeHarnesses>();
  const ready = (opts.models || []).filter((m) => m.ready !== false);
  const lastModel = lsGet(`${DIR_LS}-model`, '');
  let model = modelSelect(opts, (ready.find((m) => m.id === lastModel) || ready[0])?.id || '');
  const perm = el('select');
  perm.innerHTML = PERMS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const prompt = Object.assign(el('textarea', 'cd-first'), { rows: 3, placeholder: 'What should it do?', spellcheck: false });
  const grow = () => { prompt.style.height = 'auto'; prompt.style.height = `${Math.min(prompt.scrollHeight, 320)}px`; };
  prompt.addEventListener('input', grow);
  prompt.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  const install = el('div', 'cd-install');
  install.hidden = true;
  const login = loginPanel(() => host.value, () => {
    // the subscription's models in the list now, sonnet picked
    loadOpts(true).then((o) => { swapModel(modelSelect(o, 'sonnet')); valid(); signin.hidden = !!o.anthropic; });
  });
  login.hidden = true;
  const goBtn = Object.assign(el('button', 'chat-go cd-go'), { type: 'submit', title: 'start (enter)', ariaLabel: 'start' });
  goBtn.innerHTML = svg(GL.send!);
  const modelChip = chip('model', model, 'model');
  const bar = el('div', 'cd-bar');
  bar.append(chip('host', host, 'the computer the agent runs on, as your login there'), dirBtn,
    el('span', 'cd-bar-gap'), chip('term', harness, 'the harness that runs the session'), modelChip, chip('shield', perm, 'what the agent may do without asking'), goBtn);
  const box = el('div', 'cd-box');
  box.append(prompt, picker, bar);
  const msg = el('span', 'cd-msg');
  const signin = el('div', 'cd-signin');
  const signBtn = Object.assign(el('button', 'cd-link', 'Sign in to Claude'), { type: 'button' });
  signin.append('Using the mesh models. ', signBtn, ' to use Opus, Sonnet and Haiku.');
  signin.hidden = !!opts.anthropic;
  const openLogin = () => { login.hidden = false; login.focusIn(); };
  signBtn.addEventListener('click', openLogin);
  const foot = el('div', 'cd-start-foot');
  foot.append(msg, signin);
  const wrap = el('div', 'cd-start');
  wrap.append(el('div', 'cd-hello', 'What are we working on?'), install, login, box, foot);
  if (opts.error) wrap.prepend(el('p', 'cd-intro cd-bad', `couldn't load options: ${opts.error}`));
  form.replaceChildren(top, wrap);

  // a sign in offered as the last model, the choice put back once it's open
  function swapModel(next: HTMLSelectElement) {
    let was = next.value;
    if (!opts.anthropic && !cd.opts?.anthropic) {
      next.insertAdjacentHTML('beforeend', '<optgroup label="claude subscription"><option value="__login">Sign in for Opus, Sonnet, Haiku…</option></optgroup>');
    }
    next.addEventListener('change', () => {
      if (next.value === '__login') { next.value = was; openLogin(); return; }
      was = next.value;
      valid();
    });
    next.classList.add('cd-chip-sel');
    model.replaceWith(next);
    model = next;
  }
  swapModel(model);

  const why = () => {
    if (!host.value) return 'no computer to run on';
    const hx = hxOf();
    if (!hx) return 'no harness to run';
    if (install.dataset.missing === '1') return `${hx.label.toLowerCase()} isn't on ${host.value}: install it or pick another harness`;
    if (!dir) return 'pick a folder';
    if (!model.value || model.value === '__login') return 'pick a model';
    if (hx.meshOnly && provOf(model.value) === 'anthropic') return `${hx.label.toLowerCase()} runs on the mesh's models`;
    return '';
  };
  const valid = () => {
    const w = why();
    goBtn.disabled = !!w || !prompt.value.trim();
    // the folder chip says it already
    if (!msg.dataset.busy) msg.textContent = dir ? w : '';
  };
  form.addEventListener('input', valid);
  // the harness picked looked for on the host; a warning and an optional install when it's not there
  const check = async (fresh = false) => {
    const h = host.value;
    const hx = hxOf();
    install.hidden = true;
    install.dataset.missing = '';
    if (!h || !hx) { valid(); return; }
    let r = found.get(h);
    if (!r || fresh) {
      try { r = await call(`/api/code/harnesses?${qs({ host: h, fresh: fresh ? '1' : '' })}`); } catch (e) { r = { error: (e as Error).message }; }
      if (!r!.error) found.set(h, r!);
    }
    if (host.value !== h || hxOf() !== hx) return;
    const on = (r!.harnesses || []).find((x) => x.id === hx.id);
    for (const o of harness.options) {
      const x = (r!.harnesses || []).find((y) => y.id === o.value);
      const label = harnesses.find((y) => y.id === o.value)?.label.toLowerCase() || o.value;
      o.textContent = x && !x.installed ? `${label} · not on ${h}` : label;
    }
    if (r!.error) { host.parentElement!.title = `couldn't look for harnesses on ${h}: ${r!.error}`; valid(); return; }
    if (on?.installed) { harness.parentElement!.title = on.version ? `${hx.label.toLowerCase()} ${on.version} on ${h}` : h; valid(); return; }
    install.hidden = false;
    install.dataset.missing = '1';
    if (r!.why) { install.replaceChildren(el('span', '', r!.why)); valid(); return; }
    const b = Object.assign(el('button', 'cd-mini primary', `install ${hx.label.toLowerCase()}`), { type: 'button' });
    const out = el('pre', 'cd-install-out');
    out.hidden = true;
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'installing…';
      try {
        const x = await call('/api/code/install', 'POST', { host: h, harness: hx.id });
        out.hidden = !x.out;
        out.textContent = x.out || '';
        if (x.ok) { check(true); return; }
        b.textContent = 'install failed, retry';
      } catch (e) { out.hidden = false; out.textContent = (e as Error).message; b.textContent = 'retry'; }
      b.disabled = false;
    });
    const others = (r!.harnesses || []).filter((x) => x.installed).map((x) => x.label.toLowerCase());
    install.replaceChildren(el('span', '', `${hx.label.toLowerCase()} isn't installed on ${h}${others.length ? `; it has ${others.join(', ')}` : ''}. installing it is optional, from ${hx.site}.`), b, out);
    valid();
  };
  const pick = (p: string) => { dir = p; picker.hidden = true; paintDir(); valid(); prompt.focus(); };
  // the folder: typed, a recent one, or browsed to
  const openPicker = () => {
    const h = host.value;
    const path = noFill(Object.assign(el('input', 'cd-path'), { placeholder: '~/src/project', spellcheck: false, value: dir }));
    path.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); if (path.value.trim()) pick(path.value.trim()); }
      if (e.key === 'Escape') { picker.hidden = true; prompt.focus(); }
    });
    const rows: HTMLElement[] = [path];
    const recent = lsGet<{ host: string; dir: string }[]>(RECENT_LS, []).filter((x) => x.host === h).slice(0, 6);
    if (recent.length) {
      const ul = el('div', 'cd-recent');
      ul.append(el('div', 'cd-recent-t', 'recent'));
      for (const x of recent) {
        const b = Object.assign(el('button', 'cd-picker-row', tilde(x.dir)), { type: 'button', title: x.dir });
        b.addEventListener('click', () => pick(x.dir));
        ul.append(b);
      }
      rows.push(ul);
    }
    const browser = el('div', 'cd-browser');
    rows.push(browser);
    picker.replaceChildren(...rows);
    picker.hidden = false;
    browseAt(browser, h, dir, pick);
    path.focus();
  };
  dirBtn.addEventListener('click', () => { if (picker.hidden) openPicker(); else picker.hidden = true; });
  host.addEventListener('change', () => { dir = dirs[host.value] || ''; picker.hidden = true; paintDir(); check(); });
  harness.addEventListener('change', () => { check(); valid(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (goBtn.disabled) { if (!dir) openPicker(); return; }
    goBtn.disabled = true;
    msg.dataset.busy = '1';
    msg.textContent = 'starting';
    dirs[host.value] = dir;
    lsSet(DIR_LS, dirs);
    lsSet(`${DIR_LS}-host`, host.value);
    lsSet(`${DIR_LS}-model`, model.value);
    lsSet(`${DIR_LS}-harness`, harness.value);
    lsSet(RECENT_LS, [{ host: host.value, dir }, ...lsGet<{ host: string; dir: string }[]>(RECENT_LS, []).filter((x) => x.host !== host.value || x.dir !== dir)].slice(0, 30));
    call('/api/code/sessions', 'POST', { host: host.value, dir, harness: harness.value, model: model.value, perm: perm.value, prompt: prompt.value.trim() })
      .then((r: CodeSession) => {
        cd.list = [r, ...cd.list.filter((s) => s.id !== r.id)];
        go(r.id);
        loadList();
      }, (err) => { delete msg.dataset.busy; msg.textContent = err.message; goBtn.disabled = false; });
  });
  paintDir();
  valid();
  check();
  if (cd.login) { cd.login = false; openLogin(); } else prompt.focus({ preventScroll: true });
}

// a folder picker over the user's login on the host, from its home down
async function browseAt(box: HTMLElement & { seq?: number }, host: string, dir: string, pick: (p: string) => void) {
  const seq = (box.seq = (box.seq || 0) + 1);
  const head = el('div', 'cd-picker-head');
  const listing = el('ul', 'cd-picker-list');
  box.replaceChildren(head, listing);
  head.append(el('span', 'cd-picker-path', dir || '~'));
  listing.append(el('li', 'st-wait', 'loading'));
  let r: CodeLs;
  try { r = await call(`/api/code/ls?${qs({ host, dir })}`); } catch (e) {
    if (box.seq !== seq) return;
    const home = Object.assign(el('button', 'cd-mini', '~'), { type: 'button', title: 'home' });
    home.addEventListener('click', () => browseAt(box, host, '', pick));
    head.prepend(home);
    listing.replaceChildren(el('li', 'cd-bad', (e as Error).message));
    return;
  }
  if (box.seq !== seq) return;
  const up = Object.assign(el('button', 'cd-mini', '..'), { type: 'button', title: 'up', disabled: r.dir === '/' });
  up.addEventListener('click', () => browseAt(box, host, parent(r.dir), pick));
  const use = Object.assign(el('button', 'cd-mini primary', 'use this folder'), { type: 'button' });
  use.addEventListener('click', () => pick(r.dir));
  head.replaceChildren(up, el('span', 'cd-picker-path', r.dir), use);
  const dirs = (r.entries || []).filter((e) => e.dir && !e.name.startsWith('.'));
  listing.replaceChildren(...dirs.map((e) => {
    const b = Object.assign(el('button', 'cd-picker-row', `${e.name}/`), { type: 'button' });
    b.addEventListener('click', () => browseAt(box, host, `${r.dir.replace(/\/$/, '')}/${e.name}`, pick));
    return b;
  }));
  if (!dirs.length) listing.append(el('li', 'st-dim', 'no folders'));
  if (r.more) listing.append(el('li', 'st-dim', 'more not shown'));
}

// a session's folder browsed in a panel over the app, folders and files,
// hidden ones on a toggle
function openBrowser(host: string, dir: string) {
  root.querySelector(':scope > .cd-browse')?.remove();
  const wrap = el('div', 'cd-browse');
  const panel = Object.assign(el('div', 'cd-browse-panel'), { role: 'dialog', ariaLabel: `${host} files` });
  const head = el('div', 'cd-picker-head');
  const listing = el('ul', 'cd-picker-list cd-browse-list');
  panel.append(head, listing);
  wrap.append(panel);
  root.append(wrap);
  let dots = false;
  let seq = 0;
  const close = () => { wrap.remove(); document.removeEventListener('keydown', key, true); };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && wrap.isConnected) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const shut = Object.assign(el('button', 'cd-mini', 'close'), { type: 'button' });
  shut.addEventListener('click', close);
  const nav = async (d: string) => {
    const n = ++seq;
    head.replaceChildren(el('span', 'cd-host', host), el('span', 'cd-picker-path', d || '~'), shut);
    listing.replaceChildren(el('li', 'st-wait', 'loading'));
    let r: CodeLs;
    try { r = await call(`/api/code/ls?${qs({ host, dir: d })}`); } catch (e) {
      if (n === seq) listing.replaceChildren(el('li', 'cd-bad', (e as Error).message));
      return;
    }
    if (n !== seq || !wrap.isConnected) return;
    const up = Object.assign(el('button', 'cd-mini', '..'), { type: 'button', title: 'up', disabled: r.dir === '/' });
    up.addEventListener('click', () => nav(parent(r.dir)));
    const hid = Object.assign(el('button', `cd-mini${dots ? ' primary' : ''}`, 'hidden'), { type: 'button', title: 'show hidden files' });
    hid.addEventListener('click', () => { dots = !dots; nav(r.dir); });
    const path = el('span', 'cd-picker-path', r.dir);
    path.title = `${host}:${r.dir}`;
    head.replaceChildren(up, el('span', 'cd-host', host), path, hid, shut);
    const ents = (r.entries || []).filter((e) => dots || !e.name.startsWith('.'));
    listing.replaceChildren(...ents.map((e) => {
      const row: HTMLElement = e.dir ? Object.assign(el('button', 'cd-browse-row dir'), { type: 'button' }) : el('div', 'cd-browse-row');
      row.append(el('span', 'cd-browse-name', e.dir ? `${e.name}/` : e.name), el('span', 'cd-browse-size', e.dir ? '' : bytes(e.size)),
        el('span', 'cd-browse-at', e.mtime ? ago(e.mtime) : ''));
      if (e.dir) row.addEventListener('click', () => nav(`${r.dir.replace(/\/$/, '')}/${e.name}`));
      const li = el('li');
      li.append(row);
      return li;
    }));
    if (!ents.length) listing.append(el('li', 'st-dim', 'empty'));
    if (r.more) listing.append(el('li', 'st-dim', 'more not shown'));
  };
  nav(dir);
  shut.focus();
}

// --- the window coming and going ---

function codeWatch(on: boolean): void {
  cd.on = on;
  clearInterval(cd.tick);
  cd.tick = 0;
  if (!on) {
    for (const t of cd.logs.values()) { t.closed = true; t.sock?.close(); t.sock = null; }
    return;
  }
  loadOpts(true).then(() => { paintHead(); paintAcct(); });
  loadList().then(() => {
    if (cd.pick && cd.pick !== 'new' && !main.querySelector('.cd-log')) paintOne();
    else if (cd.pick !== 'new') { const t = cd.logs.get(cd.pick); if (t) { t.closed = false; connect(t); } }
  });
  cd.tick = setInterval(() => { if (!document.hidden && deskApps.has('code')) loadList(); }, LIST_MS);
}

// --- the Claude account at the side's foot ---

function paintAcct() {
  const on = !!cd.opts?.anthropic;
  acctBtn.replaceChildren(el('span', `cd-acct-dot${on ? ' on' : ''}`), el('span', 'cd-acct-t', 'Claude account'),
    el('span', 'cd-acct-st', on ? 'signed in' : 'sign in'));
}

function acctOpen(on: boolean) {
  acctBox.hidden = !on;
  acctBtn.setAttribute('aria-expanded', String(on));
  if (on) codeToken(acctBox);
}

// --- the anthropic token: pasted, saved, cleared, never shown back ---

function codeToken(box: HTMLElement) {
  box.classList.add('cd-token');
  const title = el('div', 'dk-cl-sec-t', 'Claude subscription');
  const state = el('span', 'dk-cl-state', '…');
  title.append(' ', state);
  const inp = tokenInput('dk-cl-url cd-token-in');
  const save = Object.assign(el('button', 'dk-cl-key', 'save token'), { type: 'button' });
  const clear = Object.assign(el('button', 'dk-cl-key quiet', 'clear'), { type: 'button' });
  const hint = el('div', 'cd-token-hint');
  hint.innerHTML = 'Run <code>claude setup-token</code> in a terminal and paste the token it prints, for Opus, Sonnet and Haiku.';
  const bar = el('div', 'dk-cl-bar cd-token-bar');
  bar.append(inp, save, clear);
  box.replaceChildren(title, hint, bar);
  const paint = (on: boolean) => {
    state.textContent = on ? 'connected' : 'not connected';
    state.dataset.state = on ? 'online' : 'off';
    clear.hidden = !on;
    inp.placeholder = on ? 'paste a new token to replace it' : 'sk-ant-oat…';
  };
  const put = async (token: string) => {
    save.disabled = clear.disabled = true;
    try {
      const on = await saveToken(token);
      inp.value = '';
      paint(on);
      // saved: folded back into the account row, its dot saying so
      if (on && box === acctBox) acctOpen(false);
      loadOpts(true).then(() => { headSig = ''; paintHead(); paintAcct(); });
    } catch (e) { state.textContent = (e as Error).message; state.dataset.state = 'off'; }
    save.disabled = clear.disabled = false;
  };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && inp.value.trim()) put(inp.value.trim()); });
  save.addEventListener('click', () => { if (inp.value.trim()) put(inp.value.trim()); else inp.focus(); });
  clear.addEventListener('click', () => put(''));
  call('/api/code/options').then((o) => { cd.opts = o; paint(!!o.anthropic); paintAcct(); }, () => paint(false));
  inp.focus({ preventScroll: true });
}

// a file's path in a tool card opened in the editor when it sits in a share
view.addEventListener('dblclick', (e) => {
  const a = (e.target as Element).closest('.cd-tool-arg');
  const card = (e.target as Element).closest('.cd-tool');
  const r = rec();
  if (!a || !card || !r || !/cd-tool-(Read|Edit|MultiEdit|Write)\b/.test(card.className)) return;
  const sh = shareOf(r.host, a.textContent!.replace(/ :\d.*$/, ''));
  if (sh) dkCode({ host: r.host, share: sh.loc.share, path: sh.rel, label: `${r.host}/${sh.rel}` });
});

export { codeWatch };
