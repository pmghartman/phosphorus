// conversations

import type { ChannelMeta } from '@phosphorus/wire';
import { deskBadge } from '../../desktop/taskbar.ts';
import { el } from '../../lib/dom.ts';
import { deskApps, dk, st } from '../../lib/state.ts';
import { loadJson } from '../../lib/util.ts';
import { away, dropUnread, notesReadConv } from '../notes.ts';
import { CHANNEL_CHIP, startCommand } from './commands.ts';
import { openConv, setConv, typers } from './files.ts';
import { convLines } from './lines.ts';
import { convMenu } from './menus.ts';
import { chatAwake } from './socket.ts';
import { chatName, chatPanel, chatText, chatTitle, colorFor, cwList, joined, stateVars } from './state.ts';

// back on the tab: badge cleared, however many piled up
export function clearUnread(): void {
  if (chatReading(convsVars.conv)) {
    stampRead(convsVars.conv);
    notesReadConv(convsVars.conv);
  }
  dropUnread();
}

document.addEventListener('visibilitychange', clearUnread);
window.addEventListener('focus', clearUnread);

// a conversation on screen and being read: no bell entry for its lines
export const chatReading = (c: string) => !away() && c === convsVars.conv && (!dk.desk || deskApps.has('chat'));

// mesh and the channels anyone opens, and people's dms (kept by the mesh,
// shown to their two ends)

export const CHANNELS_KEY = 'phosphorus-chat-channels';

// the module's variables other modules set
export const convsVars = {
  // channels opened here, kept listed before anyone has said a word in them
  myChannels: loadJson<string[]>(CHANNELS_KEY, []),
  // mesh, ch:<name> or dm:<name>
  conv: 'mesh',
  // the conversation the divider was drawn for, and how many lines it marks
  freshFrom: 0,
  // each channel's mesh-wide meta: when made, its topic, its last close
  chMetas: {} as Record<string, ChannelMeta>,
};
// the conversation on screen
export const convNow = () => convsVars.conv;
// channels left here, by when, hidden until a line comes after
export const LEFT_KEY = 'phosphorus-chat-left';
export let leftChannels = loadJson<Record<string, number>>(LEFT_KEY, {}) || {};
export const saveChannels = () => {
  try {
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(convsVars.myChannels));
    localStorage.setItem(LEFT_KEY, JSON.stringify(leftChannels));
  } catch {}
};
// unread lines by conversation
export const news = new Map<string, number>();

export const dmWith = (c: string) => (c.startsWith('dm:') ? c.slice(3) : '');
export const chOf = (c: string) => (c.startsWith('ch:') ? c.slice(3) : '');
export const convName = (c: string) =>
  c === 'mesh' ? '#mesh' : chOf(c) ? `#${chOf(c)}` : dmWith(c) ? `@${dmWith(c)}` : c;
export const convHint = () => `message ${convName(convsVars.conv)}`;

// per conversation, the newest line seen here, kept so a tab opened later
// counts what came while it was closed
export const READ_KEY = 'phosphorus-chat-readat';
export const readAt: Record<string, number> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(READ_KEY)!);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
})();

export function stampRead(c: string) {
  const at = lastAt(c);
  if (readAt[c]! >= at) return;
  readAt[c] = at;
  try {
    localStorage.setItem(READ_KEY, JSON.stringify(readAt));
  } catch {}
}

// a conversation read: its count gone, its place kept
export function readConv(c: string) {
  news.delete(c);
  stampRead(c);
}

export function noteNews(c: string) {
  if (c === convsVars.conv && !away() && chatPanel.offsetParent) {
    stampRead(c);
    return;
  }
  news.set(c, (news.get(c) || 0) + 1);
  paintConvs();
}
export const chOpen = (m: ChannelMeta) => !!m.created && m.created > (m.closedAt || 0);

