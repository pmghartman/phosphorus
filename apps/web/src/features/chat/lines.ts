// the log as it came in
import { codeCopies, el } from '../../lib/dom.ts';
import { fitMath, renderMd } from '../../lib/md.ts';
import { dk, st } from '../../lib/state.ts';
import type { ChatFile, ChatMsg } from '@phosphorus/wire';
import { humanSize } from '../../lib/util.ts';
import { fileThere } from '../../desktop/deskfiles.ts';
import { dkFocus, dkWin } from '../../desktop/windows.ts';
import { convsVars } from './convs.ts';
import { findIn } from './find.ts';
import { chatFindInput, chatLog, colorFor, formatDay, formatTime, markMentions, nearBottom, toBottom, type ChatLine } from './state.ts';

// every line by host:seq, sorted into conversations: mesh, ch:<name>, dm:<name>,
// reactions, edits and deletes folded into the line they point at

export const MARKS = ['react', 'edit', 'delete'];
export const REACTIONS = ['+1', '✓', '✗', '?', '!', '♡'];
export const lines = new Map<string, ChatLine>();
export const convLines = new Map<string, ChatLine[]>();
// marks whose line hasn't come yet
export const orphanMarks = new Map<string, ChatMsg[]>();
// 500 drawn at a time, as the server keeps, no more for a tab open for days
export const CHAT_KEEP = 500;
// consecutive lines from one name within this run on under one header
export const GROUP_MS = 5 * 60 * 1000;
export let sysSeq = 0;

export const keyOf = (m: ChatMsg) => `${m.host}:${m.seq}`;
export const convOf = (m: ChatMsg) => (m.dm ? `dm:${m.name === st.name ? m.dm : m.name}` : m.ch ? `ch:${m.ch}` : 'mesh');

export function fold(k: ChatMsg): ChatLine | null {
  const m = lines.get(k.ref!);
  if (!m) {
    orphanMarks.set(k.ref!, [...(orphanMarks.get(k.ref!) || []), k]);
    return null;
  }
  if (k.kind === 'react') {
    const id = `${k.name}\n${k.emoji}`;
    const was = m.reacts!.get(id);
    if (!was || was.at <= k.timestamp) m.reacts!.set(id, { name: k.name, emoji: k.emoji!, on: k.on !== false, at: k.timestamp });
    return m;
  }
  if (k.name !== m.name) return null;
  if (k.kind === 'edit' && (!m.editAt || m.editAt <= k.timestamp)) { m.edited = k.text; m.editedHtml = k.html; m.editAt = k.timestamp; }
  if (k.kind === 'delete') m.gone = true;
  return m;
}

// a line into its conversation, kept in time order, null when already held
export function holdLine(m: ChatLine): string | null {
  const key = keyOf(m);
  if (lines.has(key)) return null;
  m.reacts = new Map();
  lines.set(key, m);
  const c = convOf(m);
  const list = convLines.get(c) || [];
  let at = list.length;
  while (at > 0 && list[at - 1]!.timestamp > m.timestamp) at -= 1;
  list.splice(at, 0, m);
  convLines.set(c, list);
  for (const k of orphanMarks.get(key) || []) fold(k);
  orphanMarks.delete(key);
  return c;
}

export function dropLine(key: string) {
  const m = lines.get(key);
  if (!m) return;
  lines.delete(key);
  const list = convLines.get(convOf(m));
  if (list) list.splice(list.indexOf(m), 1);
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(key)}"]`);
  if (!li) return;
  li.remove();
}

// a passing note in the log: joins, leaves, renames, a mistyped command
export function sysLine(c: string, text: string, cls = '') {
  const m: ChatLine = { host: 'sys', seq: ++sysSeq, timestamp: Date.now(), kind: 'sys', name: '', text, cls };
  holdLine(Object.assign(m, { ch: c.startsWith('ch:') ? c.slice(3) : undefined }));
  if (c === convsVars.conv) putLine(m, true);
}

