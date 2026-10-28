// --- chat ------------------------------------------------------------
// one log, redrawn per conversation from what the socket handed over: the
// mesh and its channels, direct messages, and private phosphorus sessions kept in
// this browser. Bubbles: yours on the right, everyone else's on the left,
// phosphorus's replies the full width
import { codeCopies, el } from './dom.ts';
import { fitMath, renderMd } from './md.ts';
import { phosphorusHosts } from './mesh.ts';
import { away, bumpUnread, dropUnread, noteAdd, noteFor, notesReadConv, notifyChat } from './notes.ts';
import { codeName, codeTabs, editors, fileLabel, type EditorFile } from './shares.ts';
import { deskApps, dk, st } from './state.ts';
import type { ChannelMeta, ChatFile, ChatMsg, ChatWsMessage, Person, Reaction, ShowFile, UiAction } from './types.ts';
import { copyText, humanSize, loadJson } from './util.ts';
import { dkOpenApp, dkOpenTerminal, dkPressed } from './desktop/desk.ts';
import { dkCode, fileThere } from './desktop/deskfiles.ts';
import { deskBadge } from './desktop/taskbar.ts';
import { dkFocus, dkWin } from './desktop/windows.ts';

// a line as this browser holds it: the host's, with the marks folded into it, and its own
// drawing state
export interface ChatLine extends ChatMsg {
  reacts?: Map<string, Reaction>;
  edited?: string;
  editedHtml?: string;
  editAt?: number;
  gone?: boolean;
  live?: boolean;
  sending?: boolean;
  cls?: string;
}

export const chatPanel = document.getElementById('chat-panel')!;
const chatLog = document.getElementById('chat-log')!;
// phosphorus's [open a terminal on host](#term:host): a terminal window, never a navigation
chatPanel.addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a[href^="#term:"]');
  if (!a) return;
  e.preventDefault();
  const host = decodeURIComponent(a.getAttribute('href')!.slice(6));
  dkOpenTerminal(host);
});
const chatTitle = document.getElementById('chat-title')!;
const chatStatus = document.getElementById('chat-status')!;
const chatJoin = document.getElementById('chat-join') as HTMLFormElement;
export const chatName = document.getElementById('chat-name') as HTMLInputElement;
const chatJoinGo = document.getElementById('chat-join-go') as HTMLButtonElement;
const chatCompose = document.getElementById('chat-compose')!;
const chatForm = document.getElementById('chat-form') as HTMLFormElement;
export const chatText = document.getElementById('chat-text') as HTMLTextAreaElement;
const chatSend = document.getElementById('chat-send') as HTMLButtonElement;
const chatChip = document.getElementById('chat-chip')!;
const chatCmds = document.getElementById('chat-cmds')!;
const chatBar = document.getElementById('chat-bar')!;
const chatAtts = document.getElementById('chat-atts')!;
const chatAttach = document.getElementById('chat-attach')!;
const chatFile = document.getElementById('chat-file') as HTMLInputElement;
const chatTyping = document.getElementById('chat-typing')!;
const chatFind = document.getElementById('chat-find')!;
const chatFindInput = document.getElementById('chat-find-input') as HTMLInputElement;
const chatFindCount = document.getElementById('chat-find-count')!;
const chatDrop = document.getElementById('chat-drop')!;
export const cwList = document.getElementById('cw-list')!;
const cwMain = document.getElementById('cw-main')!;
// the chat's panel beside its conversations, in the chat app
cwMain.appendChild(chatPanel);
const chatFilesBtn = document.getElementById('chat-files-btn') as HTMLButtonElement;
const chatPop = document.getElementById('chat-pop')!;

// everyone on the mesh, peers merged in by the frontend
let people: Person[] = [];
let chatOnline = false;

const NAME_COLORS = [
  '#4f9eff', '#3fb950', '#f0883e', '#d2a8ff', '#ff7b72', '#79c0ff', '#ffa657',
  '#e3b341', '#ff9bce', '#39c5cf', '#db61a2', '#7ee787', '#d4a72c', '#ffa198',
];
const COLOR_NAMES = [
  'blue', 'green', 'orange', 'purple', 'red', 'skyblue', 'gold',
  'yellow', 'pink', 'teal', 'magenta', 'lime', 'amber', 'coral',
];

export function colorFor(n: string): string {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length]!;
}

// fast first, then backing off x1.5 (capped), most reconnects a blip
let reconnectDelay = 300;
const wsOpen = () => st.ws && st.ws.readyState === WebSocket.OPEN;
export const send = (body: Record<string, unknown>) => wsOpen() && st.ws!.send(JSON.stringify(body));
export const joined = () => !chatCompose.hidden;

const formatTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
function formatDay(ts: number): string {
  const d = new Date(ts);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(days > 300 ? { year: 'numeric' } : {}) });
}

// back on the tab: badge cleared, however many piled up
export function clearUnread(): void {
  if (chatReading(conv)) { stampRead(conv); notesReadConv(conv); }
  dropUnread();
}

document.addEventListener('visibilitychange', clearUnread);
window.addEventListener('focus', clearUnread);

// a conversation on screen and being read: no bell entry for its lines
export const chatReading = (c: string) => !away() && c === conv && (!dk.desk || deskApps.has('chat'));

