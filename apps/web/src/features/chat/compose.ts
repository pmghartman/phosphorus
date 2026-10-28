// typing
import { el } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import type { ChatFile } from '@phosphorus/wire';
import { copyText, humanSize } from '../../lib/util.ts';
import { dkCode } from '../../desktop/deskfiles.ts';
import { autoGrowChatText, setChatChip, syncSend } from './commands.ts';
import { convsVars } from './convs.ts';
import { REACTIONS, keyOf, lines } from './lines.ts';
import { closePop, popMenu, type PopItem } from './menus.ts';
import { chatAttach, chatAtts, chatBar, chatChip, chatDrop, chatFile, chatLog, chatPanel, chatText, joined, send, type ChatLine } from './state.ts';

// where a key went down, said again every few seconds while it keeps going
export const TYPING_EVERY_MS = 3000;

// the module's variables other modules set
export const composeVars = {
  typingSent: '',
  // the line being answered or rewritten, shown over the box until sent or esc
  replyTo: null as ChatLine | null,
  // uploaded the moment they're picked, pasted or dropped, sent with the next line
  atts: [] as Att[],
};
export let typingAt = 0;
export function typingTick() {
  const busy = chatText.value.trim() && !chatText.value.startsWith('/') && !chatChip.textContent;
  const where = busy ? convsVars.conv : '';
  if (where === composeVars.typingSent && (!where || Date.now() - typingAt < TYPING_EVERY_MS)) return;
  composeVars.typingSent = where;
  typingAt = Date.now();
  send({ type: 'typing', conv: where });
}

// one picked, pasted or dropped: its upload, then the server's meta for the line
export interface Att { file: File; state: 'up' | 'done' | 'err'; pct: number; meta: ChatFile | null; error: string; xhr?: XMLHttpRequest | null }

export function paintAtts() {
  chatAtts.hidden = !composeVars.atts.length;
  chatAtts.replaceChildren(...composeVars.atts.map((a) => {
    const li = el('li', `att ${a.state}`);
    li.append(el('span', 'att-name', a.file.name), el('span', 'att-state', a.state === 'up' ? `${a.pct}%` : a.state === 'err' ? a.error : humanSize(a.file.size)));
    const x = Object.assign(el('button', 'att-x', '×'), { type: 'button', title: 'remove' });
    x.addEventListener('click', () => { a.xhr?.abort(); composeVars.atts = composeVars.atts.filter((b) => b !== a); paintAtts(); syncSend(); });
    li.append(x);
    return li;
  }));
  syncSend();
}

