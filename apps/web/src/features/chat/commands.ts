// commands

import type { ShowFile } from '@phosphorus/wire';
import { dkCode } from '../../desktop/deskfiles.ts';
import { el } from '../../lib/dom.ts';
import { st } from '../../lib/state.ts';
import { codeName, codeTabs, type EditorFile, editors, fileLabel } from '../home/home.ts';
import { phosphorusHosts } from '../mesh/mesh.ts';
import { cancelCompose, composeVars, editing, paintAtts, paintBar, startEdit, typingTick } from './compose.ts';
import { channels, chOf, convHint, convsVars, dmWith, leftChannels, saveChannels, topicOf } from './convs.ts';
import { openConv, setConv } from './files.ts';
import { chatNote, convLines, keyOf } from './lines.ts';
import { convMenu, leaveChannel, popMenu } from './menus.ts';
import { connectChat, putSending, socketVars } from './socket.ts';
import {
  type ChatLine,
  COLOR_NAMES,
  chatChip,
  chatCmds,
  chatCompose,
  chatForm,
  chatJoin,
  chatJoinGo,
  chatName,
  chatSend,
  chatText,
  chatTitle,
  joined,
  NAME_COLORS,
  send,
  stateVars,
  wsOpen,
} from './state.ts';

// a channel opened or made from the conversations' +, a topic after its name
export function joinChannel(arg: string) {
  const [raw, ...topic] = arg.trim().split(/s+/);
  const ch = (raw || '').replace(/^#/, '').toLowerCase();
  if (ch === 'mesh') {
    setConv('mesh');
    return;
  }
  if (!/^[a-z0-9][a-z0-9-]{0,23}$/.test(ch)) {
    chatNote('bad name');
    return;
  }
  if (!convsVars.myChannels.includes(ch)) convsVars.myChannels.push(ch);
  delete leftChannels[ch];
  saveChannels();
  const fresh = !convLines.get(`ch:${ch}`)?.length;
  openConv(`ch:${ch}`);
  if (fresh || topic.length) send({ type: 'topic', ch, text: topic.join(' ') });
}

export function runCommand(input: string) {
  const [cmd, ...rest] = input.trim().split(/\s+/);
  const arg = rest.join(' ').trim();

  if (cmd === '/share') {
    // in a dm, its other end unless another name leads
    let to = nameIn(arg);
    let what = arg.slice(to.length).trim();
    if (dmWith(convsVars.conv) && !knownNames().includes(to)) {
      to = dmWith(convsVars.conv);
      what = arg;
    }
    if (!to || to === st.name || !what) {
      chatNote('usage: /share name file');
      return;
    }
    resolveShow(what).then((f) => {
      if (!f) {
        chatNote(`no ${what}`);
        return;
      }
      chatNote(shareWith(to, f));
      dkCode(f);
    });
    return;
  }
  if (cmd === '/dm') {
    const to = nameIn(arg);
    if (!to || to === st.name) {
      chatNote('usage: /dm name [message]');
      return;
    }
    const text = arg.slice(to.length).trim();
    openConv(`dm:${to}`);
    if (text) send({ type: 'dm', to, text });
    return;
  }
  if (cmd === '/chat') {
    setConv('mesh');
    return;
  }
  if (cmd === '/leave' && chOf(convsVars.conv)) {
    leaveChannel(chOf(convsVars.conv));
    return;
  }
  // asked once more in the menu, never closed on one keystroke
  if (cmd === '/close' && chOf(convsVars.conv)) {
    convMenu(convsVars.conv, chatTitle, true);
    return;
  }
  if (cmd === '/topic' && chOf(convsVars.conv)) {
    send({ type: 'topic', ch: chOf(convsVars.conv), text: arg });
    return;
  }
  if (cmd === '/rename') {
    if (st.acct) {
      chatNote('name fixed');
      return;
    }
    if (!arg) {
      chatNote('usage: /rename name');
      return;
    }
    st.name = arg.slice(0, 32);
    localStorage.setItem('phosphorus-chat-name', st.name);
    send({ type: 'rename', name: st.name });
    return;
  }
  if (cmd === '/recolor') {
    const idx = arg ? COLOR_NAMES.indexOf(arg.toLowerCase()) : -1;
    if (arg && idx === -1) {
      chatNote(`usage: /recolor ${COLOR_NAMES.join('|')}`);
      return;
    }
    st.color = idx !== -1 ? NAME_COLORS[idx]! : NAME_COLORS[Math.floor(Math.random() * NAME_COLORS.length)]!;
    localStorage.setItem('phosphorus-chat-color', st.color);
    send({ type: 'recolor', color: st.color });
    return;
  }
  if (dmWith(convsVars.conv)) {
    chatNote('not here');
    return;
  }
  // the mesh channel's own, everyone's, not a local scrollback wipe
  if (cmd === '/clear' && convsVars.conv === 'mesh') {
    send({ type: 'clear' });
    return;
  }
  chatNote(`unknown ${cmd}`);
}

// every name this browser knows of, and the longest of them an argument starts
// with, names with spaces included
export const knownNames = () =>
  [...new Set([...stateVars.people.map((p) => p.name), ...[...convLines.keys()].map(dmWith).filter(Boolean)])].filter(
    (n) => n !== st.name,
  );
export const nameIn = (arg: string) =>
  knownNames()
    .sort((a, b) => b.length - a.length)
    .find((n) => arg === n || arg.startsWith(`${n} `)) || arg.split(/\s+/)[0]!;

// a file offered to someone: an invite as a dm, a dialog on their end
export function shareWith(to: string, f: ShowFile): string {
  if (!joined()) return 'join first';
  send({ type: 'show', to, file: f });
  return `invited ${to} to ${f.label}`;
}
// the people to offer it to, those on first; done says how it went
export function shareMenu(anchor: HTMLElement, f: EditorFile, done: (how: string) => void): void {
  const on = (n: string) => stateVars.people.some((p) => p.name === n);
  const who = knownNames().sort((a, b) => Number(on(b)) - Number(on(a)) || a.localeCompare(b));
  popMenu(
    anchor,
    `share ${codeName(f)} with`,
    who.length
      ? who.map((n) => ({
          label: n,
          sub: on(n) ? 'online' : 'asked when they are back',
          act: () => done(shareWith(n, f)),
        }))
      : [{ label: 'nobody', act: () => {} }],
  );
}

// a /share's file: an open editor tab by its name or path, else a file as the
// files tab shows it, host then the share's root then the path
export async function resolveShow(what: string): Promise<ShowFile | null> {
  const w = what.replace(/^\/+/, '');
  for (const id of codeTabs.values()) {
    const f = editors.get(id)?.file;
    if (f && (f.label === w || f.path === w || codeName(f) === w || f.label.endsWith(`/${w}`))) return f;
  }
  const [host, ...rest] = w.split('/');
  if (![st.selfHost, ...phosphorusHosts()].includes(host!) || !rest.length) return null;
  const info = await fetch(`/api/files/${encodeURIComponent(host!)}/info`)
    .then((r) => r.json())
    .catch(() => null);
  const full = rest.join('/');
  const bare = (l: unknown) => String(l || '').replace(/^\/+|\/+$/g, '');
  const sh = ((info?.shares || []) as { id: string; label: string }[])
    .filter((x) => full.startsWith(`${bare(x.label)}/`))
    .sort((a, b) => bare(b.label).length - bare(a.label).length)[0];
  if (!sh) return null;
  const rel = full.slice(bare(sh.label).length + 1);
  return rel ? { host: host!, share: sh.id, path: rel, label: fileLabel(host!, sh.label, rel) } : null;
}

// the dialog for an invite to this browser
export const showModal = document.getElementById('show-modal')!;
export let showFile: ShowFile | null = null;
export function showInvite(m: ChatLine) {
  showFile = m.file!;
  socketVars.showSeen = Math.max(socketVars.showSeen, m.timestamp);
  try {
    localStorage.setItem('phosphorus-show-seen', String(socketVars.showSeen));
  } catch {}
  document
    .getElementById('show-modal-text')!
    .replaceChildren(el('b', '', m.name), ' invites: ', el('code', '', m.file!.label));
  showModal.hidden = false;
  document.getElementById('show-modal-go')!.focus();
}
export const closeShow = () => {
  showModal.hidden = true;
};
document.getElementById('show-modal-go')!.addEventListener('click', () => {
  closeShow();
  if (showFile) dkCode(showFile);
});
document.getElementById('show-modal-no')!.addEventListener('click', closeShow);
document.getElementById('show-modal-close')!.addEventListener('click', closeShow);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !showModal.hidden) closeShow();
});

