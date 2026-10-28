// incoming

import type { ChatWsMessage } from '@phosphorus/wire';
import { st } from '../../lib/state.ts';
import { bumpUnread, noteAdd, noteFor, notifyChat } from '../notes.ts';
import { phosphorusPressed } from './chat.ts';
import { showInvite } from './commands.ts';
import {
  chatReading,
  chOf,
  convName,
  convsVars,
  news,
  noteNews,
  paintConvs,
  readAt,
  saveChannels,
  stampRead,
} from './convs.ts';
import { paintFiles, paintStatus, renderConv } from './files.ts';
import {
  chatNote,
  convLines,
  convOf,
  dropLine,
  fold,
  holdLine,
  keyOf,
  lines,
  MARKS,
  orphanMarks,
  putLine,
  redrawLine,
  sender,
  sysLine,
} from './lines.ts';
import { channelClosed } from './menus.ts';
import { type ChatLine, chatLog, colorFor, send, stateVars, wsOpen } from './state.ts';

// a line in, live or from history: folded, held, drawn if on screen, noted if not
export function takeLine(m: ChatLine, live: boolean) {
  if (MARKS.includes(m.kind!)) {
    const t = fold(m);
    if (t && live && convOf(t) === convsVars.conv) redrawLine(t);
    if (t && live && m.kind === 'react' && t.name === st.name && m.name !== st.name && m.on !== false)
      notifyChat(
        { name: m.name, text: `reacted ${m.emoji}` },
        false,
        { key: 'reactions', label: 'reactions', line: `${m.name} ${m.emoji}` },
        convOf(t),
      );
    return;
  }
  if (live) m.live = true;
  const ghost =
    live && m.name === st.name && sendingLines.find((g) => g.text === (m.text || '') && convOf(g) === convOf(m));
  const c = holdLine(m);
  if (ghost) settleSending(ghost, m, c);
  if (!c || !live) return;
  if (c === convsVars.conv && !ghost) putLine(m, true);
  if (m.kind === 'topic') {
    paintConvs();
    return;
  }
  // an invite to this browser's name, fresh: asked as a dialog and notified past the bell
  if (isInvite(m)) {
    showInvite(m);
    noteNews(c);
    bumpUnread();
    notifyChat({ name: `${m.name} invited you`, text: `to work on ${m.file!.label} together` }, true, null, c);
    return;
  }
  if (m.files && c === convsVars.conv) paintFiles();
  if (m.name === st.name) {
    paintConvs();
    return;
  }
  noteNews(c);
  bumpUnread();
  const text = m.text || (m.files ? `shared ${m.files.map((f) => f.name).join(', ')}` : '');
  const atMe = st.name && new RegExp(`@${st.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(m.text || '');
  // a mention its own entry; the rest by channel or person, none for the one being read
  const where = m.dm ? m.name : `#${m.ch || 'mesh'}`;
  notifyChat(
    {
      name: m.dm
        ? `${sender(m)} (direct)`
        : atMe
          ? `${sender(m)} mentioned you`
          : m.ch
            ? `${sender(m)} in #${m.ch}`
            : sender(m),
      text,
    },
    false,
    atMe
      ? null
      : {
          key: m.dm ? `dm:${m.name}` : where,
          label: where,
          line: m.dm ? text : `${m.name}: ${text}`,
          seen: chatReading(c),
        },
    c,
  );
}

// own lines drawn at once, swapped in place for the host's echo
export const sendingLines: ChatLine[] = [];
export const SENDING_MS = 10000;
export let sendingSeq = 0;
export function putSending(fields: Partial<ChatLine> & { text: string }) {
  const g: ChatLine = {
    host: 'sending',
    seq: (sendingSeq += 1),
    timestamp: Date.now(),
    name: st.name,
    color: st.color || colorFor(st.name),
    sending: true,
    ...fields,
    text: fields.text.slice(0, 2000),
  };
  sendingLines.push(g);
  if (holdLine(g) === convsVars.conv) putLine(g, true).classList.add('sending');
  setTimeout(() => {
    if (!sendingLines.includes(g)) return;
    sendingLines.splice(sendingLines.indexOf(g), 1);
    dropLine(keyOf(g));
    chatNote(`not sent: ${g.text!.slice(0, 40)}`);
  }, SENDING_MS);
}
export function settleSending(g: ChatLine, m: ChatLine, c: string | null) {
  sendingLines.splice(sendingLines.indexOf(g), 1);
  const li = chatLog.querySelector(`li[data-key="${CSS.escape(keyOf(g))}"]`);
  if (li && c === convsVars.conv) putLine(m, true, li).style.animation = 'none';
  dropLine(keyOf(g));
}

// an invite this browser hasn't answered, still fresh
export const INVITE_MS = 15 * 60 * 1000;
export const isInvite = (m: ChatLine) =>
  m.kind === 'show' &&
  !!m.file &&
  !m.gone &&
  m.dm === st.name &&
  m.name !== st.name &&
  Date.now() - m.timestamp < INVITE_MS &&
  m.timestamp > socketVars.showSeen;

// the module's variables other modules set
export const socketVars = {
  showSeen: Number(localStorage.getItem('phosphorus-show-seen')) || 0,
};

export function renderHistory(messages: ChatLine[], closed: Record<string, unknown> = {}) {
  lines.clear();
  convLines.clear();
  orphanMarks.clear();
  for (const m of messages) takeLine(m, false);
  // lines that came while this browser was away, counted past what it last saw;
  // a first visit has nothing to count
  for (const [c, list] of convLines) {
    if (readAt[c] === undefined || chatReading(c)) {
      stampRead(c);
      continue;
    }
    const fresh = list.filter(
      (m) => m.timestamp > readAt[c]! && m.name !== st.name && m.kind !== 'sys' && m.kind !== 'topic',
    );
    if (!fresh.length) {
      news.delete(c);
      continue;
    }
    news.set(c, fresh.length);
    if (noteFor(c)) continue;
    const last = fresh.at(-1)!;
    noteAdd(
      `${convName(c)} · ${fresh.length} new`,
      `${last.name}: ${last.text || (last.files ? 'shared a file' : '')}`,
      null,
      { conv: c },
    );
  }
  // one sent while this browser was away, asked now
  const missed = messages.filter(isInvite).pop();
  if (missed) {
    showInvite(missed);
    notifyChat(
      { name: `${missed.name} invited you`, text: `to work on ${missed.file!.label} together` },
      true,
      null,
      convOf(missed),
    );
  }
  // channels closed while this browser was away, unless opened again since
  const gone = Object.keys(closed).filter((ch) => !convLines.get(`ch:${ch}`)?.length);
  if (gone.some((ch) => convsVars.myChannels.includes(ch))) {
    convsVars.myChannels = convsVars.myChannels.filter((ch) => !gone.includes(ch));
    saveChannels();
  }
  if (gone.includes(chOf(convsVars.conv))) convsVars.conv = 'mesh';
  renderConv();
  paintConvs();
  paintFiles();
}

// the status card's clear buttons, its code fetched or not
export const stHostsEl = document.getElementById('st-hosts')!;
// captured, a card's own click opening it never seeing this one
stHostsEl.addEventListener(
  'click',
  (e) => {
    const b = (e.target as Element).closest('.st-clear') as HTMLButtonElement | null;
    if (!b) return;
    e.stopPropagation();
    if (b.disabled) return;
    b.disabled = true;
    b.textContent = 'clearing';
    send({ type: 'model-purge', id: b.dataset.host, to: b.dataset.host });
  },
  true,
);

// the llama-server slots on its host erased, a fresh start for its kv cache
export function modelPurged(msg: { id: string; error?: string }) {
  const btn = stHostsEl.querySelector(
    `.st-clear[data-host="${CSS.escape(String(msg.id))}"]`,
  ) as HTMLButtonElement | null;
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = msg.error ? `no clear: ${msg.error}` : 'cleared';
  setTimeout(() => {
    btn.textContent = 'clear context';
  }, 2500);
}

// the chat socket proved alive: a ping when it's been quiet, on coming back
// and coming online, closed for a fresh one when no answer lands
export let chatHeard = 0;
export const CHAT_QUIET_MS = 25000;
export const CHAT_PONG_MS = 4000;
export function chatAwake(now = false) {
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
setInterval(() => {
  if (!document.hidden) chatAwake();
}, 5000);
window.addEventListener('online', () => chatAwake(true));

export function connectChat() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/api/chat`);
  st.ws = ws;
  ws.onopen = () => {
    stateVars.reconnectDelay = 300;
    chatHeard = Date.now();
    stateVars.chatOnline = true;
    paintStatus();
    send({ type: 'join', name: st.name, color: st.color || undefined });
  };
  ws.onclose = () => {
    stateVars.people = [];
    stateVars.chatOnline = false;
    paintStatus();
    setTimeout(() => {
      if (st.name) connectChat();
    }, stateVars.reconnectDelay);
    stateVars.reconnectDelay = Math.min(stateVars.reconnectDelay * 1.5, 5000);
  };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    chatHeard = Date.now();
    let msg: ChatWsMessage;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'pong') return;
    if (msg.type === 'history') {
      convsVars.chMetas = msg.channels && typeof msg.channels === 'object' ? msg.channels : {};
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
      stateVars.people = msg.people;
      paintStatus();
      paintConvs();
      paintFiles();
    } else if (msg.type === 'system') {
      sysLine('mesh', msg.text);
    } else if (msg.type === 'clear') {
      for (const m of [...(convLines.get('mesh') || [])]) lines.delete(keyOf(m));
      convLines.delete('mesh');
      if (convsVars.conv === 'mesh') renderConv();
      sysLine('mesh', msg.by ? `chat cleared by ${msg.by}` : 'chat cleared');
      paintFiles();
    } else if (msg.type === 'close') {
      if (typeof msg.ch === 'string') channelClosed(msg.ch, msg.by);
    } else if (msg.type === 'channel') {
      if (typeof msg.ch === 'string' && msg.meta && typeof msg.meta === 'object') {
        convsVars.chMetas[msg.ch] = msg.meta;
        paintConvs();
      }
    }
  };
}
