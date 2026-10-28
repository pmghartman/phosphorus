// the task bar: its clock, the status items where the layout puts them, the host chips,
// the chat badge, and every popup grown out of a bar button
import { DK_GLYPHS, DK_UI, dkGlyph, el, isMobile } from '../lib/dom.ts';
import { toastPlace } from '../features/notes.ts';
import { dk, st } from '../lib/state.ts';
import { BAR_ITEMS, layoutNow, PALETTE_EVENT } from '../lib/theme.ts';
import { closeUpdateModal, updateModal } from '../features/update.ts';
import { dkUnlock } from '../features/account.ts';
import { hostSwitchNow } from '../features/mesh/mesh.ts';
import { dkMenuEl } from './desk.ts';
import { dkMin } from './windows.ts';

export function dkBar(...before: HTMLElement[]): HTMLElement {
  const bar = el('div', 'dk-bar');
  dk.clock = el('span', 'dk-clock');
  if (!before.length) bar.appendChild(el('span', 'dk-tasks'));
  bar.append(...before.slice(0, 2), dk.clock, ...before.slice(2));
  updateModal.classList.add('dk-pop');
  if (!st.acct?.admin) closeUpdateModal();
  dkClock();
  return bar;
}

// a phone's way back to its icons: every window down into the bar
export function dkHomeBtn(): HTMLButtonElement {
  const b = Object.assign(el('button', 'dk-home'), { type: 'button', title: 'show desktop', ariaLabel: 'show desktop' });
  b.appendChild(dkGlyph(DK_UI.desk!));
  b.addEventListener('click', () => {
    for (const w of dk.wins.values()) if (!w.node.hidden && !w.leaving) dkMin(w);
  });
  return b;
}

// the status items where the layout puts them: the menu bar while one's up (never a phone's), else
// the bar; in the layout's order, the rest hidden
export function dkPlaceItems(): void {
  const d = dk.desk;
  if (!d?.bar) return;
  const L = layoutNow();
  const home = !isMobile() && L.menubar !== 'off' ? d.menubar : d.bar;
  for (const id of [...L.items, ...BAR_ITEMS.filter((i) => !L.items.includes(i))]) {
    const n = d.items[id];
    if (!n) continue;
    n.classList.toggle('dk-unshown', !L.items.includes(id));
    home.append(n);
  }
  for (const p of document.querySelectorAll<Pop>('.dk-pop')) p.dkPlace?.();
  toastPlace();
}
addEventListener(PALETTE_EVENT, dkPlaceItems);

// the edge a bar sits on: a phone's always the bottom
export const dkBarSide = (bar: HTMLElement): string => (isMobile() || !bar.classList.contains('dk-bar') ? 'bottom'
  : bar.classList.contains('dk-menubar') ? layoutNow().menubar : layoutNow().bar);

export function dkClock(): void {
  if (!dk.clock) return;
  const d = new Date();
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
    .formatToParts(d).map((x) => [x.type, x.value]));
  dk.clock.textContent = `${p.weekday} ${p.month} ${p.day} ${p.hour}:${p.minute}${p.dayPeriod}`;
}

// the logged in hosts, the one serving this page purple, a press moving it there
const DK_CHIPS_KEY = 'phosphorus-host-chips';
const dkChipsOpen = () => { try { return localStorage.getItem(DK_CHIPS_KEY) === '1'; } catch { return false; } };

export function dkChips(): void {
  const hosts = dk.desk?.hosts;
  if (!hosts) return;
  const here = hostSwitchNow()?.to || st.selfHost;
  const up = new Set([...st.terminalHosts, st.selfHost]);
  // logged in first, the locked last
  const rank = (h: string) => (!dk.creds.has(h) ? 1 : 0);
  // a host off the mesh not shown at all
  const names = [...new Set([...dk.creds.keys(), ...st.terminalHosts])].filter((h) => up.has(h))
    .sort((a, b) => rank(a) - rank(b) || Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b));
  dkChipsFold(hosts, names.length);
  const sig = JSON.stringify([here, names, [...dk.creds.keys()]]);
  if (sig === dk.chips) return;
  dk.chips = sig;
  // every chip kept, the fold's class sliding all but the serving one shut
  const chips = names.map((h): HTMLElement => {
    if (!dk.creds.has(h)) {
      const b = Object.assign(el('button', 'dk-chip locked', h), { type: 'button', title: `log in to ${h}` });
      b.prepend(dkGlyph(DK_GLYPHS.lock!));
      b.addEventListener('click', () => dkUnlock(h, b));
      return b;
    }
    return Object.assign(el('span', `dk-chip${h === here ? ' here' : ''}`, h), { title: h === here ? `this page is served by ${h}` : `${h}, logged in` });
  });
  chips.forEach((c, i) => c.classList.toggle('cur', names[i] === here));
  hosts.replaceChildren(dk.chipFold!, ...chips);
}

// one chevron for good, so its turn and the chips' slide both animate; the
// count read fresh on a press, never the one it was made with
function dkChipsFold(hosts: HTMLElement, n: number) {
  dk.chipN = n;
  if (!dk.chipFold) {
    const b = Object.assign(el('button', 'dk-chip-fold'), { type: 'button' });
    b.appendChild(dkGlyph(DK_UI.back!));
    b.addEventListener('click', () => {
      try { localStorage.setItem(DK_CHIPS_KEY, dkChipsOpen() ? '0' : '1'); } catch {}
      dkChipsFold(hosts, dk.chipN!);
    });
    dk.chipFold = b;
  }
  const open = dkChipsOpen();
  hosts.classList.toggle('folded', !open);
  dk.chipFold.hidden = n < 2;
  dk.chipFold.title = open ? 'fewer hosts' : 'all hosts';
  dk.chipFold.setAttribute('aria-expanded', String(open));
}