// a command's hit: its label, what it is, and what picking it does
export interface ChatHit {
  label: string;
  what: string;
  cmd?: boolean;
  pick: () => void;
}

// the choices a command's words already have: people, open files, channels, colours
export function argHints(): ChatHit[] {
  const cmd = chatChip.textContent;
  const v = chatText.value;
  const online = (n: string) => (stateVars.people.some((p) => p.name === n) ? 'online' : 'offline');
  let prefix = '';
  let list: [string, string][] = [];
  if (cmd === '/dm' || cmd === '/share') {
    const who = knownNames()
      .sort((a, b) => b.length - a.length)
      .find((n) => v.startsWith(`${n} `));
    if (!who) list = knownNames().map((n) => [n, online(n)]);
    else if (cmd === '/share') {
      prefix = `${who} `;
      list = [...codeTabs.values()]
        .map((id) => editors.get(id)?.file)
        .filter((f): f is EditorFile => !!f)
        .map((f) => [f.label, 'open in an editor tab']);
    }
  } else if (cmd === CHANNEL_CHIP[0]) list = channels().map((c) => [c, topicOf(`ch:${c}`) || 'channel']);
  else if (cmd === '/recolor') list = COLOR_NAMES.map((c) => [c, '']);
  const token = v.slice(prefix.length).toLowerCase();
  return list
    .filter(([x]) => x.toLowerCase().includes(token) && x.toLowerCase() !== token)
    .slice(0, 8)
    .map(([x, what]) => ({
      label: x,
      what,
      pick: () => {
        chatText.value = `${prefix}${x}${cmd === '/recolor' || prefix ? '' : ' '}`;
        chatText.setSelectionRange(chatText.value.length, chatText.value.length);
        autoGrowChatText();
      },
    }));
}

