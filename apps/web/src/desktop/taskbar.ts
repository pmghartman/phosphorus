// the task bar along the bottom: the windows, the host chips, the status items and the clock,
// every popup grown out of a bar button

import { hostSwitchNow } from '../features/mesh/mesh.ts';
import { DK_GLYPHS, DK_UI, dkGlyph, el } from '../lib/dom.ts';
import { dk, st } from '../lib/state.ts';
import { when } from '../lib/util.ts';
import { dkSettings } from '../settings/settings.ts';
import { dkMenu, dkMenuEl } from './desk.ts';
import { dkStripPaint } from './strip.ts';
import { dkMin, dkShown } from './windows.ts';

export function dkBar(...before: HTMLElement[]): HTMLElement {
  const bar = el('div', 'dk-bar');
  dk.clock = el('span', 'dk-clock');
  if (!before.length) bar.appendChild(el('span', 'dk-tasks'));
  bar.append(...before.slice(0, 2), dk.clock, ...before.slice(2));
  dkClock();
  return bar;
}

// a phone's way back to its icons: every window down into the bar
export function dkHomeBtn(): HTMLButtonElement {
  const b = Object.assign(el('button', 'dk-home'), {
    type: 'button',
    title: 'show desktop',
    ariaLabel: 'show desktop',
  });
  b.appendChild(dkGlyph(DK_UI.desk!));
  b.addEventListener('click', () => {
    for (const w of dk.wins.values()) if (dkShown(w)) dkMin(w);
  });
  return b;
}

export function dkClock(): void {
  if (dk.clock) dk.clock.textContent = when(Date.now(), true);
}

// the desktop switcher on the bar, its filmstrip along the bottom (./strip.ts), drawn again
export const dkChips = (): void => dkStripPaint();

// --- task bar popups: each grown out of its own button, its bottom on the
// bar's top, a corner on the button's, right of it where it fits, else left

const DK_POP_GAP = 6;

// the quick buttons' popups by id (./quick.ts), closed with the rest
const quickPops = new Map<string, (on: boolean) => void>();
export const dkPopReg = (id: string, show: (on: boolean) => void) => void quickPops.set(id, show);

// one task bar popup open at a time, every other closed as one opens
export function dkPopsClose(keep?: string): void {
  for (const [id, show] of quickPops) if (keep !== id) show(false);
  if (keep !== 'bell') dk.bell?.show(false);
  if (keep !== 'ctl') dk.ctl?.show(false);
  if (keep !== 'mcp') dk.mcp?.show(false);
  if (keep !== 'menu') dkMenuEl.hidden = true;
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
    if (
      cs.transform !== 'none' ||
      cs.filter !== 'none' ||
      cs.backdropFilter !== 'none' ||
      cs.perspective !== 'none' ||
      /paint|layout|strict|content/.test(cs.contain) ||
      /transform|filter|perspective/.test(cs.willChange)
    ) {
      const r = a.getBoundingClientRect();
      return { left: r.left + a.clientLeft, top: r.top + a.clientTop, bottom: r.top + a.clientTop + a.clientHeight };
    }
  }
  return { left: 0, top: 0, bottom: innerHeight };
}

export function dkAnchor(
  pop: Pop,
  btn: HTMLElement,
  { fill = 0, tall = 0 }: { fill?: number; tall?: number } = {},
): void {
  pop.dkAnchor = { btn, fill, tall };
  if (!pop.dkPlace) {
    const ro = new ResizeObserver(() => pop.dkPlace!());
    pop.dkPlace = () => {
      const a = pop.dkAnchor;
      if (!a || pop.hidden || !pop.isConnected || !a.btn.isConnected) return;
      // a window's own button: under it, kept on the screen
      if (a.btn.closest('.dk-win')) {
        const r = a.btn.getBoundingClientRect();
        const cb = dkFixedFrame(pop);
        pop.style.right = pop.style.bottom = 'auto';
        pop.style.top = `${Math.min(r.bottom + DK_POP_GAP, innerHeight - DK_POP_EDGE - pop.offsetHeight) - cb.top}px`;
        pop.style.left = `${Math.max(DK_POP_EDGE, Math.min(r.left, innerWidth - DK_POP_EDGE - pop.offsetWidth)) - cb.left}px`;
        return;
      }
      // the bar's edges the limits, so a popup lines up with it
      const barEl = (a.btn.closest('.dk-bar') as HTMLElement | null) || a.btn;
      const bar = barEl.getBoundingClientRect();
      // fixed, but inside the bar its blur makes the bar the frame of reference
      const cb = dkFixedFrame(pop);
      pop.style.top = 'auto';
      pop.style.right = 'auto';
      const lo = Math.max(DK_POP_EDGE, bar.left);
      const hi = Math.min(innerWidth - DK_POP_EDGE, bar.right);
      pop.style.bottom = `${cb.bottom - bar.top + DK_POP_GAP}px`;
      if (a.tall) pop.style.height = `${Math.min(a.tall, bar.top - DK_POP_GAP - DK_POP_EDGE)}px`;
      if (a.fill) pop.style.width = `${Math.min(hi - lo, a.fill)}px`;
      // against the screen's right edge, as the bar ends; a button on the left half grows rightward
      const bl = a.btn.getBoundingClientRect().left;
      const left =
        bl < innerWidth / 2 ? Math.max(lo, Math.min(bl, hi - pop.offsetWidth)) : Math.max(lo, hi - pop.offsetWidth);
      pop.style.left = `${left - cb.left}px`;
    };
    // shown, grown or the screen resized: placed again
    ro.observe(pop);
    const place = pop.dkPlace;
    addEventListener('resize', place);
    pop.dkRelease = () => {
      ro.disconnect();
      removeEventListener('resize', place);
      pop.dkPlace = null;
    };
  }
  pop.dkPlace();
}