// a note for this browser only, in whatever is on screen
export function chatNote(text: string): void {
  const li = Object.assign(document.createElement('li'), { className: 'sys', textContent: text });
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

export const mediaUrl = (f: ChatFile, dl?: boolean) => `/api/chat/media/${encodeURIComponent(f.host)}/${f.id}${dl ? '?dl' : ''}`;

export function filesEl(files: ChatFile[]): HTMLElement {
  const box = el('div', 'msg-files');
  for (const f of files) {
    const kind = (f.type || '').split('/')[0];
    if (kind === 'image') {
      const a = Object.assign(el('a', 'msg-img'), { href: mediaUrl(f), target: '_blank', rel: 'noopener', title: f.name });
      // on the desk, a window of its own in it; a plain link anywhere else
      a.addEventListener('click', (e) => {
        if (!dk.desk || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
        e.preventDefault();
        dkImageWin(f);
      });
      a.append(Object.assign(document.createElement('img'), { src: mediaUrl(f), alt: f.name, loading: 'lazy' }));
      box.append(a);
    } else if (kind === 'video' || kind === 'audio') {
      const v = Object.assign(document.createElement(kind), { src: mediaUrl(f), controls: true, preload: 'metadata', title: f.name });
      v.className = `msg-${kind}`;
      box.append(v);
    } else {
      const a = Object.assign(el('a', 'msg-file'), { href: mediaUrl(f, true), download: f.name, title: `download ${f.name}` });
      a.append(el('span', 'msg-file-icon', '▤'), el('span', 'msg-file-name', f.name), el('span', 'msg-file-size', humanSize(f.size || 0)));
      box.append(a);
    }
  }
  return box;
}

export function reactsEl(m: ChatLine): HTMLElement | null {
  if (!m.reacts) return null;
  const by = new Map<string, string[]>();
  for (const r of m.reacts.values()) if (r.on) by.set(r.emoji, [...(by.get(r.emoji) || []), r.name]);
  if (!by.size) return null;
  const row = el('div', 'msg-reacts');
  for (const e of REACTIONS) {
    const who = by.get(e);
    if (!who) continue;
    const b = Object.assign(el('button', `react${who.includes(st.name) ? ' on' : ''}`, `${e} ${who.length}`), { type: 'button', title: who.join(', ') });
    b.dataset.act = 'react';
    b.dataset.emoji = e;
    row.append(b);
  }
  return row;
}

// on hover, over the bubble's top corner: the reactions, reply, and the rest of the menu
// a line's menu marked by a faint ⋯ in its corner; right click or the ⋯ opens it
export function toolsEl(): HTMLElement {
  const more = Object.assign(el('button', 'msg-more', '⋯'), { type: 'button', title: 'options, or right click', ariaLabel: 'options' });
  more.dataset.act = 'more';
  return more;
}

export function quoteEl(ref: string): HTMLElement {
  const t = lines.get(ref);
  const q = el('button', 'msg-re');
  q.type = 'button';
  q.dataset.act = 'goto';
  q.dataset.ref = ref;
  if (!t || t.gone) { q.textContent = '↳ deleted'; return q; }
  const text = (t.edited ?? t.text) || (t.files ? `[${t.files.map((f) => f.name).join(', ')}]` : '');
  q.append('↳ ', Object.assign(el('b', '', t.name), { style: `color: ${t.color || colorFor(t.name)}` }), ` ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
  return q;
}

// a chat picture in a desk window, fit to it, a click for its own size and back
export function dkImageWin(f: ChatFile) {
  const w = dkWin(`img:${f.host}:${f.id}`, f.name, 'chat', 'svc');
  if (!w) return;
  const box = el('div', 'dk-imgview');
  const img = Object.assign(el('img'), { src: mediaUrl(f), alt: f.name, draggable: false });
  box.addEventListener('click', () => box.classList.toggle('full'));
  box.appendChild(img);
  w.body.appendChild(box);
  dkFocus(w);
}

// who a line is from: the agent from the user whose key it used
export const sender = (m: ChatMsg) => (m.via ? `${m.via} from ${m.name}` : m.name);

// the li for a line, prev the li before it, for its header and day
export function lineEl(m: ChatLine, prev: Element | null): HTMLLIElement {
  const li = el('li');
  li.dataset.key = keyOf(m);
  li.dataset.at = String(m.timestamp);
  if (m.kind === 'sys') {
    li.className = `sys ${m.cls || ''}`;
    li.textContent = m.text!;
    return li;
  }
  if (m.kind === 'show') {
    li.className = 'sys show';
    const by = m.via ? `${m.via} from ${m.name}` : m.name;
    li.append(m.name === st.name && !m.via ? `invited ${m.dm}: ` : m.name === st.name ? `${m.via} from you invited ${m.dm}: ` : `${by} invites: `, el('code', '', m.file?.label || m.text));
    if (m.file) {
      const b = Object.assign(el('button', 'show-open', 'open'), { type: 'button', title: 'open it in a shared editor' });
      b.dataset.act = 'show';
      li.append(' ', b);
      fileThere(m.file).then((there) => { if (!there) b.replaceWith(el('span', 'st-dim', '(gone)')); });
    }
    return li;
  }
  if (m.kind === 'topic') {
    li.className = 'sys';
    li.textContent = m.text ? `topic: ${m.text}` : `#${m.ch} opened`;
    return li;
  }
  // a line sent by an agent on someone's key: the agent's, in the agents' colours, from that user
  const agent = m.kind === 'model' || !!m.via;
  const mine = !agent && m.name === st.name;
  const real = !m.gone && !m.sending;
  li.className = `msg ${agent ? 'agent' : mine ? 'mine' : 'theirs'}`;
  // an agent's line on someone's key never grouped under their own
  li.dataset.who = m.via ? `${m.name}\u0000${m.via}` : m.name;
  li.style.setProperty('--who', m.color || colorFor(m.name));
  const p = prev?.matches?.('.msg') && (prev as HTMLElement);
  if (p && p.dataset.who === li.dataset.who && m.timestamp - Number(p.dataset.at) < GROUP_MS && !m.re) li.classList.add('cont');

  const head = el('div', 'msg-head');
  const user = el('span', 'user', mine ? 'you' : m.via || m.name);
  if (agent) user.classList.add('who-model');
  head.append(user);
  if (m.via) head.append(el('span', 'via', `from ${m.name}`));
  head.append(el('span', 'ts', formatTime(m.timestamp)));
  if (m.edited != null && !m.gone) head.append(el('span', 'edited', 'edited'));
  if (real) li.dataset.acts = mine ? 'mine' : 'theirs';
  li.append(head);

  const bubble = el('div', 'bubble');
  if (m.re && !m.gone) bubble.append(quoteEl(m.re));
  const text = el('div', 'text');
  const body = m.edited ?? m.text;
  const html = m.edited != null ? m.editedHtml : m.html;
  if (m.gone) {
    text.classList.add('gone');
    text.textContent = 'message deleted';
  } else if (body) {
    text.addEventListener('md-painted', () => codeCopies(text));
    renderMd(text, body, true, html);
  }
  if (!m.gone && markMentions(text)) li.classList.add('at-me');
  if (body || m.gone) bubble.append(text);
  if (m.files && !m.gone) bubble.append(filesEl(m.files));
  if (!body && !m.gone && m.files?.length && m.files.every((f) => (f.type || '').startsWith('image/'))) li.classList.add('just-img');
  li.append(bubble);
  if (real) bubble.append(toolsEl());
  const reacts = !m.gone && reactsEl(m);
  if (reacts) li.append(reacts);
  return li;
}

// a day's first line under its date, was: a spinner line it takes the place of
export function putLine(m: ChatLine, live?: boolean, was: Element | null = null): HTMLLIElement {
  const atBottom = live && nearBottom();
  let li: HTMLLIElement;
  if (was?.isConnected) {
    li = lineEl(m, was.previousElementSibling?.matches('.day') ? null : was.previousElementSibling);
    was.replaceWith(li);
  } else {
    const last = chatLog.lastElementChild;
    const day = formatDay(m.timestamp);
    if (chatLog.dataset.day !== day) {
      chatLog.dataset.day = day;
      chatLog.append(el('li', 'day', day));
    }
    li = lineEl(m, chatLog.lastElementChild?.matches('.day') ? null : last);
    chatLog.append(li);
  }
  // a model's answer popped in whole once it lands
  if (live && m.kind === 'model') li.classList.add('pop');
  while (chatLog.childElementCount > CHAT_KEEP) chatLog.firstElementChild!.remove();
  if (live && atBottom) toBottom();
  if (li.querySelector('.katex')) fitMath(li.querySelector('.text')!);
  if (chatFindInput.value) findIn(li);
  return li;
}

// a line drawn again in place, after a reaction, edit or delete
export function redrawLine(m: ChatLine) {
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(keyOf(m))}"]`);
  if (!li) return;
  const next = lineEl(m, li.previousElementSibling?.matches('.day') ? null : li.previousElementSibling);
  li.replaceWith(next);
  if (next.querySelector('.katex')) fitMath(next.querySelector('.text')!);
}