// name, what it does, and the box's placeholder once chosen, none for a
// command that takes nothing
export type Cmd = [string, string, string];
export const DM_CMD: Cmd = ['/dm', 'message one person directly', 'name, then the message'];
// not a command: the conversations' + asking for a channel's name
export const CHANNEL_CHIP: Cmd = ['#', 'open or make a channel', 'channel name, then a topic'];
export const SHARE_CMD: Cmd = ['/share', 'work on a file together', 'name, then an open tab or a shared file'];
export const BACK_CMD: Cmd = ['/chat', 'back to #mesh', ''];
export const ME_CMDS: Cmd[] = [['/recolor', 'change your colour', COLOR_NAMES.join(', ')]];
export function commands(): Cmd[] {
  if (dmWith(convsVars.conv)) return [BACK_CMD, SHARE_CMD, DM_CMD];
  return [
    DM_CMD,
    SHARE_CMD,
    ...(chOf(convsVars.conv)
      ? ([
          ['/topic', 'describe this channel', 'topic'],
          ['/leave', 'hide it from your list', ''],
          ['/close', 'close it for everyone', ''],
          BACK_CMD,
        ] as Cmd[])
      : ([['/clear', 'clear #mesh for everyone', '']] as Cmd[])),
    ...ME_CMDS,
  ];
}
export let chatHits: ChatHit[] = [];
export let chatHit = 0;

// a command that takes words, held beside the box rather than in it, so
// spellcheck never underlines it and it keeps its colour
export function setChatChip(cmd: string) {
  const spec = [CHANNEL_CHIP, ...commands()].find(([c]) => c === cmd);
  chatChip.textContent = cmd || '';
  chatChip.hidden = !cmd;
  chatText.placeholder = spec ? spec[2] : convHint();
}

