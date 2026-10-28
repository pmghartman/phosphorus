// one session: header, transcript, todos, composer
import { wsBase } from '../../lib/api.ts';
import { el } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import type { CodeModel, CodeOptions, CodeSession, CodeWsMessage } from '@phosphorus/wire';
import { esc } from '../../lib/util.ts';
import { dkTerminal } from '../../desktop/desk.ts';
import { makeComposer } from './composer.ts';
import { claudeEv, flushLive } from './events.ts';
import { drawer, main } from './frame.ts';
import { loadList, paintList, rec } from './list.ts';
import { openBrowser } from './newsession.ts';
import { permCard } from './perms.ts';
import { GL, PERMS, call, cd, kfmt, live, provOf, sapi, shQuote, svg, tilde, type Transcript, view } from './state.ts';
import { paintTodos } from './todos.ts';

// the module's variables other modules set
export const sessionVars = {
  head: null as HTMLElement | null,
  composer: null as { node: HTMLElement; text: HTMLTextAreaElement; state: (r: CodeSession | null) => void } | null,
  headSig: '',
};

export function paintOne() {
  const id = cd.pick;
  let t = cd.logs.get(id);
  if (!t) {
    t = { id, node: el('div', 'cd-log'), seq: 0, cards: new Map(), live: [], perms: new Map(), todos: [], sock: null, retry: 0, lastErr: '' };
    t.node.append(el('div', 'st-wait cd-wait', 'loading'));
    cd.logs.set(id, t);
  }
  t.closed = false;
  sessionVars.head = el('div', 'cd-head');
  sessionVars.headSig = '';
  const todo = el('div', 'cd-todos');
  sessionVars.composer = makeComposer(t);
  main.replaceChildren(sessionVars.head, t.node, todo, sessionVars.composer.node);
  t.todoEl = todo;
  paintTodos(t);
  paintHead();
  connect(t);
  requestAnimationFrame(() => { t!.node.scrollTop = t!.node.scrollHeight; });
  if (!view.closest('[hidden]')) sessionVars.composer.text.focus({ preventScroll: true });
}

export function sideBtn(): HTMLButtonElement {
  const b = Object.assign(el('button', 'cd-icon cd-side-btn'), { type: 'button', title: 'sessions', ariaLabel: 'sessions' });
  b.innerHTML = svg(GL.side!);
  b.addEventListener('click', () => drawer(!cd.drawer));
  return b;
}

// the share holding a host's absolute folder, its path inside it
export function shareOf(host: string, dir: string) {
  const shares = st.hostsInfo[String(host).toLowerCase()]?.files?.shares || [];
  const clean = (p: unknown) => String(p || '').replace(/\/+$/, '');
  const d = clean(dir);
  const sh = shares.filter((x) => x.label && (d === clean(x.label) || d.startsWith(`${clean(x.label)}/`)))
    .sort((a, b) => clean(b.label).length - clean(a.label).length)[0];
  if (!sh) return null;
  return { loc: { host, share: sh.id, root: sh.label, perms: sh.perms || '' }, rel: d.slice(clean(sh.label).length + 1) };
}

export function paintHead() {
  const r = rec();
  if (!sessionVars.head || !r || cd.pick === 'new') return;
  const opts = cd.opts;
  const sig = JSON.stringify([r, opts, cd.renaming, !!dk.creds?.has(r.host)]);
  if (sig === sessionVars.headSig) return;
  sessionVars.headSig = sig;
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
  sessionVars.head.replaceChildren(top, bar);
  sessionVars.composer?.state(r);
}

// the models by provider; lock, a running session's, the other provider's
// shown but off: a switch across is a new session's
export function modelSelect(opts: CodeOptions | null, cur: string, lock?: boolean): HTMLSelectElement {
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
export function say(text: string) {
  const m = main.querySelector('.cd-msg') as (HTMLElement & { t?: ReturnType<typeof setTimeout> }) | null;
  if (m) { m.textContent = text; clearTimeout(m.t); m.t = setTimeout(() => { m.textContent = ''; }, 6000); }
}

export function connect(t: Transcript) {
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

export function take(t: Transcript, m: CodeWsMessage) {
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

export function addNote(t: Transcript, kind: string, text: string): HTMLElement {
  const n = el('div', `cd-note cd-note-${kind}`);
  n.append(el('span', 'cd-note-tag', kind), el('span', 'cd-note-text', text));
  t.node.append(n);
  return n;
}
