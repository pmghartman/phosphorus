import {
  deskApps,
  dk,
  dkCode,
  dkTerminal,
  el,
  esc,
  hostsInfo,
  wsBase,
} from '../app.js';
import { renderMd } from '../md.js';

// --- code: claude code sessions on any mesh host, as the desktop app's code tab
// draws them: the sessions down the side, one's transcript streamed over a
// socket, a composer under it; every action a REST call

const view = document.getElementById('view-code');

const PERMS = [
  ['default', 'ask first'],
  ['acceptEdits', 'accept edits'],
  ['plan', 'plan only'],
  ['bypassPermissions', 'bypass all'],
];
const PICK_LS = 'phosphorus-code-pick';
const DIR_LS = 'phosphorus-code-dirs';
const LIST_MS = 4000;
// an upload's bytes at most, as the server takes
const UP_MAX = 50 * 1024 * 1024;
const ANTH = ['opus', 'sonnet', 'haiku'];
const provOf = (id) => (ANTH.includes(id) ? 'anthropic' : 'mesh');
// a tool's output kept to this on screen, the rest counted
const OUT_MAX = 16000;

const cd = {
  list: [], opts: null, pick: '', filter: '', armed: '', renaming: '', listSig: '',
  // id -> transcript: its node, last seq, open cards, live blocks, its socket
  logs: new Map(), tick: 0, on: false, drawer: false,
};