export function deskBadge(total: number): void {
  st.deskNews = total;
  for (const b of document.querySelectorAll<HTMLElement>('.dk-badge')) {
    b.hidden = !total;
    b.textContent = total > 99 ? '99+' : String(total);
  }
}
export function dkBadge(): HTMLElement {
  const b = el('span', 'dk-badge', st.deskNews > 99 ? '99+' : String(st.deskNews));
  b.hidden = !st.deskNews;
  return b;
}

// --- task bar popups: each grown out of its own button, its bottom on the
// bar's top, a corner on the button's, right of it where it fits, else left

const DK_POP_GAP = 6;

// one task bar popup open at a time, every other closed as one opens
export function dkPopsClose(keep?: string): void {
  if (keep !== 'mesh') dk.meshTray?.show(false);
  if (keep !== 'bell') dk.bell?.show(false);
  if (keep !== 'ctl') dk.ctl?.show(false);
  if (keep !== 'mcp') dk.mcp?.show(false);
  if (keep !== 'menu') dkMenuEl.hidden = true;
  if (keep !== 'update' && !updateModal.hidden) closeUpdateModal();
  if (keep !== 'unlock') for (const p of document.querySelectorAll<Pop>('.acct-unlock')) p.dkClose?.();
}
const DK_POP_EDGE = 8;

// a popup placed by its button: where it is anchored, how it is placed again, released
export type Pop = HTMLElement & {
  dkAnchor?: { btn: HTMLElement; fill: number; tall: number } | null;
  dkPlace?: (() => void) | null;
  dkRelease?: () => void;
  dkClose?: () => void;
};

// fill: a popup as wide as the button's left to the screen's right, at least
// that many px; tall: as tall as the screen allows, at most that many px
// the box a fixed element is placed in: the screen, or the nearest ancestor
// whose transform, filter or blur takes that over
function dkFixedFrame(node: HTMLElement) {
  for (let a = node.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.transform !== 'none' || cs.filter !== 'none' || cs.backdropFilter !== 'none' || cs.perspective !== 'none'
      || /paint|layout|strict|content/.test(cs.contain) || /transform|filter|perspective/.test(cs.willChange)) {
      const r = a.getBoundingClientRect();
      return { left: r.left + a.clientLeft, top: r.top + a.clientTop, bottom: r.top + a.clientTop + a.clientHeight };
    }
  }
  return { left: 0, top: 0, bottom: innerHeight };
}

export function dkAnchor(pop: Pop, btn: HTMLElement, { fill = 0, tall = 0 }: { fill?: number; tall?: number } = {}): void {
  pop.dkAnchor = { btn, fill, tall };
  if (!pop.dkPlace) {
    const ro = new ResizeObserver(() => pop.dkPlace!());
    pop.dkPlace = () => {
      const a = pop.dkAnchor;
      if (!a || pop.hidden || !pop.isConnected || !a.btn.isConnected) return;
      // the bar's edges the limits, so a popup lines up with it
      const barEl = (a.btn.closest('.dk-bar') as HTMLElement | null) || a.btn;
      const bar = barEl.getBoundingClientRect();
      const side = dkBarSide(barEl);
      // fixed, but inside the bar its blur makes the bar the frame of reference
      const cb = dkFixedFrame(pop);
      pop.style.top = 'auto';
      pop.style.right = 'auto';
      pop.style.bottom = 'auto';
      // a side bar's beside it, level with its button and kept on the screen
      if (side === 'left' || side === 'right') {
        if (a.tall) pop.style.height = `${Math.min(a.tall, innerHeight - 2 * DK_POP_EDGE)}px`;
        if (a.fill) pop.style.width = `${Math.min(innerWidth - bar.width - DK_POP_GAP - 2 * DK_POP_EDGE, a.fill)}px`;
        const x = side === 'left' ? bar.right + DK_POP_GAP : bar.left - DK_POP_GAP - pop.offsetWidth;
        const y = Math.max(DK_POP_EDGE, Math.min(innerHeight - DK_POP_EDGE - pop.offsetHeight, a.btn.getBoundingClientRect().top));
        pop.style.left = `${x - cb.left}px`;
        pop.style.top = `${y - cb.top}px`;
        return;
      }
      const lo = Math.max(DK_POP_EDGE, bar.left);
      const hi = Math.min(innerWidth - DK_POP_EDGE, bar.right);
      if (side === 'top') pop.style.top = `${bar.bottom + DK_POP_GAP - cb.top}px`;
      else pop.style.bottom = `${cb.bottom - bar.top + DK_POP_GAP}px`;
      const room = side === 'top' ? innerHeight - bar.bottom : bar.top;
      if (a.tall) pop.style.height = `${Math.min(a.tall, room - DK_POP_GAP - DK_POP_EDGE)}px`;
      if (a.fill) pop.style.width = `${Math.min(hi - lo, a.fill)}px`;
      // every task bar popup against the screen's right edge, as the bar ends
      const left = Math.max(lo, hi - pop.offsetWidth);
      pop.style.left = `${left - cb.left}px`;
    };
    // shown, grown or the screen resized: placed again
    ro.observe(pop);
    const place = pop.dkPlace;
    addEventListener('resize', place);
    pop.dkRelease = () => { ro.disconnect(); removeEventListener('resize', place); pop.dkPlace = null; };
  }
  pop.dkPlace();
}
