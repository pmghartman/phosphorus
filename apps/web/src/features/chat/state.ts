// chat

import type { ChatMsg, Person, Reaction } from '@phosphorus/wire';
import { dkOpenTerminal } from '../../desktop/desk.ts';
import { fitMath } from '../../lib/md.ts';
import { st } from '../../lib/state.ts';

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
export const chatLog = document.getElementById('chat-log')!;
// phosphorus's [open a terminal on host](#term:host): a terminal window, never a navigation
chatPanel.addEventListener('click', (e) => {
  const a = (e.target as Element).closest?.('a[href^="#term:"]');
  if (!a) return;
  e.preventDefault();
  const host = decodeURIComponent(a.getAttribute('href')!.slice(6));
  dkOpenTerminal(host);
});
export const chatTitle = document.getElementById('chat-title')!;
export const chatStatus = document.getElementById('chat-status')!;
export const chatJoin = document.getElementById('chat-join') as HTMLFormElement;
export const chatName = document.getElementById('chat-name') as HTMLInputElement;
export const chatJoinGo = document.getElementById('chat-join-go') as HTMLButtonElement;
export const chatCompose = document.getElementById('chat-compose')!;
export const chatForm = document.getElementById('chat-form') as HTMLFormElement;
export const chatText = document.getElementById('chat-text') as HTMLTextAreaElement;
export const chatSend = document.getElementById('chat-send') as HTMLButtonElement;
export const chatChip = document.getElementById('chat-chip')!;
export const chatCmds = document.getElementById('chat-cmds')!;
export const chatBar = document.getElementById('chat-bar')!;
export const chatAtts = document.getElementById('chat-atts')!;
export const chatAttach = document.getElementById('chat-attach')!;
export const chatFile = document.getElementById('chat-file') as HTMLInputElement;
export const chatTyping = document.getElementById('chat-typing')!;
export const chatFind = document.getElementById('chat-find')!;
export const chatFindInput = document.getElementById('chat-find-input') as HTMLInputElement;
export const chatFindCount = document.getElementById('chat-find-count')!;
export const chatDrop = document.getElementById('chat-drop')!;
export const cwList = document.getElementById('cw-list')!;
export const cwMain = document.getElementById('cw-main')!;
// the chat's panel beside its conversations, in the chat app
cwMain.appendChild(chatPanel);
export const chatFilesBtn = document.getElementById('chat-files-btn') as HTMLButtonElement;
export const chatPop = document.getElementById('chat-pop')!;

// the module's variables other modules set
export const stateVars = {
  // pinned while scrolled to the bottom, kept there by a resize
  chatPinned: true,
  // fast first, then backing off x1.5 (capped), most reconnects a blip
  reconnectDelay: 300,
  chatOnline: false,
  // everyone on the mesh, peers merged in by the frontend
  people: [] as Person[],
};

export const NAME_COLORS = [
  '#4f9eff',
  '#3fb950',
  '#f0883e',
  '#d2a8ff',
  '#ff7b72',
  '#79c0ff',
  '#ffa657',
  '#e3b341',
  '#ff9bce',
  '#39c5cf',
  '#db61a2',
  '#7ee787',
  '#d4a72c',
  '#ffa198',
];
export const COLOR_NAMES = [
  'blue',
  'green',
  'orange',
  'purple',
  'red',
  'skyblue',
  'gold',
  'yellow',
  'pink',
  'teal',
  'magenta',
  'lime',
  'amber',
  'coral',
];

export function colorFor(n: string): string {
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  return NAME_COLORS[h % NAME_COLORS.length]!;
}
export const wsOpen = () => st.ws && st.ws.readyState === WebSocket.OPEN;
export const send = (body: Record<string, unknown>) => wsOpen() && st.ws!.send(JSON.stringify(body));
export const joined = () => !chatCompose.hidden;

export const formatTime = (ts: number) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
export function formatDay(ts: number): string {
  const d = new Date(ts);
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return d.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(days > 300 ? { year: 'numeric' } : {}),
  });
}

// the log following its newest line, eased down rather than snapped, a jump
// past a screen (history, a conversation coming up) still snapped
export let glide = 0;
export const nearBottom = () => !!glide || chatLog.scrollTop + chatLog.clientHeight >= chatLog.scrollHeight - 20;
export function toBottom() {
  if (glide) return;
  const step = () => {
    const gap = chatLog.scrollHeight - chatLog.clientHeight - chatLog.scrollTop;
    if (gap <= 1 || gap > chatLog.clientHeight) {
      chatLog.scrollTop = chatLog.scrollHeight;
      glide = 0;
      return;
    }
    chatLog.scrollTop += Math.ceil(gap * 0.2);
    glide = requestAnimationFrame(step);
  };
  glide = requestAnimationFrame(step);
}
// the reader scrolling away ending the glide
for (const ev of ['wheel', 'touchmove'])
  chatLog.addEventListener(
    ev,
    () => {
      cancelAnimationFrame(glide);
      glide = 0;
    },
    { passive: true },
  );
chatLog.addEventListener('scroll', () => {
  stateVars.chatPinned = nearBottom();
});
// math refitted when the width moves or katex's fonts land
export const refitMath = () => {
  for (const t of chatLog.querySelectorAll<HTMLElement>('.md')) if (t.querySelector('.katex')) fitMath(t);
};
document.fonts.addEventListener('loadingdone', refitMath);
export let chatWidth = 0;
new ResizeObserver(() => {
  if (chatLog.clientWidth !== chatWidth) {
    chatWidth = chatLog.clientWidth;
    refitMath();
  }
  if (stateVars.chatPinned) chatLog.scrollTop = chatLog.scrollHeight;
}).observe(chatLog);

// @name lit, outside code, true when it's this browser's own
export function markMentions(el: HTMLElement): boolean {
  if (!st.name) return false;
  let me = false;
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      (n as Text).parentElement!.closest('code, pre, a, .katex') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const hits: Text[] = [];
  while (walk.nextNode()) if (walk.currentNode.nodeValue!.includes('@')) hits.push(walk.currentNode as Text);
  for (const t of hits) {
    const parts = t.nodeValue!.split(/(@[\w.-]+)/);
    if (parts.length < 2) continue;
    t.replaceWith(
      ...parts.map((p, i) => {
        if (i % 2 === 0) return p;
        const s = Object.assign(document.createElement('span'), { className: 'mention', textContent: p });
        if (p.slice(1).toLowerCase() === st.name.toLowerCase()) {
          s.classList.add('me');
          me = true;
        }
        return s;
      }),
    );
  }
  return me;
}
