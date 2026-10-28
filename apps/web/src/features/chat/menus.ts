// popup menus
import { el } from '../../lib/dom.ts';
import { notesReadConv } from '../notes.ts';
import { chOf, convName, convsVars, dmWith, leftChannels, news, paintConvs, readConv, saveChannels } from './convs.ts';
import { openConv, setConv } from './files.ts';
import { convLines, keyOf, lines, sysLine } from './lines.ts';
import { chatPop, send } from './state.ts';

// one small menu at a time, by whatever opened it: a conversation's actions or
// the attachments. ↑↓ to move, enter to pick, esc back to where it came from,
// a destructive pick asking once more before it goes

// one item of the menu: a link, or an action, a destructive one asked again
export interface PopItem { label: string; sub?: string; key?: string; danger?: boolean; confirm?: string; href?: string; thumb?: string; act?: () => void }

export let popFrom: HTMLElement | null = null;
export function closePop(refocus: boolean) {
  if (chatPop.hidden) return;
  chatPop.hidden = true;
  if (refocus && popFrom?.isConnected) popFrom.focus();
  popFrom = null;
}

// title: a heading, or a node over the items; at: a right click's point to open at
export function popMenu(anchor: HTMLElement, title: string | HTMLElement | null, items: PopItem[], focusAt = 0, at: { x: number; y: number } | null = null) {
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
export function convActions(c: string): PopItem[] {
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
export function deleteDm(dm: string) {
  if (convsVars.conv === `dm:${dm}`) setConv('mesh');
  news.delete(`dm:${dm}`);
  send({ type: 'hide-dm', with: dm });
}

export function convMenu(c: string, anchor: HTMLElement, destructive?: boolean) {
  const items = convActions(c);
  popMenu(anchor, convName(c), items, destructive ? Math.max(0, items.findIndex((it) => it.danger)) : 0);
}

export function leaveChannel(ch: string) {
  convsVars.myChannels = convsVars.myChannels.filter((x) => x !== ch);
  leftChannels[ch] = Date.now();
  saveChannels();
  if (convsVars.conv === `ch:${ch}`) setConv('mesh');
  else paintConvs();
}

// a channel closed by anyone: its lines gone here too, off every list
export function channelClosed(ch: string, by?: string) {
  const c = `ch:${ch}`;
  for (const m of convLines.get(c) || []) lines.delete(keyOf(m));
  convLines.delete(c);
  news.delete(c);
  convsVars.myChannels = convsVars.myChannels.filter((x) => x !== ch);
  saveChannels();
  if (convsVars.conv === c) setConv('mesh');
  else paintConvs();
  sysLine('mesh', `#${ch} closed${by ? ` by ${by}` : ''}`);
}