// the log following its newest line, eased down rather than snapped, a jump
// past a screen (history, a conversation coming up) still snapped
let glide = 0;
const nearBottom = () => !!glide || chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 20;
function toBottom() {
  if (glide) return;
  const step = () => {
    const gap = chatLog.scrollHeight - chatLog.clientHeight - chatLog.scrollTop;
    if (gap <= 1 || gap > chatLog.clientHeight) { chatLog.scrollTop = chatLog.scrollHeight; glide = 0; return; }
    chatLog.scrollTop += Math.ceil(gap * 0.2);
    glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}
// the reader scrolling away ending the glide
for (const ev of ['wheel', 'touchmove']) chatLog.addEventListener(ev, () => { cancelAnimationFrame(glide); glide = 0; }, { passive: true });

// pinned while scrolled to the bottom, kept there by a resize
let chatPinned = true;
chatLog.addEventListener('scroll', () => { chatPinned = nearBottom(); });
// math refitted when the width moves or katex's fonts land
const refitMath = () => { for (const t of chatLog.querySelectorAll<HTMLElement>('.md')) if (t.querySelector('.katex')) fitMath(t); };
document.fonts.addEventListener('loadingdone', refitMath);
let chatWidth = 0;
new ResizeObserver(() => {
  if (chatLog.clientWidth !== chatWidth) { chatWidth = chatLog.clientWidth; refitMath(); }
  if (chatPinned) chatLog.scrollTop = chatLog.scrollHeight;
}).observe(chatLog);


// @name lit, outside code, true when it's this browser's own
function markMentions(el: HTMLElement): boolean {
  if (!st.name) return false;
  let me = false;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => ((n as Text).parentElement!.closest('code, pre, a, .katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const hits: Text[] = [];
  while (walk.nextNode()) if (walk.currentNode.nodeValue!.includes('@')) hits.push(walk.currentNode as Text);
  for (const t of hits) {
    const parts = t.nodeValue!.split(/(@[\w.-]+)/);
    if (parts.length < 2) continue;
    t.replaceWith(...parts.map((p, i) => {
      if (i % 2 === 0) return p;
      const s = Object.assign(document.createElement('span'), { className: 'mention', textContent: p });
      if (p.slice(1).toLowerCase() === st.name.toLowerCase()) { s.classList.add('me'); me = true; }
      return s;
    }));
  }
  return me;
}

// --- the log as it came in -------------------------------------------------------
// every line by host:seq, sorted into conversations: mesh, ch:<name>, dm:<name>,
// reactions, edits and deletes folded into the line they point at

const MARKS = ['react', 'edit', 'delete'];
const REACTIONS = ['+1', '✓', '✗', '?', '!', '♡'];
export const lines = new Map<string, ChatLine>();
const convLines = new Map<string, ChatLine[]>();
// marks whose line hasn't come yet
const orphanMarks = new Map<string, ChatMsg[]>();
// 500 drawn at a time, as the server keeps, no more for a tab open for days
const CHAT_KEEP = 500;
// consecutive lines from one name within this run on under one header
const GROUP_MS = 5 * 60 * 1000;
let sysSeq = 0;

const keyOf = (m: ChatMsg) => `${m.host}:${m.seq}`;
const convOf = (m: ChatMsg) => (m.dm ? `dm:${m.name === st.name ? m.dm : m.name}` : m.ch ? `ch:${m.ch}` : 'mesh');

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
function holdLine(m: ChatLine): string | null {
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

function dropLine(key: string) {
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
function sysLine(c: string, text: string, cls = '') {
  const m: ChatLine = { host: 'sys', seq: ++sysSeq, timestamp: Date.now(), kind: 'sys', name: '', text, cls };
  holdLine(Object.assign(m, { ch: c.startsWith('ch:') ? c.slice(3) : undefined }));
  if (c === conv) putLine(m, true);
}

// a note for this browser only, in whatever is on screen
export function chatNote(text: string): void {
  const li = Object.assign(document.createElement('li'), { className: 'sys', textContent: text });
  chatLog.appendChild(li);
  chatLog.scrollTop = chatLog.scrollHeight;
}

// --- one line ---------------------------------------------------------------------

const mediaUrl = (f: ChatFile, dl?: boolean) => `/api/chat/media/${encodeURIComponent(f.host)}/${f.id}${dl ? '?dl' : ''}`;

function filesEl(files: ChatFile[]): HTMLElement {
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

function reactsEl(m: ChatLine): HTMLElement | null {
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
function toolsEl(): HTMLElement {
  const more = Object.assign(el('button', 'msg-more', '⋯'), { type: 'button', title: 'options, or right click', ariaLabel: 'options' });
  more.dataset.act = 'more';
  return more;
}

function quoteEl(ref: string): HTMLElement {
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
function dkImageWin(f: ChatFile) {
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
const sender = (m: ChatMsg) => (m.via ? `${m.via} from ${m.name}` : m.name);

// the li for a line, prev the li before it, for its header and day
function lineEl(m: ChatLine, prev: Element | null): HTMLLIElement {
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
function putLine(m: ChatLine, live?: boolean, was: Element | null = null): HTMLLIElement {
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
function redrawLine(m: ChatLine) {
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(keyOf(m))}"]`);
  if (!li) return;
  const next = lineEl(m, li.previousElementSibling?.matches('.day') ? null : li.previousElementSibling);
  li.replaceWith(next);
  if (next.querySelector('.katex')) fitMath(next.querySelector('.text')!);
}

// --- conversations -------------------------------------------------------------
// mesh and the channels anyone opens, and people's dms (kept by the mesh,
// shown to their two ends)

const CHANNELS_KEY = 'phosphorus-chat-channels';
// mesh, ch:<name> or dm:<name>
let conv = 'mesh';
// the conversation on screen
export const convNow = () => conv;
// channels opened here, kept listed before anyone has said a word in them
let myChannels = loadJson<string[]>(CHANNELS_KEY, []);
// channels left here, by when, hidden until a line comes after
const LEFT_KEY = 'phosphorus-chat-left';
let leftChannels = loadJson<Record<string, number>>(LEFT_KEY, {}) || {};
const saveChannels = () => {
  try {
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(myChannels));
    localStorage.setItem(LEFT_KEY, JSON.stringify(leftChannels));
  } catch {}
};
// unread lines by conversation
export const news = new Map<string, number>();
// the conversation the divider was drawn for, and how many lines it marks
let freshFrom = 0;

const dmWith = (c: string) => (c.startsWith('dm:') ? c.slice(3) : '');
const chOf = (c: string) => (c.startsWith('ch:') ? c.slice(3) : '');
const convName = (c: string) => (c === 'mesh' ? '#mesh' : chOf(c) ? `#${chOf(c)}` : dmWith(c) ? `@${dmWith(c)}` : c);
const convHint = () => `message ${convName(conv)}`;

// per conversation, the newest line seen here, kept so a tab opened later
// counts what came while it was closed
const READ_KEY = 'phosphorus-chat-readat';
const readAt: Record<string, number> = (() => { try { const v = JSON.parse(localStorage.getItem(READ_KEY)!); return v && typeof v === 'object' ? v : {}; } catch { return {}; } })();

function stampRead(c: string) {
  const at = lastAt(c);
  if (readAt[c]! >= at) return;
  readAt[c] = at;
  try { localStorage.setItem(READ_KEY, JSON.stringify(readAt)); } catch {}
}

// a conversation read: its count gone, its place kept
function readConv(c: string) {
  news.delete(c);
  stampRead(c);
}

function noteNews(c: string) {
  if (c === conv && !away() && chatPanel.offsetParent) { stampRead(c); return; }
  news.set(c, (news.get(c) || 0) + 1);
  paintConvs();
}

// each channel's mesh-wide meta: when made, its topic, its last close
let chMetas: Record<string, ChannelMeta> = {};
const chOpen = (m: ChannelMeta) => !!m.created && m.created > (m.closedAt || 0);

// every channel: mesh, those open mesh-wide or with lines, those opened here
function channels(): string[] {
  const seen = [...convLines.keys()].filter((c) => c.startsWith('ch:') && convLines.get(c)!.length).map(chOf);
  const open = Object.keys(chMetas).filter((ch) => chOpen(chMetas[ch]!));
  const shown = [...seen, ...open].filter((ch) => !(leftChannels[ch]! >= Math.max(lastAt(`ch:${ch}`), chMetas[ch]?.created || 0)));
  return [...new Set([...shown, ...myChannels])].sort();
}

const lastAt = (c: string) => convLines.get(c)?.at(-1)?.timestamp || 0;
function topicOf(c: string): string {
  const m = chMetas[chOf(c)];
  if (m && chOpen(m)) return m.topic || '';
  return convLines.get(c)?.findLast((x) => x.kind === 'topic' && x.text)?.text || '';
}

// everyone to dm, by name so a new line never moves a chat
function dmNames(): string[] {
  const talked = [...convLines.keys()].map(dmWith).filter(Boolean);
  return [...new Set([...talked, ...people.map((p) => p.name)])].filter((n) => n !== st.name)
    .sort((a, b) => a.localeCompare(b));
}

// the conversations in the list's order
const convOrder = () => ['mesh', ...channels().map((ch) => `ch:${ch}`), ...dmNames().map((n) => `dm:${n}`)];

// ctrl+↑↓: the one above or below in the list, wrapping
export function stepConv(step: number): void {
  const order = convOrder();
  const at = order.indexOf(conv);
  openConv(order[(Math.max(0, at) + step + order.length) % order.length]!);
}

// the list, in the tab beside the chat or the corner's menu
function convItems(): HTMLElement[] {
  const online = new Map(people.map((p) => [p.name, p]));
  const names = dmNames();
  const head = (text: string, add?: [string, () => void]) => {
    const h = el('div', 'cw-head', text);
    if (add) {
      const b = Object.assign(el('button', 'cw-add', '+'), { type: 'button', title: add[0] });
      b.addEventListener('click', add[1]);
      h.append(b);
    }
    return h;
  };
  const item = (c: string, label: string, { sub = '', dot, hue }: { sub?: string; dot?: boolean; hue?: string } = {}) => {
    const row = el('div', 'cw-row');
    const b = Object.assign(el('button', `cw-item${c === conv ? ' on' : ''}`), { type: 'button' });
    b.dataset.conv = c;
    if (dot !== undefined) b.append(Object.assign(el('span', `cw-dot${dot ? ' up' : ''}`), { title: dot ? 'online' : 'offline' }));
    const l = el('span', 'cw-name', label);
    if (hue) l.style.color = hue;
    b.append(l);
    if (typers(c).length) b.append(el('span', 'cw-typing', '···'));
    else if (sub) b.append(el('span', 'cw-sub', sub));
    const k = news.get(c);
    if (k && c !== conv) b.append(el('span', 'chat-badge', `${k > 99 ? '99+' : k}`));
    const more = Object.assign(el('button', 'cw-more', '…'), { type: 'button', title: `${convName(c)}: more (.)`, tabIndex: -1 });
    more.dataset.conv = c;
    row.append(b, more);
    return row;
  };
  const hueOf = (n: string) => online.get(n)?.color || convLines.get(`dm:${n}`)?.findLast((m) => m.name === n)?.color || colorFor(n);
  return [
    head('channels', ['open a channel', () => startCommand(CHANNEL_CHIP[0])]),
    item('mesh', '# mesh', { sub: `${people.length} online` }),
    ...channels().map((ch) => item(`ch:${ch}`, `# ${ch}`)),
    head('direct'),
    ...names.map((n) => item(`dm:${n}`, n, { dot: online.has(n), hue: hueOf(n) })),
  ];
}

function paintConvs() {
  const total = [...news].reduce((n, [c, k]) => n + (c === conv ? 0 : k), 0);
  deskBadge(total);
  (chatTitle.querySelector('.chat-title-dot') as HTMLElement).hidden = !total;
  cwList.replaceChildren(...convItems());
}

for (const list of [cwList]) {
  list.addEventListener('click', (e) => {
    const more = (e.target as Element).closest('.cw-more') as HTMLElement | null;
    if (more) { e.stopPropagation(); convMenu(more.dataset.conv!, more); return; }
    const b = (e.target as Element).closest('.cw-item') as HTMLElement | null;
    if (!b) return;
    setConv(b.dataset.conv!);
    (joined() ? chatText : chatName).focus();
  });
  // right click, or a long press on a phone: the same menu
  list.addEventListener('contextmenu', (e) => {
    const b = (e.target as Element).closest('.cw-item') as HTMLElement | null;
    if (!b) return;
    e.preventDefault();
    convMenu(b.dataset.conv!, b);
  });
}

// --- popup menus ------------------------------------------------------------------
// one small menu at a time, by whatever opened it: a conversation's actions or
// the attachments. ↑↓ to move, enter to pick, esc back to where it came from,
// a destructive pick asking once more before it goes

// one item of the menu: a link, or an action, a destructive one asked again
interface PopItem { label: string; sub?: string; key?: string; danger?: boolean; confirm?: string; href?: string; thumb?: string; act?: () => void }

let popFrom: HTMLElement | null = null;
function closePop(refocus: boolean) {
  if (chatPop.hidden) return;
  chatPop.hidden = true;
  if (refocus && popFrom?.isConnected) popFrom.focus();
  popFrom = null;
}

// title: a heading, or a node over the items; at: a right click's point to open at
function popMenu(anchor: HTMLElement, title: string | HTMLElement | null, items: PopItem[], focusAt = 0, at: { x: number; y: number } | null = null) {
  if (!chatPop.hidden && popFrom === anchor) { closePop(true); return; }
  closePop(false);
  popFrom = anchor;
  const els = items.map((it) => {
    const b: HTMLElement = it.href
      ? Object.assign(el('a', 'pop-item'), { href: it.href, target: '_blank', rel: 'noopener noreferrer' })
      : Object.assign(el('button', 'pop-item'), { type: 'button' });
    if (it.danger) b.classList.add('danger');
    if (it.thumb) b.append(Object.assign(document.createElement('img'), { src: it.thumb, alt: '', loading: 'lazy', className: 'pop-thumb' }));
    const text = el('span', 'pop-text');
    text.append(el('span', 'pop-label', it.label));
    if (it.sub) text.append(el('span', 'pop-sub', it.sub));
    b.append(text);
    if (it.key) b.append(el('span', 'pop-key', it.key));
    b.addEventListener('click', (e) => {
      if (it.confirm && !b.classList.contains('armed')) {
        e.preventDefault();
        b.classList.add('armed');
        b.querySelector('.pop-label')!.textContent = it.confirm;
        return;
      }
      if (it.act) { e.preventDefault(); it.act(); }
      closePop(!it.href);
    });
    return b;
  });
  chatPop.replaceChildren(...(title ? [typeof title === 'string' ? el('div', 'pop-title', title) : title] : []), ...els);
  chatPop.hidden = false;
  // under the anchor, kept on screen, over it when there's no room below
  const r = at ? { left: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
  const w = chatPop.offsetWidth;
  const h = chatPop.offsetHeight;
  chatPop.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left))}px`;
  chatPop.style.top = `${r.bottom + 4 + h > innerHeight - 8 ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
  els[Math.min(focusAt, els.length - 1)]?.focus();
}

chatPop.addEventListener('keydown', (e) => {
  const items = [...chatPop.querySelectorAll<HTMLElement>('.pop-item')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  } else if (e.key === 'Escape' || e.key === 'Tab') {
    closePop(true);
  } else return;
  e.preventDefault();
  e.stopPropagation();
});
document.addEventListener('mousedown', (e) => {
  if (!chatPop.hidden && !chatPop.contains(e.target as Node) && !popFrom?.contains(e.target as Node)) closePop(false);
});
window.addEventListener('resize', () => closePop(false));

// what a conversation offers: read, leave, close or clear, the destructive one last
function convActions(c: string): PopItem[] {
  const read = news.get(c) && { label: 'mark read', act: () => { readConv(c); notesReadConv(c); paintConvs(); } };
  const ch = chOf(c);
  if (ch) {
    return [read, { label: 'open', act: () => openConv(c) },
      { label: 'leave', sub: 'hide it here until someone posts', act: () => leaveChannel(ch) },
      { label: 'close for everyone', sub: 'its history gone mesh-wide', key: 'd', danger: true, confirm: `close #${ch}?`, act: () => send({ type: 'close', ch }) },
    ].filter(Boolean) as PopItem[];
  }
  if (c === 'mesh') {
    return [read, { label: 'clear for everyone', sub: "#mesh's history gone mesh-wide", key: 'd', danger: true, confirm: 'clear all?', act: () => send({ type: 'clear' }) }].filter(Boolean) as PopItem[];
  }
  const dm = dmWith(c);
  return [read, { label: 'open', act: () => openConv(c) },
    dm && { label: 'delete conversation', sub: 'its history gone for you, on every host', key: 'd', danger: true, confirm: `delete your dms with ${dm}?`, act: () => deleteDm(dm) },
  ].filter(Boolean) as PopItem[];
}

// the mesh drops it from this name's history and sends that history again
function deleteDm(dm: string) {
  if (conv === `dm:${dm}`) setConv('mesh');
  news.delete(`dm:${dm}`);
  send({ type: 'hide-dm', with: dm });
}

function convMenu(c: string, anchor: HTMLElement, destructive?: boolean) {
  const items = convActions(c);
  popMenu(anchor, convName(c), items, destructive ? Math.max(0, items.findIndex((it) => it.danger)) : 0);
}

function leaveChannel(ch: string) {
  myChannels = myChannels.filter((x) => x !== ch);
  leftChannels[ch] = Date.now();
  saveChannels();
  if (conv === `ch:${ch}`) setConv('mesh');
  else paintConvs();
}

// a channel closed by anyone: its lines gone here too, off every list
function channelClosed(ch: string, by?: string) {
  const c = `ch:${ch}`;
  for (const m of convLines.get(c) || []) lines.delete(keyOf(m));
  convLines.delete(c);
  news.delete(c);
  myChannels = myChannels.filter((x) => x !== ch);
  saveChannels();
  if (conv === c) setConv('mesh');
  else paintConvs();
  sysLine('mesh', `#${ch} closed${by ? ` by ${by}` : ''}`);
}

// --- attachments ------------------------------------------------------------------

// everything shared in this conversation, newest first, with who and when
const convFiles = (): [ChatFile, ChatLine][] => (convLines.get(conv) || []).filter((m) => m.files && !m.gone)
  .flatMap((m) => m.files!.map((f): [ChatFile, ChatLine] => [f, m])).reverse();

function paintFiles() {
  const n = convFiles().length;
  chatFilesBtn.hidden = !n;
  chatFilesBtn.querySelector('.n')!.textContent = n > 99 ? '99+' : String(n);
  chatFilesBtn.title = `${n} attachment${n === 1 ? '' : 's'} here`;
}

function openFiles() {
  const list = convFiles().slice(0, 50);
  if (!list.length) { chatNote('nothing shared'); return; }
  popMenu(chatFilesBtn, `attachments · ${convFiles().length}`, list.map(([f, m]) => ({
    label: f.name, href: mediaUrl(f),
    sub: `${humanSize(f.size || 0)} · ${m.name === st.name ? 'you' : m.name} · ${formatDay(m.timestamp)} ${formatTime(m.timestamp)}`,
    thumb: (f.type || '').startsWith('image/') ? mediaUrl(f) : '',
  })));
}
chatFilesBtn.addEventListener('click', openFiles);

// who's typing here, never this browser's own name
function typers(c: string): string[] {
  const dm = dmWith(c);
  return people.filter((p) => p.name !== st.name && p.typing
    && (dm ? p.name === dm && p.typing === `dm:${st.name}` : p.typing === c)).map((p) => p.name);
}

function paintTyping() {
  const who = [...new Set(typers(conv))];
  chatTyping.textContent = '';
  if (!who.length) return;
  const text = who.length === 1 ? `${who[0]} typing` : `${who.length} typing`;
  chatTyping.append(text, el('span', 'dots'));
}

// the header's names, and the line under the box: who and where this is
function paintStatus() {
  chatStatus.classList.toggle('online', chatOnline);
  const label = chatStatus.querySelector('.label')!;
  label.textContent = '';
  if (!chatOnline) { label.textContent = 'offline'; return; }
  const dm = dmWith(conv);
  const who = (p: Person) => {
    const span = el('span', 'who', p.name);
    span.style.color = p.color || colorFor(p.name);
    if (p.host) span.title = `${p.name}: ${p.host}`;
    return span;
  };
  if (dm) {
    const p = people.find((x) => x.name === dm);
    label.append(p ? who(p) : el('span', 'who off', dm), el('span', 'st-dim', p ? ` on ${p.host}` : ' offline'));
  } else {
    const uniq = [...new Map(people.map((p) => [p.name, p])).values()];
    if (!uniq.length) label.textContent = 'nobody online';
    for (const p of uniq) label.append(who(p));
  }
  paintTyping();
}

function renderConv() {
  chatLog.replaceChildren();
  delete chatLog.dataset.day;
  const dm = dmWith(conv);
  if (dm) chatNote('private');
  else if (chOf(conv) && !convLines.get(conv)?.length) chatNote('empty');
  for (const m of (convLines.get(conv) || []).slice(-CHAT_KEEP)) putLine(m);
  // unread since last here, under a rule
  if (freshFrom > 0) {
    const msgs = [...chatLog.querySelectorAll('li.msg')];
    const first = msgs[Math.max(0, msgs.length - freshFrom)];
    if (first) first.before(el('li', 'fresh', `${freshFrom} new`));
  }
  chatLog.scrollTop = chatLog.scrollHeight;
  chatPinned = true;
}

export function setConv(c: string): void {
  const was = conv;
  conv = c;
  freshFrom = news.get(c) || 0;
  readConv(c);
  if (chatReading(c)) notesReadConv(c);
  if (was !== c) { cancelCompose(); setChatChip(''); typingSent = ''; }
  chatTitle.querySelector('.chat-title-text')!.textContent = convName(conv);
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

// --- incoming ---------------------------------------------------------------------

// a line in, live or from history: folded, held, drawn if on screen, noted if not
function takeLine(m: ChatLine, live: boolean) {
  if (MARKS.includes(m.kind!)) {
    const t = fold(m);
    if (t && live && convOf(t) === conv) redrawLine(t);
    if (t && live && m.kind === 'react' && t.name === st.name && m.name !== st.name && m.on !== false) notifyChat({ name: m.name, text: `reacted ${m.emoji}` }, false, { key: 'reactions', label: 'reactions', line: `${m.name} ${m.emoji}` }, convOf(t));
    return;
  }
  if (live) m.live = true;
  const ghost = live && m.name === st.name && sendingLines.find((g) => g.text === (m.text || '') && convOf(g) === convOf(m));
  const c = holdLine(m);
  if (ghost) settleSending(ghost, m, c);
  if (!c || !live) return;
  if (c === conv && !ghost) putLine(m, true);
  if (m.kind === 'topic') { paintConvs(); return; }
  // an invite to this browser's name, fresh: asked as a dialog and notified past the bell
  if (isInvite(m)) {
    showInvite(m);
    noteNews(c);
    bumpUnread();
    notifyChat({ name: `${m.name} invited you`, text: `to work on ${m.file!.label} together` }, true, null, c);
    return;
  }
  if (m.files && c === conv) paintFiles();
  if (m.name === st.name) { paintConvs(); return; }
  noteNews(c);
  bumpUnread();
  const text = m.text || (m.files ? `shared ${m.files.map((f) => f.name).join(', ')}` : '');
  const atMe = st.name && new RegExp(`@${st.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.text || '');
  // a mention its own entry; the rest by channel or person, none for the one being read
  const where = m.dm ? m.name : `#${m.ch || 'mesh'}`;
  notifyChat({ name: m.dm ? `${sender(m)} (direct)` : atMe ? `${sender(m)} mentioned you` : m.ch ? `${sender(m)} in #${m.ch}` : sender(m), text }, false,
    atMe ? null : { key: m.dm ? `dm:${m.name}` : where, label: where, line: m.dm ? text : `${m.name}: ${text}`, seen: chatReading(c) }, c);
}

// own lines drawn at once, swapped in place for the host's echo
const sendingLines: ChatLine[] = [];
const SENDING_MS = 10000;
let sendingSeq = 0;
function putSending(fields: Partial<ChatLine> & { text: string }) {
  const g: ChatLine = { host: 'sending', seq: sendingSeq += 1, timestamp: Date.now(), name: st.name, color: st.color || colorFor(st.name), sending: true, ...fields, text: fields.text.slice(0, 2000) };
  sendingLines.push(g);
  if (holdLine(g) === conv) putLine(g, true).classList.add('sending');
  setTimeout(() => {
    if (!sendingLines.includes(g)) return;
    sendingLines.splice(sendingLines.indexOf(g), 1);
    dropLine(keyOf(g));
    chatNote(`not sent: ${g.text!.slice(0, 40)}`);
  }, SENDING_MS);
}
function settleSending(g: ChatLine, m: ChatLine, c: string | null) {
  sendingLines.splice(sendingLines.indexOf(g), 1);
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(keyOf(g))}"]`);
  if (li && c === conv) putLine(m, true, li).style.animation = 'none';
  dropLine(keyOf(g));
}

// an invite this browser hasn't answered, still fresh
const INVITE_MS = 15 * 60 * 1000;
const isInvite = (m: ChatLine) => m.kind === 'show' && !!m.file && !m.gone && m.dm === st.name && m.name !== st.name
  && Date.now() - m.timestamp < INVITE_MS && m.timestamp > showSeen;
let showSeen = Number(localStorage.getItem('phosphorus-show-seen')) || 0;

function renderHistory(messages: ChatLine[], closed: Record<string, unknown> = {}) {
  lines.clear();
  convLines.clear();
  orphanMarks.clear();
  for (const m of messages) takeLine(m, false);
  // lines that came while this browser was away, counted past what it last saw;
  // a first visit has nothing to count
  for (const [c, list] of convLines) {
    if (readAt[c] === undefined || chatReading(c)) { stampRead(c); continue; }
    const fresh = list.filter((m) => m.timestamp > readAt[c]! && m.name !== st.name && m.kind !== 'sys' && m.kind !== 'topic');
    if (!fresh.length) { news.delete(c); continue; }
    news.set(c, fresh.length);
    if (noteFor(c)) continue;
    const last = fresh.at(-1)!;
    noteAdd(`${convName(c)} · ${fresh.length} new`, `${last.name}: ${last.text || (last.files ? 'shared a file' : '')}`, null, { conv: c });
  }
  // one sent while this browser was away, asked now
  const missed = messages.filter(isInvite).pop();
  if (missed) { showInvite(missed); notifyChat({ name: `${missed.name} invited you`, text: `to work on ${missed.file!.label} together` }, true, null, convOf(missed)); }
  // channels closed while this browser was away, unless opened again since
  const gone = Object.keys(closed).filter((ch) => !convLines.get(`ch:${ch}`)?.length);
  if (gone.some((ch) => myChannels.includes(ch))) { myChannels = myChannels.filter((ch) => !gone.includes(ch)); saveChannels(); }
  if (gone.includes(chOf(conv))) conv = 'mesh';
  renderConv();
  paintConvs();
  paintFiles();
}

// the status card's clear buttons, its code fetched or not
const stHostsEl = document.getElementById('st-hosts')!;
// captured, a card's own click opening it never seeing this one
stHostsEl.addEventListener('click', (e) => {
  const b = (e.target as Element).closest('.st-clear') as HTMLButtonElement | null;
  if (!b) return;
  e.stopPropagation();
  if (b.disabled) return;
  b.disabled = true;
  b.textContent = 'clearing';
  send({ type: 'model-purge', id: b.dataset.host, to: b.dataset.host });
}, true);

// the llama-server slots on its host erased, a fresh start for its kv cache
function modelPurged(msg: { id: string; error?: string }) {
  const btn = stHostsEl.querySelector(`.st-clear[data-host="${CSS.escape(String(msg.id))}"]`) as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = msg.error ? `no clear: ${msg.error}` : 'cleared';
  setTimeout(() => { btn.textContent = 'clear context'; }, 2500);
}

// --- the socket -------------------------------------------------------------------

// the chat socket proved alive: a ping when it's been quiet, on coming back
// and coming online, closed for a fresh one when no answer lands
let chatHeard = 0;
const CHAT_QUIET_MS = 25000;
const CHAT_PONG_MS = 4000;
function chatAwake(now = false) {
  if (!wsOpen() || (!now && Date.now() - chatHeard < CHAT_QUIET_MS)) return;
  const sock = st.ws!;
  const asked = Date.now();
  send({ type: 'ping' });
  // a dead socket's own close can take minutes, so its close run now
  setTimeout(() => {
    if (st.ws !== sock || chatHeard >= asked) return;
    const closed = sock.onclose as unknown as () => void;
    sock.onclose = null;
    sock.onmessage = null;
    sock.close();
    closed();
  }, CHAT_PONG_MS);
}
setInterval(() => { if (!document.hidden) chatAwake(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) chatAwake(true); });
window.addEventListener('online', () => chatAwake(true));

function connectChat() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/chat`);
  st.ws = ws;
  ws.onopen = () => {
    reconnectDelay = 300;
    chatHeard = Date.now();
    chatOnline = true;
    paintStatus();
    send({ type: 'join', name: st.name, color: st.color || undefined });
  };
  ws.onclose = () => {
    people = [];
    chatOnline = false;
    paintStatus();
    setTimeout(() => { if (st.name) connectChat(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    chatHeard = Date.now();
    let msg: ChatWsMessage;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.type === 'history') {
      chMetas = msg.channels && typeof msg.channels === 'object' ? msg.channels : {};
      renderHistory(msg.messages, msg.closed && typeof msg.closed === 'object' ? msg.closed : {});
    } else if (msg.type === 'message') {
      const { type, ...m } = msg;
      takeLine(m, true);
    } else if (msg.type === 'phosphorus-ui') {
      phosphorusPressed(msg.action);
    } else if (msg.type === 'model-purged') {
      modelPurged(msg);
    } else if (msg.type === 'retract') {
      dropLine(`${msg.host}:${msg.seq}`);
    } else if (msg.type === 'presence') {
      people = msg.people;
      paintStatus();
      paintConvs();
      paintFiles();
    } else if (msg.type === 'system') {
      sysLine('mesh', msg.text);
    } else if (msg.type === 'clear') {
      for (const m of [...(convLines.get('mesh') || [])]) lines.delete(keyOf(m));
      convLines.delete('mesh');
      if (conv === 'mesh') renderConv();
      sysLine('mesh', msg.by ? `chat cleared by ${msg.by}` : 'chat cleared');
      paintFiles();
    } else if (msg.type === 'close') {
      if (typeof msg.ch === 'string') channelClosed(msg.ch, msg.by);
    } else if (msg.type === 'channel') {
      if (typeof msg.ch === 'string' && msg.meta && typeof msg.meta === 'object') { chMetas[msg.ch] = msg.meta; paintConvs(); }
    }
  };
}

// --- typing ---------------------------------------------------------------------

// where a key went down, said again every few seconds while it keeps going
const TYPING_EVERY_MS = 3000;
let typingSent = '';
let typingAt = 0;
function typingTick() {
  const busy = chatText.value.trim() && !chatText.value.startsWith('/') && !chatChip.textContent;
  const where = busy ? conv : '';
  if (where === typingSent && (!where || Date.now() - typingAt < TYPING_EVERY_MS)) return;
  typingSent = where;
  typingAt = Date.now();
  send({ type: 'typing', conv: where });
}

// --- attachments ------------------------------------------------------------------

// one picked, pasted or dropped: its upload, then the server's meta for the line
interface Att { file: File; state: 'up' | 'done' | 'err'; pct: number; meta: ChatFile | null; error: string; xhr?: XMLHttpRequest | null }

// uploaded the moment they're picked, pasted or dropped, sent with the next line
let atts: Att[] = [];

function paintAtts() {
  chatAtts.hidden = !atts.length;
  chatAtts.replaceChildren(...atts.map((a) => {
    const li = el('li', `att ${a.state}`);
    li.append(el('span', 'att-name', a.file.name), el('span', 'att-state', a.state === 'up' ? `${a.pct}%` : a.state === 'err' ? a.error : humanSize(a.file.size)));
    const x = Object.assign(el('button', 'att-x', '×'), { type: 'button', title: 'remove' });
    x.addEventListener('click', () => { a.xhr?.abort(); atts = atts.filter((b) => b !== a); paintAtts(); syncSend(); });
    li.append(x);
    return li;
  }));
  syncSend();
}

function addFiles(list: File[]) {
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
    atts.push(a);
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
let dragDepth = 0;
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

// --- reply, react, edit, delete ---------------------------------------------------

// the line being answered or rewritten, shown over the box until sent or esc
let replyTo: ChatLine | null = null;
let editing: ChatLine | null = null;

function paintBar() {
  const m = replyTo || editing;
  chatBar.hidden = !m;
  if (!m) return;
  const t = (m.edited ?? m.text) || '';
  chatBar.replaceChildren(
    el('span', 'bar-kind', editing ? 'editing' : `replying to ${m.name}`),
    el('span', 'bar-text', t.replace(/\s+/g, ' ').slice(0, 100)),
    el('span', 'bar-esc', 'esc cancel'),
  );
}

function cancelCompose() {
  if (editing) { chatText.value = ''; autoGrowChatText(); }
  replyTo = null;
  editing = null;
  paintBar();
}

function startEdit(m: ChatLine) {
  replyTo = null;
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

function startReply(m: ChatLine) {
  editing = null;
  replyTo = m;
  paintBar();
  chatText.focus();
}

function react(m: ChatLine, emoji: string) {
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
function lineMenu(li: HTMLElement, m: ChatLine, anchor: HTMLElement, at: { x: number; y: number } | null = null) {
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

// --- find ---------------------------------------------------------------------------

function findIn(li: HTMLElement) {
  const q = chatFindInput.value.trim().toLowerCase();
  if (!li.matches('.msg, .sys')) return;
  const t = li.textContent!.replace(li.querySelector('.msg-more')?.textContent || '', '');
  li.classList.toggle('miss', !!q && !t.toLowerCase().includes(q));
}

function runFind() {
  const all = [...chatLog.querySelectorAll<HTMLElement>('li.msg, li.sys')];
  all.forEach(findIn);
  const q = chatFindInput.value.trim();
  chatFindCount.textContent = q ? `${all.filter((li) => !li.classList.contains('miss')).length} of ${all.length}` : '';
  chatLog.classList.toggle('finding', !!q);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function toggleFind(on = chatFind.hidden) {
  chatFind.hidden = !on;
  if (!on) { chatFindInput.value = ''; runFind(); chatText.focus(); return; }
  chatFindInput.focus();
  chatFindInput.select();
}

document.getElementById('chat-find-btn')!.addEventListener('click', () => toggleFind());
chatFindInput.addEventListener('input', runFind);
chatFindInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); toggleFind(false); }
});

// --- commands -----------------------------------------------------------------------

// a channel opened or made from the conversations' +, a topic after its name
function joinChannel(arg: string) {
  const [raw, ...topic] = arg.trim().split(/s+/);
  const ch = (raw || '').replace(/^#/, '').toLowerCase();
  if (ch === 'mesh') { setConv('mesh'); return; }
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(ch)) { chatNote('bad name'); return; }
  if (!myChannels.includes(ch)) myChannels.push(ch);
  delete leftChannels[ch];
  saveChannels();
  const fresh = !convLines.get(`ch:${ch}`)?.length;
  openConv(`ch:${ch}`);
  if (fresh || topic.length) send({ type: 'topic', ch, text: topic.join(' ') });
}

function runCommand(input: string) {
  const [cmd, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(' ').trim();

  if (cmd === '/share') {
    // in a dm, its other end unless another name leads
    let to = nameIn(arg);
    let what = arg.slice(to.length).trim();
    if (dmWith(conv) && !knownNames().includes(to)) { to = dmWith(conv); what = arg; }
    if (!to || to === st.name || !what) { chatNote('usage: /share name file'); return; }
    resolveShow(what).then((f) => {
      if (!f) { chatNote(`no ${what}`); return; }
      chatNote(shareWith(to, f));
      dkCode(f);
    });
    return;
  }
  if (cmd === '/dm') {
    const to = nameIn(arg);
    if (!to || to === st.name) { chatNote('usage: /dm name [message]'); return; }
    const text = arg.slice(to.length).trim();
    openConv(`dm:${to}`);
    if (text) send({ type: 'dm', to, text });
    return;
  }
  if (cmd === '/chat') { setConv('mesh'); return; }
  if (cmd === '/leave' && chOf(conv)) { leaveChannel(chOf(conv)); return; }
  // asked once more in the menu, never closed on one keystroke
  if (cmd === '/close' && chOf(conv)) { convMenu(conv, chatTitle, true); return; }
  if (cmd === '/topic' && chOf(conv)) { send({ type: 'topic', ch: chOf(conv), text: arg }); return; }
  if (cmd === '/rename') {
    if (st.acct) { chatNote('name fixed'); return; }
    if (!arg) { chatNote('usage: /rename name'); return; }
    st.name = arg.slice(0, 32);
    localStorage.setItem('phosphorus-chat-name', st.name);
    send({ type: 'rename', name: st.name });
    return;
  }
  if (cmd === '/recolor') {
    const idx = arg ? COLOR_NAMES.indexOf(arg.toLowerCase()) : -1;
    if (arg && idx === -1) { chatNote(`usage: /recolor ${COLOR_NAMES.join('|')}`); return; }
    st.color = idx !== -1 ? NAME_COLORS[idx]! : NAME_COLORS[Math.floor(Math.random() * NAME_COLORS.length)]!;
    localStorage.setItem('phosphorus-chat-color', st.color);
    send({ type: 'recolor', color: st.color });
    return;
  }
  if (dmWith(conv)) { chatNote('not here'); return; }
  // the mesh channel's own, everyone's, not a local scrollback wipe
  if (cmd === '/clear' && conv === 'mesh') { send({ type: 'clear' }); return; }
  chatNote(`unknown ${cmd}`);
}

// every name this browser knows of, and the longest of them an argument starts
// with, names with spaces included
const knownNames = () => [...new Set([...people.map((p) => p.name), ...[...convLines.keys()].map(dmWith).filter(Boolean)])]
  .filter((n) => n !== st.name);
const nameIn = (arg: string) => knownNames().sort((a, b) => b.length - a.length).find((n) => arg === n || arg.startsWith(`${n} `)) || arg.split(/\s+/)[0]!;

// a file offered to someone: an invite as a dm, a dialog on their end
function shareWith(to: string, f: ShowFile): string {
  if (!joined()) return 'join first';
  send({ type: 'show', to, file: f });
  return `invited ${to} to ${f.label}`;
}
// the people to offer it to, those on first; done says how it went
export function shareMenu(anchor: HTMLElement, f: EditorFile, done: (how: string) => void): void {
  const on = (n: string) => people.some((p) => p.name === n);
  const who = knownNames().sort((a, b) => Number(on(b)) - Number(on(a)) || a.localeCompare(b));
  popMenu(anchor, `share ${codeName(f)} with`, who.length
    ? who.map((n) => ({ label: n, sub: on(n) ? 'online' : 'asked when they are back', act: () => done(shareWith(n, f)) }))
    : [{ label: 'nobody', act: () => {} }]);
}

// a /share's file: an open editor tab by its name or path, else a file as the
// files tab shows it, host then the share's root then the path
async function resolveShow(what: string): Promise<ShowFile | null> {
  const w = what.replace(/^\/+/, '');
  for (const id of codeTabs.values()) {
    const f = editors.get(id)?.file;
    if (f && (f.label === w || f.path === w || codeName(f) === w || f.label.endsWith(`/${w}`))) return f;
  }
  const [host, ...rest] = w.split('/');
  if (![st.selfHost, ...phosphorusHosts()].includes(host!) || !rest.length) return null;
  const info = await fetch(`/api/files/${encodeURIComponent(host!)}/info`).then((r) => r.json()).catch(() => null);
  const full = rest.join('/');
  const bare = (l: unknown) => String(l || '').replace(/^\/+|\/+$/g, '');
  const sh = ((info?.shares || []) as { id: string; label: string }[]).filter((x) => full.startsWith(`${bare(x.label)}/`)).sort((a, b) => bare(b.label).length - bare(a.label).length)[0];
  if (!sh) return null;
  const rel = full.slice(bare(sh.label).length + 1);
  return rel ? { host: host!, share: sh.id, path: rel, label: fileLabel(host!, sh.label, rel) } : null;
}

// the dialog for an invite to this browser
const showModal = document.getElementById('show-modal')!;
let showFile: ShowFile | null = null;
function showInvite(m: ChatLine) {
  showFile = m.file!;
  showSeen = Math.max(showSeen, m.timestamp);
  try { localStorage.setItem('phosphorus-show-seen', String(showSeen)); } catch {}
  document.getElementById('show-modal-text')!.replaceChildren(el('b', '', m.name), ' invites: ', el('code', '', m.file!.label));
  showModal.hidden = false;
  document.getElementById('show-modal-go')!.focus();
}
const closeShow = () => { showModal.hidden = true; };
document.getElementById('show-modal-go')!.addEventListener('click', () => { closeShow(); if (showFile) dkCode(showFile); });
document.getElementById('show-modal-no')!.addEventListener('click', closeShow);
document.getElementById('show-modal-close')!.addEventListener('click', closeShow);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !showModal.hidden) closeShow(); });

// a command's hit: its label, what it is, and what picking it does
interface ChatHit { label: string; what: string; cmd?: boolean; pick: () => void }

// the choices a command's words already have: people, open files, channels, colours
function argHints(): ChatHit[] {
  const cmd = chatChip.textContent;
  const v = chatText.value;
  const online = (n: string) => (people.some((p) => p.name === n) ? 'online' : 'offline');
  let prefix = '';
  let list: [string, string][] = [];
  if (cmd === '/dm' || cmd === '/share') {
    const who = knownNames().sort((a, b) => b.length - a.length).find((n) => v.startsWith(`${n} `));
    if (!who) list = knownNames().map((n) => [n, online(n)]);
    else if (cmd === '/share') {
      prefix = `${who} `;
      list = [...codeTabs.values()].map((id) => editors.get(id)?.file).filter((f): f is EditorFile => !!f).map((f) => [f.label, 'open in an editor tab']);
    }
  } else if (cmd === CHANNEL_CHIP[0]) list = channels().map((c) => [c, topicOf(`ch:${c}`) || 'channel']);
  else if (cmd === '/recolor') list = COLOR_NAMES.map((c) => [c, '']);
  const token = v.slice(prefix.length).toLowerCase();
  return list.filter(([x]) => x.toLowerCase().includes(token) && x.toLowerCase() !== token).slice(0, 8).map(([x, what]) => ({
    label: x, what,
    pick: () => {
      chatText.value = `${prefix}${x}${cmd === '/recolor' || prefix ? '' : ' '}`;
      chatText.setSelectionRange(chatText.value.length, chatText.value.length);
      autoGrowChatText();
    },
  }));
}

// name, what it does, and the box's placeholder once chosen, none for a
// command that takes nothing
type Cmd = [string, string, string];
const DM_CMD: Cmd = ['/dm', 'message one person directly', 'name, then the message'];
// not a command: the conversations' + asking for a channel's name
const CHANNEL_CHIP: Cmd = ['#', 'open or make a channel', 'channel name, then a topic'];
const SHARE_CMD: Cmd = ['/share', 'work on a file together', 'name, then an open tab or a shared file'];
const BACK_CMD: Cmd = ['/chat', 'back to #mesh', ''];
const ME_CMDS: Cmd[] = [['/recolor', 'change your colour', COLOR_NAMES.join(', ')]];
function commands(): Cmd[] {
  if (dmWith(conv)) return [BACK_CMD, SHARE_CMD, DM_CMD];
  return [
    DM_CMD, SHARE_CMD,
    ...(chOf(conv) ? [['/topic', 'describe this channel', 'topic'], ['/leave', 'hide it from your list', ''], ['/close', 'close it for everyone', ''], BACK_CMD] as Cmd[] : [['/clear', 'clear #mesh for everyone', '']] as Cmd[]),
    ...ME_CMDS,
  ];
}
let chatHits: ChatHit[] = [];
let chatHit = 0;

// a command that takes words, held beside the box rather than in it, so
// spellcheck never underlines it and it keeps its colour
function setChatChip(cmd: string) {
  const spec = [CHANNEL_CHIP, ...commands()].find(([c]) => c === cmd);
  chatChip.textContent = cmd || '';
  chatChip.hidden = !cmd;
  chatText.placeholder = spec ? spec[2] : convHint();
}

// a command picked from outside the box, its words typed next
function startCommand(cmd: string) {
  if (!joined()) { chatName.focus(); return; }
  setChatChip(cmd);
  chatText.value = '';
  autoGrowChatText();
  chatText.focus();
}

// while the first word is a command in the making, the ones it could be,
// one lit for tab or enter
function renderChatCmds() {
  const m = chatText.value.match(/^(\/\S*)$/);
  const hits: ChatHit[] = editing ? []
    : chatChip.textContent ? argHints()
      : m ? commands().filter(([c]) => c.startsWith(m[1]!.toLowerCase())).map(([c, what]) => ({ label: c, what, cmd: true, pick: () => pickChatCmd(c) })) : [];
  if (hits.map((h) => h.label).join() !== chatHits.map((h) => h.label).join()) chatHit = 0;
  chatHits = hits;
  chatCmds.hidden = !hits.length;
  chatCmds.replaceChildren(...hits.map((h, i) => {
    const li = el('li', i === chatHit ? 'on' : '');
    li.append(el('span', h.cmd ? 'cmd' : 'cmd hint', h.label), el('span', 'cmd-what', h.what));
    li.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keeps the box focused
      h.pick();
    });
    return li;
  }));
}

// a command taking words as the chip, one taking none run
function pickChatCmd(cmd: string) {
  const spec = commands().find(([c]) => c === cmd);
  if (spec && !spec[2]) {
    chatText.value = cmd;
    chatForm.requestSubmit();
    return;
  }
  setChatChip(cmd);
  chatText.value = '';
  chatText.dispatchEvent(new Event('input'));
}

const uploading = () => atts.some((a) => a.state === 'up');
function syncSend() {
  chatSend.disabled = !chatText.value.trim() && !chatChip.textContent && !atts.some((a) => a.state === 'done');
}

// the box grown to its text, the arrow lit only once there is something to send
function autoGrowChatText() {
  chatText.style.height = 'auto';
  chatText.style.height = `${chatText.scrollHeight}px`;
  syncSend();
  renderChatCmds();
}

chatText.addEventListener('input', () => {
  // a command typed out in full, then a space: into the chip
  const typed = !chatChip.textContent && !editing && chatText.value.match(/^(\/\S+)\s/);
  const spec = typed && commands().find(([c, , takes]) => c === typed[1]!.toLowerCase() && takes);
  if (spec) {
    setChatChip(spec[0]);
    chatText.value = chatText.value.slice(typed[0].length);
  }
  autoGrowChatText();
  typingTick();
});
chatText.addEventListener('blur', () => { if (typingSent) { typingSent = ''; send({ type: 'typing', conv: '' }); } });
chatName.addEventListener('input', () => { chatJoinGo.disabled = !chatName.value.trim(); });

chatText.addEventListener('keydown', (e) => {
  if (chatHits.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
    e.preventDefault();
    chatHit = (chatHit + (e.key === 'ArrowDown' ? 1 : chatHits.length - 1)) % chatHits.length;
    renderChatCmds();
    return;
  }
  if (chatHits.length && (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey))) {
    e.preventDefault();
    chatHits[chatHit]!.pick();
    return;
  }
  if (e.key === 'Escape' && chatHits.length) {
    e.preventDefault();
    chatHits = [];
    chatCmds.hidden = true;
    return;
  }
  // esc: a reply or edit dropped first, the box left only after
  if (e.key === 'Escape' && (replyTo || editing)) {
    e.preventDefault();
    cancelCompose();
    return;
  }
  // ↑ in an empty box: your last line here, to edit
  if (e.key === 'ArrowUp' && !chatText.value && !chatChip.textContent) {
    const m = (convLines.get(conv) || []).findLast((x) => x.name === st.name && (!x.kind || x.kind === 'dm') && !x.gone);
    if (m) { e.preventDefault(); startEdit(m); }
    return;
  }
  // backspace at the very start: the chip back as text
  if (e.key === 'Backspace' && chatChip.textContent && chatText.selectionStart === 0 && chatText.selectionEnd === 0) {
    e.preventDefault();
    const cmd = chatChip.textContent;
    setChatChip('');
    chatText.value = `${cmd}${chatText.value}`;
    chatText.setSelectionRange(cmd.length, cmd.length);
    autoGrowChatText();
    return;
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = `${chatChip.textContent} ${chatText.value}`.trim();
  if (!wsOpen()) { chatNote('reconnecting'); return; }
  if (editing) {
    if (text) send({ type: 'edit', ref: keyOf(editing), text });
    cancelCompose();
    chatText.value = '';
    autoGrowChatText();
    return;
  }
  const files = atts.filter((a) => a.state === 'done').map((a) => a.meta!);
  if (!text && !files.length) return;
  if (uploading()) { chatNote('uploading'); return; }
  chatText.value = '';
  setChatChip('');
  autoGrowChatText();
  typingTick();
  if (text.startsWith(`${CHANNEL_CHIP[0]} `) && !files.length) {
    joinChannel(text.slice(CHANNEL_CHIP[0].length));
    return;
  }
  if (text.startsWith('/') && !files.length) {
    runCommand(text);
    return;
  }
  const re = replyTo ? keyOf(replyTo) : undefined;
  replyTo = null;
  paintBar();
  atts = [];
  paintAtts();
  const files1 = files.length ? files : undefined;
  if (dmWith(conv)) {
    send({ type: 'dm', to: dmWith(conv), text, files, re });
    putSending({ kind: 'dm', dm: dmWith(conv), text, files: files1, re });
  } else {
    send({ type: 'message', text, files, re, ch: chOf(conv) || undefined });
    putSending({ text, files: files1, re, ch: chOf(conv) || undefined });
  }
});

chatJoin.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = chatName.value.trim().slice(0, 32);
  if (!v) return;
  st.name = v;
  localStorage.setItem('phosphorus-chat-name', st.name);
  chatJoin.hidden = true;
  chatCompose.hidden = false;
  connectChat();
});

// joined as the logged in user, never before
export function chatAs(user: string): void {
  if (user === st.name && st.ws && st.ws.readyState <= WebSocket.OPEN) return;
  st.name = user;
  try { if (user) localStorage.setItem('phosphorus-chat-name', user); } catch {}
  chatJoin.hidden = !!user;
  chatCompose.hidden = !user;
  if (st.ws && st.ws.readyState <= WebSocket.OPEN) st.ws.close();
  else if (user) connectChat();
}

// --- phosphorus's presses on this page ----------------------------------------------
// the page moved for whoever asked, as a button would: an app, a terminal, a host

function phosphorusPressed(a: UiAction) {
  if (a) dkPressed(a);
}
