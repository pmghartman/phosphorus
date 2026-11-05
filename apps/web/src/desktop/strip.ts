// the desktop switcher: a button on the bar naming the desktop shown, and a filmstrip along the
// bottom of the screen, each desktop a card of its own wallpaper; a host not logged into locked

import { dkUnlock } from '../features/account.ts';
import { hostSwitchNow } from '../features/mesh/mesh.ts';
import { DK_GLYPHS, DK_UI, dkGlyph, el } from '../lib/dom.ts';
import { dk, st } from '../lib/state.ts';
import { dkSettings } from '../settings/settings.ts';
import { hostInfo, hostPeek, wallSrc } from './desk/hosts.ts';
import { wallMine } from './desk/wallpaper.ts';
import { dkMenu } from './desk.ts';
import { dkSpace, spaceGlyph, spaceName } from './spaces.ts';
import { dkPopReg, dkPopsClose } from './taskbar.ts';

let btn: HTMLButtonElement | undefined;
let strip: HTMLElement | undefined;

// the desktops: the shared one, then each host up, logged in first, the one serving this page first
function desktops(): string[] {
  const up = new Set([...st.terminalHosts, st.selfHost]);
  const rank = (h: string) => (dk.creds.has(h) ? 0 : 1);
  const hosts = [...new Set([...dk.creds.keys(), ...st.terminalHosts])]
    .filter((h) => up.has(h))
    .sort((a, b) => rank(a) - rank(b) || Number(b === st.selfHost) - Number(a === st.selfHost) || a.localeCompare(b));
  return ['', ...hosts];
}

// the bar's button: the desktop shown, a press the filmstrip
export function dkStripPaint(): void {
  const hosts = dk.desk?.hosts;
  if (!hosts) return;
  if (!btn || !hosts.contains(btn)) {
    if (!btn) dkPopReg('strip', show);
    btn = Object.assign(el('button', 'dk-space-btn'), {
      type: 'button',
      title: 'desktops (ctrl+alt+page up or down)',
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

function show(on: boolean) {
  if (!dk.desk || !btn) return;
  if (!strip || !dk.desk.el.contains(strip)) {
    strip = Object.assign(el('div', 'dk-strip'), { hidden: true });
    strip.setAttribute('role', 'listbox');
    strip.setAttribute('aria-label', 'desktops');
    strip.addEventListener('keydown', keys);
    dk.desk.el.append(strip);
  }
  if (!on && strip.hidden) return;
  if (on) dkPopsClose('strip');
  strip.hidden = !on;
  btn.setAttribute('aria-expanded', String(on));
  if (!on) return;
  place();
  fill();
  strip.querySelector<HTMLElement>('.dk-card.cur')?.focus({ preventScroll: true });
  strip.querySelector('.dk-card.cur')?.scrollIntoView({ inline: 'center', block: 'nearest' });
}

// along the bottom, above a bar there
function place() {
  if (!strip || !dk.desk) return;
  const bars = [dk.desk.bar, dk.desk.menubar].map((b) => b.getBoundingClientRect());
  const low = bars.filter((r) => r.height && r.bottom >= innerHeight - 2).map((r) => r.top);
  strip.style.bottom = `${(low.length ? innerHeight - Math.min(...low) : 0) + 10}px`;
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
  else if (!h || dk.creds.has(h)) box.append(dkGlyph(spaceGlyph(h), 'dk-card-mark'));
  return box;
}

function card(h: string): HTMLButtonElement {
  const locked = !!h && !dk.creds.has(h);
  const here = hostSwitchNow()?.to || st.selfHost;
  const wins = [...dk.wins.values()].filter((w) => (w.space ?? '') === h && !w.leaving).length;
  const b = Object.assign(el('button', `dk-card${h === dk.space ? ' cur' : ''}${locked ? ' locked' : ''}`), {
    type: 'button',
    title: locked
      ? `log in to ${h}`
      : h
        ? `${h}'s desktop: its apps, files and terminals${h === here ? `; this page is served by ${h}` : ''}`
        : 'the shared desktop: phosphorus and the apps added to it',
  });
  b.setAttribute('role', 'option');
  b.setAttribute('aria-selected', String(h === dk.space));
  const pic = shot(h);
  if (locked) pic.append(dkGlyph(DK_GLYPHS.lock!, 'dk-card-lock'));
  const label = el('span', 'dk-card-t');
  label.append(
    dkGlyph(locked ? DK_GLYPHS.lock! : spaceGlyph(h), 'dk-card-ic'),
    el('span', 'dk-card-name', spaceName(h)),
  );
  const note = locked ? 'log in' : wins ? `${wins} ${wins === 1 ? 'window' : 'windows'}` : '';
  if (note) label.append(el('span', 'dk-card-n', note));
  b.append(pic, label);
  b.addEventListener('click', () => {
    // the login asked for by the switcher's button, the strip closed under it
    if (locked) {
      show(false);
      if (btn) dkUnlock(h, btn, () => dkSpace(h));
      return;
    }
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
          [locked ? `log in to ${h}` : `${h}'s desktop`, () => b.click(), true],
          ['settings', () => dkSettings('hosts', h), true],
        ],
        undefined,
        h,
      );
    });
  return b;
}

function fill() {
  if (!strip) return;
  const ids = desktops();
  strip.replaceChildren(...ids.map(card));
  // a logged in host never seen in this browser: its last desk asked for, its wallpaper then shown
  for (const h of ids)
    if (h && dk.creds.has(h) && !hostInfo(h).desk)
      void hostPeek(h).then((got) => {
        if (got && strip && !strip.hidden) fill();
      });
}

function keys(e: KeyboardEvent) {
  const cards = [...(strip?.querySelectorAll<HTMLElement>('.dk-card') ?? [])];
  const i = cards.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault();
    const n = cards[Math.max(0, Math.min(cards.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))];
    n?.focus();
    n?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }
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