const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tilde = (d) => String(d || '').replace(/^\/(home|Users)\/[^/]+(?=\/|$)/, '~').replace(/^\/root(?=\/|$)/, '~');
const base = (d) => String(d || '').replace(/\/+$/, '').split('/').pop() || '/';
const parent = (d) => String(d || '').replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';
const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v ?? '')}`).join('&');
const bytes = (n) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)}G` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(1)}K` : `${n || 0}B`);
const kfmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
const ago = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
};
const live = (r) => r && (r.status === 'working' || r.status === 'starting');
const svg = (d) => `<svg viewBox="0 0 16 16" class="ic" aria-hidden="true"><path d="${d}"/></svg>`;
const GL = {
  term: 'M2 3h12v10H2zM4.5 6.5l2 1.5-2 1.5M8 10h3.5',
  folder: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  side: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  attach: 'M10.5 4.5l-4.8 4.8a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.3-4.3',
  send: 'M8 12.5V3.5M4 7.5L8 3.5l4 4',
  stop: 'M4.5 4.5h7v7h-7z',
};

async function call(url, method = 'GET', body) {
  const init = { method, cache: 'no-store' };
  if (body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(body); }
  const r = await fetch(url, init);
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `status ${r.status}`);
  return out;
}
const sapi = (id, op = '') => `/api/code/sessions/${encodeURIComponent(id)}${op ? `/${op}` : ''}`;

// --- the frame: side list, main pane ---

const root = el('div', 'cd');
const side = el('div', 'cd-side');
const main = el('div', 'cd-main');
const scrim = el('div', 'cd-scrim');
root.append(side, main, scrim);
view.replaceChildren(root);
scrim.addEventListener('click', () => drawer(false));

const sideHead = el('div', 'home-col-head', 'sessions');
const sideTop = el('div', 'cd-side-top');
const newBtn = Object.assign(el('button', 'cd-new', '+ new session'), { type: 'button', title: 'new session' });
const find = Object.assign(el('input', 'cd-find'), { type: 'search', placeholder: 'filter', spellcheck: false, autocomplete: 'off' });
sideTop.append(newBtn, find);
const listEl = Object.assign(el('nav', 'cd-list'), { ariaLabel: 'sessions' });
side.append(sideHead, sideTop, listEl);
newBtn.addEventListener('click', () => go('new'));
find.addEventListener('input', () => { cd.filter = find.value.trim().toLowerCase(); cd.listSig = ''; paintList(); });
find.addEventListener('keydown', (e) => e.stopPropagation());

function drawer(on) {
  cd.drawer = on;
  root.classList.toggle('cd-drawer', on);
}

// --- the list ---

async function loadList() {
  try {
    const r = await call('/api/code/sessions');
    cd.list = r.sessions || [];
    cd.err = '';
  } catch (e) { cd.err = e.message; }
  if (!cd.pick) cd.pick = cd.list.some((s) => s.id === lsGet(PICK_LS, '')) ? lsGet(PICK_LS, '') : cd.list[0]?.id || 'new';
  if (cd.pick !== 'new' && !cd.list.some((s) => s.id === cd.pick) && !cd.err) { go(cd.list[0]?.id || 'new'); return; }
  paintList();
  if (cd.pick === 'new' && !main.querySelector('.cd-newform')) paintNew();
  else if (cd.pick !== 'new') paintHead();
}

async function loadOpts(fresh) {
  if (cd.opts && !fresh) return cd.opts;
  try { cd.opts = await call('/api/code/options'); } catch (e) { cd.opts = { hosts: [], models: [], anthropic: false, error: e.message }; }
  return cd.opts;
}

const rec = (id = cd.pick) => cd.list.find((s) => s.id === id) || null;

function paintList() {
  const sig = JSON.stringify([cd.list, cd.pick, cd.filter, cd.armed, cd.renaming, cd.err, Math.floor(Date.now() / 60000)]);
  if (sig === cd.listSig) return;
  cd.listSig = sig;
  const f = cd.filter;
  const shown = cd.list.filter((s) => !f || [s.title, s.host, s.dir, s.model].some((x) => String(x || '').toLowerCase().includes(f)));
  const rows = [];
  if (cd.err) rows.push(el('div', 'cw-empty cd-bad', `failed: ${cd.err}`));
  else if (!cd.list.length) rows.push(el('div', 'cw-empty', 'no sessions yet'));
  else if (!shown.length) rows.push(el('div', 'cw-empty', 'nothing matches'));
  for (const s of shown) {
    const row = el('div', `cd-item${s.id === cd.pick ? ' on' : ''}`);
    row.dataset.id = s.id;
    if (cd.renaming === s.id) {
      const inp = Object.assign(el('input', 'cd-rename'), { value: s.title || '', maxLength: 120, spellcheck: false });
      const done = (save) => {
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
  const focused = document.activeElement?.closest?.('.cd-item')?.dataset.id;
  listEl.replaceChildren(...rows);
  if (focused && !cd.renaming) listEl.querySelector(`.cd-item[data-id="${CSS.escape(focused)}"] .cd-pick`)?.focus();
}

// twice to confirm, the first press arming it a few seconds
function arm(what) {
  if (cd.armed === what) { cd.armed = ''; return true; }
  cd.armed = what;
  cd.listSig = '';
  paintList();
  setTimeout(() => { if (cd.armed === what) { cd.armed = ''; cd.listSig = ''; paintList(); } }, 4000);
  return false;
}

function remove(s) {
  if (!arm(`del:${s.id}`)) return;
  call(sapi(s.id), 'DELETE').then(() => {
    const t = cd.logs.get(s.id);
    if (t) { t.closed = true; t.sock?.close(); cd.logs.delete(s.id); }
    cd.list = cd.list.filter((x) => x.id !== s.id);
    if (cd.pick === s.id) { cd.pick = ''; go(cd.list[0]?.id || 'new'); } else loadList();
  }, (e) => say(e.message));
}

function go(id) {
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

let head = null;
let headSig = '';
let composer = null;

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
  requestAnimationFrame(() => { t.node.scrollTop = t.node.scrollHeight; });
  if (!view.closest('[hidden]')) composer.text.focus({ preventScroll: true });
}

function sideBtn() {
  const b = Object.assign(el('button', 'cd-icon cd-side-btn'), { type: 'button', title: 'sessions', ariaLabel: 'sessions' });
  b.innerHTML = svg(GL.side);
  b.addEventListener('click', () => drawer(!cd.drawer));
  return b;
}

// the share holding a host's absolute folder, its path inside it
function shareOf(host, dir) {
  const shares = hostsInfo[String(host).toLowerCase()]?.files?.shares || [];
  const clean = (p) => String(p || '').replace(/\/+$/, '');
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
  term.innerHTML = svg(GL.term);
  const can = dk.creds?.has(r.host);
  term.disabled = !can;
  term.title = can ? `terminal on ${r.host} in ${r.dir}` : `log into ${r.host} on the desktop for a terminal`;
  term.addEventListener('click', () => dkTerminal(r.host, `cd ${shQuote(r.dir)}`));
  const folder = Object.assign(el('button', 'cd-icon'), { type: 'button', ariaLabel: 'open folder' });
  folder.innerHTML = svg(GL.folder);
  folder.title = `browse ${r.host}:${r.dir}`;
  folder.addEventListener('click', () => openBrowser(r.host, r.dir));
  tools.append(term, folder);
  top.append(sideBtn(), title, state, tools);

  const bar = el('div', 'cd-head-bar');
  const where = el('span', 'cd-where');
  where.append(el('span', 'cd-host', r.host), el('span', 'st-dim', ':'), tilde(r.dir));
  where.title = `${r.host}:${r.dir}`;
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
function modelSelect(opts, cur, lock) {
  const s = el('select', 'cd-sel');
  const CROSS = 'start a new session to change provider';
  s.title = lock ? `model; ${CROSS}` : 'model';
  const models = (opts?.models || []).filter((m) => m.provider !== 'anthropic' || opts.anthropic);
  const mesh = models.filter((m) => m.provider !== 'anthropic');
  const anth = models.filter((m) => m.provider === 'anthropic');
  const off = (m) => lock && provOf(m.id) !== provOf(cur);
  const opt = (m) => `<option value="${esc(m.id)}"${m.id === cur ? ' selected' : ''}${(m.ready === false && m.id !== cur) || off(m) ? ' disabled' : ''}`
    + `${off(m) ? ` title="${CROSS}"` : ''}>${esc(m.label || m.id)}${m.ready === false ? ` · ${esc(m.why || 'not ready')}` : ''}</option>`;
  const group = (label, ms) => `<optgroup label="${label}"${ms.length && ms.every(off) ? ` title="${CROSS}"` : ''}>${ms.map(opt).join('')}</optgroup>`;
  let html = '';
  if (mesh.length) html += group('mesh', mesh);
  if (anth.length) html += group('anthropic', anth);
  if (cur && !models.some((m) => m.id === cur)) html += `<option value="${esc(cur)}" selected>${esc(cur)}</option>`;
  s.innerHTML = html || '<option value="">no models</option>';
  return s;
}

// a line in the composer's corner
function say(text) {
  const m = main.querySelector('.cd-msg');
  if (m) { m.textContent = text; clearTimeout(m.t); m.t = setTimeout(() => { m.textContent = ''; }, 6000); }
}

// --- the socket: everything after the last seq seen, then live ---

function connect(t) {
  if (t.sock || t.closed || !cd.on) return;
  const ws = new WebSocket(`${wsBase()}/api/code/ws/${encodeURIComponent(t.id)}?since=${t.seq}`);
  t.sock = ws;
  ws.onopen = () => { t.retry = 0; };
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.seq && m.seq <= t.seq) return;
    t.node.querySelector(':scope > .cd-wait')?.remove();
    const stick = t.node.scrollHeight - t.node.scrollTop - t.node.clientHeight < 40;
    take(t, m);
    if (m.seq) t.seq = m.seq;
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

function take(t, m) {
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
      const c = t.perms.get(m.reqId);
      if (c) c.done(m.allow, false, m.cancelled);
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

function addNote(t, kind, text) {
  const n = el('div', `cd-note cd-note-${kind}`);
  n.append(el('span', 'cd-note-tag', kind), el('span', 'cd-note-text', text));
  t.node.append(n);
  return n;
}

// --- claude's stream-json, one event at a time ---

function claudeEv(t, ev) {
  const where = ev.parent_tool_use_id ? t.cards.get(ev.parent_tool_use_id)?.sub || t.node : t.node;
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        const bits = [ev.model, ev.permissionMode, ev.cwd && tilde(ev.cwd)].filter(Boolean);
        addNote(t, 'session', bits.join(' · ') || 'started').classList.add('cd-quiet');
      } else if (ev.subtype && ev.subtype !== 'status') addNote(t, ev.subtype.replace(/_/g, ' '), ev.message || ev.content || '').classList.add('cd-quiet');
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
      for (const b of content) if (b.type === 'tool_result') toolResult(t, b, ev.tool_use_result);
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
      if (ev.total_cost_usd) bits.push(`$${ev.total_cost_usd.toFixed(4)}`);
      const f = el('div', `cd-foot${bad ? ' bad' : ''}`);
      f.append(el('span', '', bits.join(' · ')));
      t.node.append(f);
      if (bad && ev.result && typeof ev.result === 'string') addNote(t, 'error', ev.result);
      if (bad && Array.isArray(ev.errors)) for (const e of ev.errors) addNote(t, 'error', String(e));
      break;
    }
    default: break;
  }
}

// a final block in place of its streamed draft, else at the end
function place(t, kind, node, where) {
  const i = where === t.node ? t.live.findIndex((x) => x.kind === kind) : -1;
  if (i >= 0) {
    const [x] = t.live.splice(i, 1);
    x.el.replaceWith(node);
  } else where.append(node);
}

function flushLive(t) {
  for (const x of t.live) x.el.remove();
  t.live = [];
}

function streamEv(t, e) {
  if (e.type === 'content_block_start') {
    const kind = { text: 'text', thinking: 'thinking', tool_use: 'tool', server_tool_use: 'tool' }[e.content_block?.type];
    if (!kind) return;
    let node;
    if (kind === 'text') node = el('div', 'cd-text cd-streaming');
    else if (kind === 'thinking') node = thinkBlock('');
    else {
      node = el('div', 'cd-tool run cd-streaming');
      const h = el('div', 'cd-tool-head');
      h.append(el('span', 'cd-pip'), el('span', 'cd-tool-name', e.content_block.name || 'tool'), el('span', 'cd-tool-arg', '…'));
      node.append(h);
    }
    const x = { kind, el: node, index: e.index, text: '' };
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
      x.el.querySelector('.cd-think-body').textContent = x.text;
      x.el.querySelector('.cd-think-sum').textContent = 'thinking…';
    }
  } else if (e.type === 'message_stop') {
    // drafts never confirmed by a final block (none arrive for an interrupted turn) left till the turn ends
  }
}

function textBlock(text) {
  const d = el('div', 'cd-text md');
  renderMd(d, text);
  return d;
}

function thinkBlock(text) {
  const d = el('details', 'cd-think');
  const s = el('summary', 'cd-think-sum', text ? `thought · ${kfmt(text.length)} chars` : 'thinking…');
  d.append(s, el('div', 'cd-think-body', text));
  return d;
}

// --- tool calls: a line like a coding agent's log, its outcome under it, the detail folded ---

const COMPACT = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'BashOutput', 'KillShell', 'KillBash']);

function toolArg(name, x = {}) {
  switch (name) {
    case 'Bash': return x.description || x.command || '';
    case 'Read': return `${x.file_path || ''}${x.offset ? ` :${x.offset}${x.limit ? `-${x.offset + x.limit}` : ''}` : ''}`;
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return x.file_path || x.notebook_path || '';
    case 'Glob': return `${x.pattern || ''}${x.path ? ` in ${x.path}` : ''}`;
    case 'Grep': return `${x.pattern || ''}${x.path ? ` in ${x.path}` : ''}${x.glob ? ` (${x.glob})` : ''}`;
    case 'WebFetch': return x.url || '';
    case 'WebSearch': return x.query || '';
    case 'Task': case 'Agent': return x.description || x.subagent_type || '';
    case 'TodoWrite': return `${(x.todos || []).filter((y) => y.status === 'completed').length}/${(x.todos || []).length} done`;
    default: {
      const v = Object.values(x).find((y) => typeof y === 'string');
      return v ? v.slice(0, 120) : '';
    }
  }
}

// mcp__phosphorus__files_list as phosphorus · files_list
const toolName = (n) => (n.startsWith('mcp__') ? n.slice(5).replace('__', ' · ') : n);

function toolCard(t, b) {
  const name = b.name || 'tool';
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

function editStat(name, x) {
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

function toolInput(name, x) {
  switch (name) {
    case 'Bash': {
      const p = el('pre', 'cd-cmd');
      p.append(el('span', 'cd-prompt', '$ '), x.command || '');
      return [p];
    }
    case 'Edit': return [diffView(x.old_string, x.new_string)];
    case 'MultiEdit': return (x.edits || []).map((e) => diffView(e.old_string, e.new_string));
    case 'Write': return [diffView('', x.content)];
    case 'TodoWrite': return [todoList(x.todos || [])];
    default:
      if (COMPACT.has(name)) return [];
      return [Object.assign(el('pre', 'cd-json'), { textContent: JSON.stringify(x, null, 2) })];
  }
}

const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : '')).join('\n') : c == null ? '' : JSON.stringify(c, null, 2));
const clip = (s) => (s.length > OUT_MAX ? `${s.slice(0, OUT_MAX)}\n… ${kfmt(s.length - OUT_MAX)} more chars` : s);

function toolResult(t, b) {
  const c = t.cards.get(b.tool_use_id);
  if (!c) return;
  const text = resultText(b.content).replace(/\s+$/, '');
  const bad = !!b.is_error;
  c.el.classList.remove('run');
  c.el.classList.add(bad ? 'bad' : 'ok');
  const n = text ? text.split('\n').length : 0;
  let out;
  if (bad) out = text.split('\n')[0] || 'failed';
  else if (c.name === 'Bash') out = text ? `${text.split('\n')[0].slice(0, 160)}${n > 1 ? `  (+${n - 1} lines)` : ''}` : '(no output)';
  else if (c.name === 'Read') out = `${n} lines`;
  else if (c.name === 'Glob') out = /^no files/i.test(text) ? 'no files' : `${n} files`;
  else if (c.name === 'Grep') out = text.split('\n')[0].slice(0, 160) || 'no matches';
  else if (['Edit', 'MultiEdit', 'Write'].includes(c.name)) out = 'applied';
  else if (c.name === 'TodoWrite') out = 'todos updated';
  else out = text ? `${text.split('\n')[0].slice(0, 160)}${n > 1 ? `  (+${n - 1} lines)` : ''}` : 'done';
  c.out.textContent = out;
  // what came back, folded with the input, unless an edit's "updated" line
  if (text && (bad || !['Edit', 'MultiEdit', 'Write', 'TodoWrite'].includes(c.name))) {
    const p = el('pre', `cd-result${bad ? ' bad' : ''}`, clip(text));
    c.body.append(p);
  }
}

// --- diffs: old and new as lines, the shortest edit between, 3 lines of context ---

const lines = (s) => (s ? String(s).replace(/\n$/, '').split('\n') : []);

function lineDiff(a, b) {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const mid = [];
  if (A.length * B.length > 600000) {
    for (const l of A) mid.push(['-', l]);
    for (const l of B) mid.push(['+', l]);
  } else {
    const n = A.length;
    const m = B.length;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { mid.push([' ', A[i]]); i++; j++; }
      else if (j < m && (i >= n || L[i * (m + 1) + j + 1] >= L[(i + 1) * (m + 1) + j])) { mid.push(['+', B[j]]); j++; }
      else { mid.push(['-', A[i]]); i++; }
    }
  }
  return [...a.slice(0, p).map((l) => [' ', l]), ...mid, ...a.slice(a.length - s).map((l) => [' ', l])];
}

function countDiff(a, b) {
  let add = 0;
  let del = 0;
  for (const [k] of lineDiff(lines(a), lines(b))) { if (k === '+') add++; else if (k === '-') del++; }
  return { add, del };
}

function diffView(a, b) {
  const ops = lineDiff(lines(a), lines(b));
  const keep = new Array(ops.length).fill(false);
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

const cdBar = (frac, n = 20) => {
  const k = Math.max(0, Math.min(n, Math.round(frac * n)));
  return `[<span class="cd-cells">${'█'.repeat(k)}<i>${'░'.repeat(n - k)}</i></span>]`;
};

function todoList(todos) {
  const ul = el('ul', 'cd-todo-list');
  for (const x of todos) {
    const li = el('li', `cd-todo-${x.status}`);
    li.append(el('span', 'cd-box', x.status === 'completed' ? '[x]' : x.status === 'in_progress' ? '[~]' : '[ ]'), ' ',
      x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content);
    ul.append(li);
  }
  return ul;
}

function paintTodos(t) {
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

function permCard(t, m) {
  flushLive(t);
  const c = el('div', 'cd-perm');
  const h = el('div', 'cd-perm-head');
  h.append(el('span', 'cd-perm-tag', 'permission'), el('span', 'cd-tool-name', toolName(m.tool || 'tool')));
  const arg = toolArg(m.tool, m.input || {});
  if (arg) h.append(el('span', 'cd-tool-arg', arg));
  const body = el('div', 'cd-perm-body');
  if (m.reason) body.append(el('div', 'cd-perm-reason', m.reason));
  const shown = toolInput(m.tool, m.input || {});
  body.append(...(shown.length ? shown : [Object.assign(el('pre', 'cd-json'), { textContent: JSON.stringify(m.input || {}, null, 2) })]));
  const why = Object.assign(el('input', 'cd-perm-why'), { type: 'text', placeholder: 'tell claude why, if denying (optional)', spellcheck: false });
  why.addEventListener('keydown', (e) => e.stopPropagation());
  const acts = el('div', 'update-actions cd-perm-acts');
  const msg = el('span', 'cd-perm-msg');
  const btn = (label, cls, allow, always) => {
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
  const done = (allow, always, cancelled) => {
    if (c.classList.contains('answered')) return;
    c.classList.add('answered', allow ? 'allowed' : 'denied');
    why.remove();
    acts.replaceChildren(el('span', `cd-perm-msg ${allow ? 'good' : cancelled ? '' : 'bad'}`, allow ? (always ? 'always allowed' : 'allowed') : cancelled ? 'no longer asked' : 'denied'));
  };
  t.perms.set(m.reqId, { el: c, done });
  t.node.append(c);
}

// --- composer ---

function makeComposer(t) {
  const node = el('div', 'cd-compose');
  const atts = el('div', 'cd-atts');
  const form = el('form', 'chat-form cd-form');
  const text = Object.assign(el('textarea', 'cd-text-in'), { rows: 1, placeholder: 'ask claude', title: 'enter sends, shift+enter a new line, esc stops a turn', spellcheck: false });
  const attach = Object.assign(el('button', 'chat-icon chat-attach cd-attach'), { type: 'button', ariaLabel: 'attach' });
  attach.innerHTML = svg(GL.attach);
  const stop = Object.assign(el('button', 'cd-stop'), { type: 'button', title: 'stop this turn', ariaLabel: 'stop' });
  stop.innerHTML = `${svg(GL.stop)}<span>stop</span>`;
  const go = Object.assign(el('button', 'chat-go'), { type: 'submit', title: 'send (enter)', ariaLabel: 'send', disabled: true });
  go.innerHTML = svg(GL.send);
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
  input.addEventListener('change', () => { upload(t, [...input.files], atts, text, grow); input.value = ''; });
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
  const state = (r) => {
    const working = live(r);
    stop.hidden = !working;
    attach.disabled = !r;
    attach.title = r ? `attach files: uploaded into ${r.host}:${r.dir}` : 'attach files';
    form.classList.toggle('cd-busy', working);
  };
  state(rec(t.id));
  return { node, text, state };
}

// a file posted raw, its progress told
function sendFile(url, f, progress) {
  return new Promise((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => progress(e.loaded);
    x.onload = () => {
      let o = {};
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
async function upload(t, files, atts, text, grow) {
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
      st.textContent = e.message;
      setTimeout(() => chip.remove(), 6000);
    }
  }
}

// --- a new session ---

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
      el('p', 'cd-intro', 'Code runs claude on one of your computers, signed in as you over ssh, so it needs a login of yours saved for that computer.'),
      el('p', 'cd-intro', 'Open a terminal on a computer from the desktop, log in and save the login, then come back here.'),
      again);
    form.replaceChildren(top, box);
    return;
  }
  const hosts = opts.hosts || [];
  const dirs = lsGet(DIR_LS, {});
  const lastHost = lsGet(`${DIR_LS}-host`, '');
  const host = el('select', 'update-pass cd-sel');
  host.innerHTML = hosts.map((h) => `<option value="${esc(h)}"${h === lastHost ? ' selected' : ''}>${esc(h)}</option>`).join('') || '<option value="">no hosts</option>';
  const dir = Object.assign(el('input', 'update-pass cd-dir'), { type: 'text', placeholder: '/home/you/src/project', spellcheck: false, autocomplete: 'off', required: true });
  dir.value = dirs[host.value] || '';
  const browse = Object.assign(el('button', 'cd-mini'), { type: 'button', textContent: 'browse' });
  const picker = el('div', 'cd-picker');
  picker.hidden = true;
  const model = modelSelect(opts, (opts.models || []).find((m) => m.ready !== false)?.id || '');
  model.classList.add('update-pass');
  const perm = el('select', 'update-pass cd-sel');
  perm.innerHTML = PERMS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  const prompt = Object.assign(el('textarea', 'update-pass cd-first'), { rows: 6, placeholder: 'what should claude do?', spellcheck: false, required: true });
  prompt.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  for (const i of [dir]) i.addEventListener('keydown', (e) => e.stopPropagation());
  const install = el('div', 'cd-install');
  install.hidden = true;
  const row = (label, ...kids) => {
    const r = el('label', 'cd-row');
    r.append(el('span', 'st-key', label), ...kids);
    return r;
  };
  const dirWrap = el('span', 'cd-dir-wrap');
  dirWrap.append(dir, browse);
  const intro = el('p', 'cd-intro');
  intro.innerHTML = 'Claude Code runs on the host you pick, as your login there, in the folder you name. '
    + 'It gets your phosphorus connector and skill. '
    + (opts.anthropic ? '' : '<span class="st-dim">Add an anthropic token under the agent menu to use opus, sonnet and haiku.</span>');
  const msg = el('span', 'cd-msg');
  const goBtn = Object.assign(el('button', 'primary', 'start'), { type: 'submit' });
  const acts = el('div', 'update-actions');
  acts.append(msg, goBtn);
  form.replaceChildren(top, intro);
  if (opts.error) form.append(el('p', 'cd-intro cd-bad', `couldn't load options: ${opts.error}`));
  form.append(row('host', host), install, row('folder', dirWrap), picker, row('model', model), row('mode', perm), prompt, acts);
  const valid = () => { goBtn.disabled = !host.value || !dir.value.trim() || !model.value || !prompt.value.trim() || install.dataset.missing === '1'; };
  form.addEventListener('input', valid);
  const check = async () => {
    const h = host.value;
    install.hidden = true;
    install.dataset.missing = '';
    if (!h) { valid(); return; }
    let r;
    try { r = await call(`/api/code/install?host=${encodeURIComponent(h)}`); } catch (e) { r = { installed: true, error: e.message }; }
    if (host.value !== h) return;
    if (r.installed) { install.hidden = !r.version; install.className = 'cd-install ok'; install.textContent = r.version ? `claude ${r.version} on ${h}` : ''; valid(); return; }
    install.hidden = false;
    install.dataset.missing = '1';
    install.className = 'cd-install';
    const b = Object.assign(el('button', 'cd-mini primary', 'install claude'), { type: 'button' });
    const out = el('pre', 'cd-install-out');
    out.hidden = true;
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'installing…';
      try {
        const x = await call('/api/code/install', 'POST', { host: h });
        out.hidden = !x.out;
        out.textContent = x.out || '';
        if (x.ok) { check(); return; }
        b.textContent = 'install failed, retry';
      } catch (e) { out.hidden = false; out.textContent = e.message; b.textContent = 'retry'; }
      b.disabled = false;
    });
    install.replaceChildren(el('span', '', `claude isn't installed on ${h} `), b, out);
    valid();
  };
  host.addEventListener('change', () => { dir.value = dirs[host.value] || dir.value; picker.hidden = true; check(); });
  browse.addEventListener('click', () => { picker.hidden = !picker.hidden; if (!picker.hidden) browseAt(picker, host.value, '', (p) => { dir.value = p; picker.hidden = true; valid(); }); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (goBtn.disabled) return;
    goBtn.disabled = true;
    msg.textContent = 'starting';
    const d = dir.value.trim();
    dirs[host.value] = d;
    lsSet(DIR_LS, dirs);
    lsSet(`${DIR_LS}-host`, host.value);
    call('/api/code/sessions', 'POST', { host: host.value, dir: d, model: model.value, perm: perm.value, prompt: prompt.value.trim() })
      .then((r) => {
        cd.list = [r, ...cd.list.filter((s) => s.id !== r.id)];
        go(r.id);
        loadList();
      }, (err) => { msg.textContent = err.message; goBtn.disabled = false; });
  });
  valid();
  check();
  prompt.focus({ preventScroll: true });
}

