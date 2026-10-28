// attachments

import type { ChatFile, Person } from '@phosphorus/wire';
import { dkOpenApp } from '../../desktop/desk.ts';
import { el } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import { humanSize } from '../../lib/util.ts';
import { notesReadConv } from '../notes.ts';
import { setChatChip } from './commands.ts';
import { cancelCompose, composeVars } from './compose.ts';
import { chatReading, chOf, convHint, convName, convsVars, dmWith, news, paintConvs, readConv } from './convs.ts';
import { CHAT_KEEP, chatNote, convLines, mediaUrl, putLine } from './lines.ts';
import { popMenu } from './menus.ts';
import {
  type ChatLine,
  chatChip,
  chatFilesBtn,
  chatLog,
  chatStatus,
  chatText,
  chatTitle,
  chatTyping,
  colorFor,
  formatDay,
  formatTime,
  stateVars,
} from './state.ts';

// everything shared in this conversation, newest first, with who and when
export const convFiles = (): [ChatFile, ChatLine][] =>
  (convLines.get(convsVars.conv) || [])
    .filter((m) => m.files && !m.gone)
    .flatMap((m) => m.files!.map((f): [ChatFile, ChatLine] => [f, m]))
    .reverse();

export function paintFiles() {
  const n = convFiles().length;
  chatFilesBtn.hidden = !n;
  chatFilesBtn.querySelector('.n')!.textContent = n > 99 ? '99+' : String(n);
  chatFilesBtn.title = `${n} attachment${n === 1 ? '' : 's'} here`;
}

export function openFiles() {
  const list = convFiles().slice(0, 50);
  if (!list.length) {
    chatNote('nothing shared');
    return;
  }
  popMenu(
    chatFilesBtn,
    `attachments · ${convFiles().length}`,
    list.map(([f, m]) => ({
      label: f.name,
      href: mediaUrl(f),
      sub: `${humanSize(f.size || 0)} · ${m.name === st.name ? 'you' : m.name} · ${formatDay(m.timestamp)} ${formatTime(m.timestamp)}`,
      thumb: (f.type || '').startsWith('image/') ? mediaUrl(f) : '',
    })),
  );
}
chatFilesBtn.addEventListener('click', openFiles);

// who's typing here, never this browser's own name
export function typers(c: string): string[] {
  const dm = dmWith(c);
  return stateVars.people
    .filter(
      (p) => p.name !== st.name && p.typing && (dm ? p.name === dm && p.typing === `dm:${st.name}` : p.typing === c),
    )
    .map((p) => p.name);
}

export function paintTyping() {
  const who = [...new Set(typers(convsVars.conv))];
  chatTyping.textContent = '';
  if (!who.length) return;
  const text = who.length === 1 ? `${who[0]} typing` : `${who.length} typing`;
  chatTyping.append(text, el('span', 'dots'));
}

// the header's names, and the line under the box: who and where this is
export function paintStatus() {
  chatStatus.classList.toggle('online', stateVars.chatOnline);
  const label = chatStatus.querySelector('.label')!;
  label.textContent = '';
  if (!stateVars.chatOnline) {
    label.textContent = 'offline';
    return;
  }
  const dm = dmWith(convsVars.conv);
  const who = (p: Person) => {
    const span = el('span', 'who', p.name);
    span.style.color = p.color || colorFor(p.name);
    if (p.host) span.title = `${p.name}: ${p.host}`;
    return span;
  };
  if (dm) {
    const p = stateVars.people.find((x) => x.name === dm);
    label.append(p ? who(p) : el('span', 'who off', dm), el('span', 'st-dim', p ? ` on ${p.host}` : ' offline'));
  } else {
    const uniq = [...new Map(stateVars.people.map((p) => [p.name, p])).values()];
    if (!uniq.length) label.textContent = 'nobody online';
    for (const p of uniq) label.append(who(p));
  }
  paintTyping();
}

export function renderConv() {
  chatLog.replaceChildren();
  delete chatLog.dataset.day;
  const dm = dmWith(convsVars.conv);
  if (dm) chatNote('private');
  else if (chOf(convsVars.conv) && !convLines.get(convsVars.conv)?.length) chatNote('empty');
  for (const m of (convLines.get(convsVars.conv) || []).slice(-CHAT_KEEP)) putLine(m);
  // unread since last here, under a rule
  if (convsVars.freshFrom > 0) {
    const msgs = [...chatLog.querySelectorAll('li.msg')];
    const first = msgs[Math.max(0, msgs.length - convsVars.freshFrom)];
    if (first) first.before(el('li', 'fresh', `${convsVars.freshFrom} new`));
  }
  chatLog.scrollTop = chatLog.scrollHeight;
  stateVars.chatPinned = true;
}

export function setConv(c: string): void {
  const was = convsVars.conv;
  convsVars.conv = c;
  convsVars.freshFrom = news.get(c) || 0;
  readConv(c);
  if (chatReading(c)) notesReadConv(c);
  if (was !== c) {
    cancelCompose();
    setChatChip('');
    composeVars.typingSent = '';
  }
  chatTitle.querySelector('.chat-title-text')!.textContent = convName(convsVars.conv);
  if (!chatChip.textContent) chatText.placeholder = convHint();
  renderConv();
  paintConvs();
  paintStatus();
  paintFiles();
}

// the chat app up, on this conversation
export function openConv(c: string): void {
  dkOpenApp('chat');
  setConv(c);
}