// every channel: mesh, those open mesh-wide or with lines, those opened here
export function channels(): string[] {
  const seen = [...convLines.keys()].filter((c) => c.startsWith('ch:') && convLines.get(c)!.length).map(chOf);
  const open = Object.keys(convsVars.chMetas).filter((ch) => chOpen(convsVars.chMetas[ch]!));
  const shown = [...seen, ...open].filter(
    (ch) => !(leftChannels[ch]! >= Math.max(lastAt(`ch:${ch}`), convsVars.chMetas[ch]?.created || 0)),
  );
  return [...new Set([...shown, ...convsVars.myChannels])].sort();
}

export const lastAt = (c: string) => convLines.get(c)?.at(-1)?.timestamp || 0;
export function topicOf(c: string): string {
  const m = convsVars.chMetas[chOf(c)];
  if (m && chOpen(m)) return m.topic || '';
  return convLines.get(c)?.findLast((x) => x.kind === 'topic' && x.text)?.text || '';
}

// everyone to dm, by name so a new line never moves a chat
export function dmNames(): string[] {
  const talked = [...convLines.keys()].map(dmWith).filter(Boolean);
  return [...new Set([...talked, ...stateVars.people.map((p) => p.name)])]
    .filter((n) => n !== st.name)
    .sort((a, b) => a.localeCompare(b));
}

// the conversations in the list's order
export const convOrder = () => ['mesh', ...channels().map((ch) => `ch:${ch}`), ...dmNames().map((n) => `dm:${n}`)];

// ctrl+↑↓: the one above or below in the list, wrapping
export function stepConv(step: number): void {
  const order = convOrder();
  const at = order.indexOf(convsVars.conv);
  openConv(order[(Math.max(0, at) + step + order.length) % order.length]!);
}

// the list, in the tab beside the chat or the corner's menu
export function convItems(): HTMLElement[] {
  const online = new Map(stateVars.people.map((p) => [p.name, p]));
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
  const item = (
    c: string,
    label: string,
    { sub = '', dot, hue }: { sub?: string; dot?: boolean; hue?: string } = {},
  ) => {
    const row = el('div', 'cw-row');
    const b = Object.assign(el('button', `cw-item${c === convsVars.conv ? ' on' : ''}`), { type: 'button' });
    b.dataset.conv = c;
    if (dot !== undefined)
      b.append(Object.assign(el('span', `cw-dot${dot ? ' up' : ''}`), { title: dot ? 'online' : 'offline' }));
    const l = el('span', 'cw-name', label);
    if (hue) l.style.color = hue;
    b.append(l);
    if (typers(c).length) b.append(el('span', 'cw-typing', '···'));
    else if (sub) b.append(el('span', 'cw-sub', sub));
    const k = news.get(c);
    if (k && c !== convsVars.conv) b.append(el('span', 'chat-badge', `${k > 99 ? '99+' : k}`));
    const more = Object.assign(el('button', 'cw-more', '…'), {
      type: 'button',
      title: `${convName(c)}: more (.)`,
      tabIndex: -1,
    });
    more.dataset.conv = c;
    row.append(b, more);
    return row;
  };
  const hueOf = (n: string) =>
    online.get(n)?.color || convLines.get(`dm:${n}`)?.findLast((m) => m.name === n)?.color || colorFor(n);
  return [
    head('channels', ['open a channel', () => startCommand(CHANNEL_CHIP[0])]),
    item('mesh', '# mesh', { sub: `${stateVars.people.length} online` }),
    ...channels().map((ch) => item(`ch:${ch}`, `# ${ch}`)),
    head('direct'),
    ...names.map((n) => item(`dm:${n}`, n, { dot: online.has(n), hue: hueOf(n) })),
  ];
}

export function paintConvs() {
  const total = [...news].reduce((n, [c, k]) => n + (c === convsVars.conv ? 0 : k), 0);
  deskBadge(total);
  (chatTitle.querySelector('.chat-title-dot') as HTMLElement).hidden = !total;
  cwList.replaceChildren(...convItems());
}

for (const list of [cwList]) {
  list.addEventListener('click', (e) => {
    const more = (e.target as Element).closest('.cw-more') as HTMLElement | null;
    if (more) {
      e.stopPropagation();
      convMenu(more.dataset.conv!, more);
      return;
    }
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) chatAwake(true);
});