// a folder picker over the user's login on the host, from its home down
async function browseAt(box, host, dir, pick) {
  const seq = (box.seq = (box.seq || 0) + 1);
  const head = el('div', 'cd-picker-head');
  const listing = el('ul', 'cd-picker-list');
  box.replaceChildren(head, listing);
  head.append(el('span', 'cd-picker-path', dir || '~'));
  listing.append(el('li', 'st-wait', 'loading'));
  let r;
  try { r = await call(`/api/code/ls?${qs({ host, dir })}`); } catch (e) {
    if (box.seq !== seq) return;
    const home = Object.assign(el('button', 'cd-mini', '~'), { type: 'button', title: 'home' });
    home.addEventListener('click', () => browseAt(box, host, '', pick));
    head.prepend(home);
    listing.replaceChildren(el('li', 'cd-bad', e.message));
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
function openBrowser(host, dir) {
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
  const key = (e) => { if (e.key === 'Escape' && wrap.isConnected) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', key, true);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  const shut = Object.assign(el('button', 'cd-mini', 'close'), { type: 'button' });
  shut.addEventListener('click', close);
  const nav = async (d) => {
    const n = ++seq;
    head.replaceChildren(el('span', 'cd-host', host), el('span', 'cd-picker-path', d || '~'), shut);
    listing.replaceChildren(el('li', 'st-wait', 'loading'));
    let r;
    try { r = await call(`/api/code/ls?${qs({ host, dir: d })}`); } catch (e) {
      if (n === seq) listing.replaceChildren(el('li', 'cd-bad', e.message));
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
      const row = Object.assign(el(e.dir ? 'button' : 'div', `cd-browse-row${e.dir ? ' dir' : ''}`), e.dir ? { type: 'button' } : {});
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

function codeWatch(on) {
  cd.on = on;
  clearInterval(cd.tick);
  cd.tick = 0;
  if (!on) {
    for (const t of cd.logs.values()) { t.closed = true; t.sock?.close(); t.sock = null; }
    return;
  }
  loadOpts(true).then(() => paintHead());
  loadList().then(() => {
    if (cd.pick && cd.pick !== 'new' && !main.querySelector('.cd-log')) paintOne();
    else if (cd.pick !== 'new') { const t = cd.logs.get(cd.pick); if (t) { t.closed = false; connect(t); } }
  });
  cd.tick = setInterval(() => { if (!document.hidden && deskApps.has('code')) loadList(); }, LIST_MS);
}

// --- the anthropic token, in the agent menu: pasted, saved, cleared, never shown back ---

function codeToken(box) {
  box.className = 'dk-cl-sec cd-token';
  const title = el('div', 'dk-cl-sec-t', 'anthropic');
  const state = el('span', 'dk-cl-state', '…');
  title.append(' ', state);
  const inp = Object.assign(el('input', 'dk-cl-url cd-token-in'), { type: 'password', placeholder: 'sk-ant-oat…', autocomplete: 'off', spellcheck: false });
  inp.setAttribute('data-1p-ignore', '');
  inp.setAttribute('data-lpignore', 'true');
  const save = Object.assign(el('button', 'dk-cl-key', 'save token'), { type: 'button' });
  const clear = Object.assign(el('button', 'dk-cl-key quiet', 'clear'), { type: 'button' });
  const hint = el('div', 'cd-token-hint');
  hint.innerHTML = 'run <code>claude setup-token</code> in a terminal and paste the token, for opus, sonnet and haiku in code';
  const bar = el('div', 'dk-cl-bar cd-token-bar');
  bar.append(inp, save, clear);
  box.replaceChildren(title, hint, bar);
  const paint = (on) => {
    state.textContent = on ? 'connected' : 'not connected';
    state.dataset.state = on ? 'online' : 'off';
    clear.hidden = !on;
    inp.placeholder = on ? 'paste a new token to replace it' : 'sk-ant-oat…';
  };
  const put = async (token) => {
    save.disabled = clear.disabled = true;
    try {
      const r = await call('/api/me/anthropic', 'POST', { token });
      inp.value = '';
      paint(!!r.anthropic);
      if (cd.opts) cd.opts.anthropic = !!r.anthropic;
      loadOpts(true).then(() => { headSig = ''; paintHead(); });
    } catch (e) { state.textContent = e.message; state.dataset.state = 'off'; }
    save.disabled = clear.disabled = false;
  };
  inp.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && inp.value.trim()) put(inp.value.trim()); });
  save.addEventListener('click', () => { if (inp.value.trim()) put(inp.value.trim()); else inp.focus(); });
  clear.addEventListener('click', () => put(''));
  call('/api/code/options').then((o) => { cd.opts = o; paint(!!o.anthropic); }, () => paint(false));
}

// a file's path in a tool card opened in the editor when it sits in a share
view.addEventListener('dblclick', (e) => {
  const a = e.target.closest('.cd-tool-arg');
  const card = e.target.closest('.cd-tool');
  const r = rec();
  if (!a || !card || !r || !/cd-tool-(Read|Edit|MultiEdit|Write)\b/.test(card.className)) return;
  const sh = shareOf(r.host, a.textContent.replace(/ :\d.*$/, ''));
  if (sh) dkCode({ host: r.host, share: sh.loc.share, path: sh.rel, label: `${r.host}/${sh.rel}` });
});

export { codeToken, codeWatch };