export function addFiles(list: File[]) {
  if (!joined()) return;
  for (const file of list) {
    const a: Att = { file, state: 'up', pct: 0, meta: null, error: '' };
    const xhr = new XMLHttpRequest();
    a.xhr = xhr;
    xhr.open('POST', `/api/chat/upload?name=${encodeURIComponent(file.name)}&type=${encodeURIComponent(file.type || '')}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { a.pct = Math.round((e.loaded / e.total) * 100); paintAtts(); } };
    xhr.onload = () => {
      let body: Record<string, any> = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status === 200 && body.id) { a.state = 'done'; a.meta = body as ChatFile; } else { a.state = 'err'; a.error = body.error || `failed (${xhr.status})`; }
      a.xhr = null;
      paintAtts();
    };
    xhr.onerror = () => { a.state = 'err'; a.error = 'upload failed'; a.xhr = null; paintAtts(); };
    xhr.send(file);
    composeVars.atts.push(a);
  }
  paintAtts();
  chatText.focus();
}

chatAttach.addEventListener('click', () => chatFile.click());
chatFile.addEventListener('change', () => { addFiles([...chatFile.files!]); chatFile.value = ''; });
chatText.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(files);
});
// anything dragged over the panel, its own overlay until dropped or gone
export let dragDepth = 0;
export const dragsFiles = (e: DragEvent) => [...(e.dataTransfer?.types || [])].includes('Files');
chatPanel.addEventListener('dragenter', (e) => {
  if (!dragsFiles(e) || !joined()) return;
  dragDepth += 1;
  chatDrop.hidden = false;
});
chatPanel.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) chatDrop.hidden = true; });
chatPanel.addEventListener('dragover', (e) => { if (dragsFiles(e)) e.preventDefault(); });
chatPanel.addEventListener('drop', (e) => {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  chatDrop.hidden = true;
  addFiles([...e.dataTransfer!.files]);
});

export let editing: ChatLine | null = null;

export function paintBar() {
  const m = composeVars.replyTo || editing;
  chatBar.hidden = !m;
  if (!m) return;
  const t = (m.edited ?? m.text) || '';
  chatBar.replaceChildren(
    el('span', 'bar-kind', editing ? 'editing' : `replying to ${m.name}`),
    el('span', 'bar-text', t.replace(/\s+/g, ' ').slice(0, 100)),
    el('span', 'bar-esc', 'esc cancel'),
  );
}

export function cancelCompose() {
  if (editing) { chatText.value = ''; autoGrowChatText(); }
  composeVars.replyTo = null;
  editing = null;
  paintBar();
}

export function startEdit(m: ChatLine) {
  composeVars.replyTo = null;
  editing = m;
  setChatChip('');
  chatText.value = m.edited ?? m.text ?? '';
  autoGrowChatText();
  paintBar();
  chatText.focus();
}

chatLog.addEventListener('click', (e) => {
  const b = (e.target as Element).closest('[data-act]') as HTMLElement | null;
  if (!b) return;
  const li = b.closest('li') as HTMLElement | null;
  const m = b.dataset.act === 'goto' ? lines.get(b.dataset.ref!) : lines.get(li?.dataset.key!);
  if (!m) return;
  const act = b.dataset.act;
  if (act === 'goto') {
    const t = chatLog.querySelector(`li[data-key="${CSS.escape(b.dataset.ref!)}"]`) as HTMLElement | null;
    if (!t) return;
    t.scrollIntoView({ block: 'center', behavior: 'smooth' });
    t.classList.remove('flash');
    void t.offsetWidth;
    t.classList.add('flash');
  } else if (act === 'show') {
    if (m.file) dkCode(m.file);
  } else if (act === 'react') react(m, b.dataset.emoji!);
  else if (act === 'reply') startReply(m);
  else if (act === 'more') lineMenu(li!, m, b);
});

export function startReply(m: ChatLine) {
  editing = null;
  composeVars.replyTo = m;
  paintBar();
  chatText.focus();
}

export function react(m: ChatLine, emoji: string) {
  const on = m.reacts?.get(`${st.name}\n${emoji}`)?.on;
  send({ type: 'react', ref: keyOf(m), emoji, on: !on });
}

// right click, or a long press on a phone: react, reply, edit, delete, on any line
chatLog.addEventListener('contextmenu', (e) => {
  const li = (e.target as Element).closest('li.msg[data-acts]') as HTMLElement | null;
  const m = li && lines.get(li.dataset.key!);
  if (!m || (e.target as Element).closest('a')) return;
  e.preventDefault();
  lineMenu(li!, m, li!, { x: e.clientX, y: e.clientY });
});

// a line's menu: reactions over reply, edit, delete; under the anchor or at the pointer
export function lineMenu(li: HTMLElement, m: ChatLine, anchor: HTMLElement, at: { x: number; y: number } | null = null) {
  const mine = li.dataset.acts === 'mine';
  const items: PopItem[] = [{ label: 'reply', act: () => startReply(m) }];
  const text = m.edited ?? m.text;
  if (text) items.push({ label: 'copy', act: () => copyText(text).catch(() => {}) });
  if (mine && (!m.kind || m.kind === 'dm')) items.push({ label: 'edit', act: () => startEdit(m) });
  if (mine) items.push({ label: 'delete', sub: 'for everyone', danger: true, confirm: 'delete it?', act: () => send({ type: 'delete', ref: keyOf(m) }) });
  const row = el('div', 'pop-reacts');
  for (const r of REACTIONS) {
    const x = Object.assign(el('button', m.reacts?.get(`${st.name}\n${r}`)?.on ? 'on' : '', r), { type: 'button' });
    x.addEventListener('click', () => { react(m, r); closePop(false); });
    row.append(x);
  }
  popMenu(anchor, row, items, 0, at);
}