// a command picked from outside the box, its words typed next
export function startCommand(cmd: string) {
  if (!joined()) {
    chatName.focus();
    return;
  }
  setChatChip(cmd);
  chatText.value = '';
  autoGrowChatText();
  chatText.focus();
}

// while the first word is a command in the making, the ones it could be,
// one lit for tab or enter
export function renderChatCmds() {
  const m = chatText.value.match(/^(\/\S*)$/);
  const hits: ChatHit[] = editing
    ? []
    : chatChip.textContent
      ? argHints()
      : m
        ? commands()
            .filter(([c]) => c.startsWith(m[1]!.toLowerCase()))
            .map(([c, what]) => ({ label: c, what, cmd: true, pick: () => pickChatCmd(c) }))
        : [];
  if (hits.map((h) => h.label).join() !== chatHits.map((h) => h.label).join()) chatHit = 0;
  chatHits = hits;
  chatCmds.hidden = !hits.length;
  chatCmds.replaceChildren(
    ...hits.map((h, i) => {
      const li = el('li', i === chatHit ? 'on' : '');
      li.append(el('span', h.cmd ? 'cmd' : 'cmd hint', h.label), el('span', 'cmd-what', h.what));
      li.addEventListener('mousedown', (e) => {
        e.preventDefault(); // keeps the box focused
        h.pick();
      });
      return li;
    }),
  );
}

// a command taking words as the chip, one taking none run
export function pickChatCmd(cmd: string) {
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

export const uploading = () => composeVars.atts.some((a) => a.state === 'up');
export function syncSend() {
  chatSend.disabled =
    !chatText.value.trim() && !chatChip.textContent && !composeVars.atts.some((a) => a.state === 'done');
}

// the box grown to its text, the arrow lit only once there is something to send
export function autoGrowChatText() {
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
chatText.addEventListener('blur', () => {
  if (composeVars.typingSent) {
    composeVars.typingSent = '';
    send({ type: 'typing', conv: '' });
  }
});
chatName.addEventListener('input', () => {
  chatJoinGo.disabled = !chatName.value.trim();
});

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
  if (e.key === 'Escape' && (composeVars.replyTo || editing)) {
    e.preventDefault();
    cancelCompose();
    return;
  }
  // ↑ in an empty box: your last line here, to edit
  if (e.key === 'ArrowUp' && !chatText.value && !chatChip.textContent) {
    const m = (convLines.get(convsVars.conv) || []).findLast(
      (x) => x.name === st.name && (!x.kind || x.kind === 'dm') && !x.gone,
    );
    if (m) {
      e.preventDefault();
      startEdit(m);
    }
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
  if (!wsOpen()) {
    chatNote('reconnecting');
    return;
  }
  if (editing) {
    if (text) send({ type: 'edit', ref: keyOf(editing), text });
    cancelCompose();
    chatText.value = '';
    autoGrowChatText();
    return;
  }
  const files = composeVars.atts.filter((a) => a.state === 'done').map((a) => a.meta!);
  if (!text && !files.length) return;
  if (uploading()) {
    chatNote('uploading');
    return;
  }
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
  const re = composeVars.replyTo ? keyOf(composeVars.replyTo) : undefined;
  composeVars.replyTo = null;
  paintBar();
  composeVars.atts = [];
  paintAtts();
  const files1 = files.length ? files : undefined;
  if (dmWith(convsVars.conv)) {
    send({ type: 'dm', to: dmWith(convsVars.conv), text, files, re });
    putSending({ kind: 'dm', dm: dmWith(convsVars.conv), text, files: files1, re });
  } else {
    send({ type: 'message', text, files, re, ch: chOf(convsVars.conv) || undefined });
    putSending({ text, files: files1, re, ch: chOf(convsVars.conv) || undefined });
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
  try {
    if (user) localStorage.setItem('phosphorus-chat-name', user);
  } catch {}
  chatJoin.hidden = !!user;
  chatCompose.hidden = !user;
  if (st.ws && st.ws.readyState <= WebSocket.OPEN) st.ws.close();
  else if (user) connectChat();
}
