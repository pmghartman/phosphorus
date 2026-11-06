// the desktop switcher: a button on the bar naming the desktop shown, and a filmstrip along the
// bottom of the screen, each desktop a card of its own wallpaper; the hosts logged into alone

import { hostSwitchNow } from '../features/mesh/mesh.ts';
import { DK_UI, dkGlyph, el } from '../lib/dom.ts';
import { dk, st } from '../lib/state.ts';
import { dkSettings } from '../settings/settings.ts';
import { hostInfo, hostWarm, wallSrc } from './desk/hosts.ts';
import { wallMine } from './desk/wallpaper.ts';
import { dkMenu } from './desk.ts';
import { dkSpace, spaceGlyph, spaceName } from './spaces.ts';
import { dkPopReg, dkPopsClose } from './taskbar.ts';

let btn: HTMLButtonElement | undefined;
let strip: HTMLElement | undefined;

// the desktops: the shared one, then each host logged into and up, the one serving this page first
function desktops(): string[] {
  const up = new Set([...st.terminalHosts, st.selfHost]);
  const hosts = [...dk.creds.keys()]
    .filter((h) => up.has(h))
    .sort((a, b) => Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b));
  return ['', ...hosts];
}

// the bar's button: the desktop shown, a press the filmstrip
export function dkStripPaint(): void {
  const hosts = dk.desk?.hosts;
  if (!hosts) return;
  if (!btn || !hosts.contains(btn)) {
    if (!btn) {
      dkPopReg('strip', show);
      // its cards built while the page is idle, the first press as quick as the rest
      (window.requestIdleCallback ?? setTimeout)(() => {
        if (make() && strip?.hidden) fill(false);
      });
    }
    btn = Object.assign(el('button', 'dk-space-btn'), {
      type: 'button',
      title: 'desktops',
      ariaLabel: 'desktops',
    });
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', () => show(!strip || !!strip.hidden));
    hosts.replaceChildren(btn);
  }
  btn.replaceChildren(
    dkGlyph(spaceGlyph(), 'dk-space-ic'),
    el('span', 'dk-space-t', spaceName()),
    dkGlyph(DK_UI.up!, 'dk-space-chev'),
  );
  if (strip && !strip.hidden) fill();
}

// the shelf made once, hidden until asked for
function make(): HTMLElement | undefined {
  if (!dk.desk) return;
  if (!strip || !dk.desk.el.contains(strip)) {
    strip = Object.assign(el('div', 'dk-strip'), { hidden: true });
    strip.setAttribute('role', 'listbox');
    strip.setAttribute('aria-label', 'desktops');
    strip.addEventListener('keydown', keys);
    dk.desk.el.append(strip);
  }
  return strip;
}

function show(on: boolean) {
  if (!btn || !make() || !strip) return;
  if (!on && strip.hidden) return;
  if (on) dkPopsClose('strip');
  strip.hidden = !on;
  btn.setAttribute('aria-expanded', String(on));
  if (!on) return;
  fill();
  strip.querySelector<HTMLElement>('.dk-card.cur')?.focus({ preventScroll: true });
  strip.querySelector('.dk-card.cur')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// a shelf on the task bar: as wide as it, centred on it, just above it
const GAP = 8;
function place() {
  if (!strip || !dk.desk) return;
  const r = dk.desk.bar.getBoundingClientRect();
  const st = strip.style;
  // wider for its cards where they need it
  const row = strip.querySelector<HTMLElement>('.dk-strip-row');
  const need = row ? row.scrollWidth + (strip.offsetWidth - row.clientWidth) : 0;
  const w = Math.min(innerWidth - 2 * GAP, Math.max(r.width, need));
  const mid = r.left + r.width / 2;
  st.left = `${Math.max(GAP, Math.min(innerWidth - GAP - w, mid - w / 2))}px`;
  st.width = `${w}px`;
  st.bottom = `${innerHeight - r.top + GAP}px`;
}

// a desktop's picture: its wallpaper, else phosphorus's or the OS's glyph on the desk's own colour
function shot(h: string): HTMLElement {
  const box = el('span', 'dk-card-shot');
  let url = '';
  if (!h || wallMine(h)) url = st.acct?.wallpaper ? `/api/me/wallpaper?v=${st.acct.wallpaper}` : '';
  else {
    const d = hostInfo(h).desk;
    if (d) {
      url = wallSrc(h, d);
      if (d.wallpaper.color) box.style.backgroundColor = d.wallpaper.color;
    }
  }
  if (url) box.style.backgroundImage = `url("${url}")`;
  else box.append(dkGlyph(spaceGlyph(h), 'dk-card-mark'));
  return box;
}

function card(h: string): HTMLButtonElement {
  const here = hostSwitchNow()?.to || st.selfHost;
  const wins = [...dk.wins.values()].filter((w) => (w.space ?? '') === h && !w.leaving).length;
  const b = Object.assign(el('button', `dk-card${h === dk.space ? ' cur' : ''}`), {
    type: 'button',
    title: h
      ? `${h}'s desktop: its apps, files and terminals${h === here ? `; this page is served by ${h}` : ''}`
      : 'the shared desktop: phosphorus and the apps added to it',
  });
  b.setAttribute('role', 'option');
  b.setAttribute('aria-selected', String(h === dk.space));
  const pic = shot(h);
  const label = el('span', 'dk-card-t');
  label.append(dkGlyph(spaceGlyph(h), 'dk-card-ic'), el('span', 'dk-card-name', spaceName(h)));
  const note = wins ? `${wins} ${wins === 1 ? 'window' : 'windows'}` : '';
  if (note) label.append(el('span', 'dk-card-n', note));
  b.append(pic, label);
  b.addEventListener('click', () => {
    dkSpace(h);
    show(false);
  });
  if (h)
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      dkMenu(
        e.clientX,
        e.clientY,
        [
          [`${h}'s desktop`, () => b.click(), true],
          ['settings', () => dkSettings('hosts', h), true],
        ],
        undefined,
        h,
      );
    });
  return b;
}

function fill(peek = true) {
  if (!strip) return;
  const ids = desktops();
  const head = el('div', 'dk-strip-head');
  head.append(el('span', 'dk-strip-t', 'desktops'), el('span', 'dk-strip-hint', 'ctrl+alt+page up or down'));
  const row = el('div', 'dk-strip-row');
  row.append(...ids.map(card));
  strip.replaceChildren(head, row);
  place();
  // a host never seen in this browser: its last desk asked for, its wallpaper then shown
  for (const h of peek ? ids : [])
    if (h && !hostInfo(h).desk)
      void hostWarm(h).then((got) => {
        if (got && strip && !strip.hidden) fill();
      });
}

function keys(e: KeyboardEvent) {
  const cards = [...(strip?.querySelectorAll<HTMLElement>('.dk-card') ?? [])];
  const i = cards.indexOf(document.activeElement as HTMLElement);
  const to =
    e.key === 'ArrowRight'
      ? i + 1
      : e.key === 'ArrowLeft'
        ? i - 1
        : e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? cards.length - 1
            : -2;
  if (to === -2) return;
  e.preventDefault();
  const n = cards[Math.max(0, Math.min(cards.length - 1, to))];
  n?.focus();
  n?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

document.addEventListener(
  'pointerdown',
  (e) => {
    const t = e.target as Element;
    if (strip && !strip.hidden && !strip.contains(t) && !btn?.contains(t) && !t.closest?.('.acct-unlock, .dk-menu'))
      show(false);
  },
  true,
);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && strip && !strip.hidden) show(false);
});
addEventListener('resize', () => {
  if (strip && !strip.hidden) place();
});
