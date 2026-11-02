// the terminal: one window of tabs, as Windows Terminal's, each tab a shell on a host;
// its + a tab on the usual host, its ▾ any device, a login asked for there and then

import { app } from '../../apps/index.ts';
import type { Term } from '../../apps/terminal.ts';
import { dkUnlock } from '../../features/account.ts';
import { agentDisown } from '../../features/agent.ts';
import { DK_GLYPHS, DK_UI, dkGlyph, el } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { newSid } from '../../lib/util.ts';
import { type DkWin, dkClose, dkFocus, dkTouch, dkWin } from '../windows.ts';
import { dkLiveHosts } from './icons.ts';
import { type TermTab, tabAdd, tabClose, tabDefaultHost, tabLabel, tabMove, tabStep } from './termtabs.ts';
import { dkMenu, dkMenuEl, type MenuItem } from './wallpaper.ts';

interface Tab extends TermTab {
  // shared with phosphorus, its agent watching
  shared: boolean;
  pane: HTMLElement;
  btn: HTMLElement;
  term: Promise<Term>;
}

const KEY = 'terminal';
const LAST_KEY = 'phosphorus-term-last';
let tabs: Tab[] = [];
let active: number | null = null;
let strip: HTMLElement | null = null;
let pick: HTMLButtonElement | null = null;

const cur = () => tabs.find((t) => t.id === active);
const lastHost = () => {
  try {
    return localStorage.getItem(LAST_KEY) || '';
  } catch {
    return '';
  }
};

// a device's OS by what tailscale or its info.json says, its glyph by that
function osOf(host: string): string {
  const d = st.lastState?.tailnet?.find((x) => x.name === host);
  return d?.os || st.hostsInfo[host.toLowerCase()]?.platform || '';
}
const osGlyph = (os: string) =>
  DK_GLYPHS[
    /win/i.test(os)
      ? 'windows'
      : /mac|darwin|ios/i.test(os)
        ? 'apple'
        : /linux|android|bsd/i.test(os)
          ? 'linux'
          : 'terminal'
  ]!;

// every phosphorus device: up first, the serving one first among them
function devices() {
  const up = new Set([...st.terminalHosts, st.selfHost].filter(Boolean));
  const names = new Set(up);
  for (const d of st.lastState?.tailnet ?? []) if (d.phosphorus || d.phosphorusSeen) names.add(d.name);
  return [...names]
    .map((name) => ({ name, os: osOf(name), up: up.has(name), login: dk.creds.has(name) }))
    .sort(
      (a, b) =>
        Number(b.up) - Number(a.up) ||
        Number(b.name === st.selfHost) - Number(a.name === st.selfHost) ||
        a.name.localeCompare(b.name),
    );
}

const btn = (cls: string, d: string, label: string) => {
  const b = Object.assign(el('button', cls), { type: 'button', title: label, ariaLabel: label });
  b.appendChild(dkGlyph(d));
  return b;
};

// the window, made once: its tabs in the title bar where the title was
function termWin(): DkWin | null {
  const had = dk.wins.get(KEY);
  if (had) return had;
  const w = dkWin(KEY, 'terminal', '', 'term dk-terms');
  if (!w) return null;
  const bar = el('div', 'dk-tbar');
  strip = el('div', 'dk-tabs');
  strip.setAttribute('role', 'tablist');
  const add = btn('dk-tab-add', DK_UI.plus!, 'new tab (ctrl+alt+t)');
  add.addEventListener('click', () => dkTermNew());
  pick = btn('dk-tab-pick', DK_UI.down!, 'open a tab on…');
  pick.setAttribute('aria-haspopup', 'menu');
  pick.addEventListener('click', termPick);
  bar.append(strip, add, pick);
  w.head.insertBefore(bar, w.head.querySelector('.dk-btns'));
  w.body.appendChild(el('div', 'dk-terms-empty', 'open a tab on a device from ▾ above'));
  // ctrl+tab and ctrl+shift+tab through the tabs, before the shell sees them
  w.node.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Tab' || !e.ctrlKey || e.altKey || e.metaKey || active == null) return;
      e.preventDefault();
      e.stopPropagation();
      termShow(tabStep(tabs, active, e.shiftKey));
    },
    true,
  );
  w.onFocus = () => cur()?.term.then((t) => t.focus());
  w.onClose = () => {
    for (const t of tabs) t.term.then((x) => x.close());
    tabs = [];
    active = null;
    strip = null;
    pick = null;
  };
  return w;
}

// one tab brought forward, its shell sized and focused
function termShow(id: number | null) {
  const t = tabs.find((x) => x.id === id);
  const w = dk.wins.get(KEY);
  if (!t || !w || !strip) return;
  active = t.id;
  for (const o of tabs) {
    const on = o === t;
    o.pane.hidden = !on;
    o.btn.classList.toggle('active', on);
    o.btn.setAttribute('aria-selected', String(on));
  }
  try {
    localStorage.setItem(LAST_KEY, t.host);
  } catch {}
  // scrolled into the strip, never the page
  const b = t.btn;
  if (b.offsetLeft < strip.scrollLeft) strip.scrollLeft = b.offsetLeft;
  else if (b.offsetLeft + b.offsetWidth > strip.scrollLeft + strip.clientWidth)
    strip.scrollLeft = b.offsetLeft + b.offsetWidth - strip.clientWidth;
  w.task.title = `terminal ${t.host}`;
  t.term.then((x) => x.show());
  dkTouch();
}

// each tab's label, and its OS once the mesh has said it
function termLabels() {
  for (const t of tabs) {
    t.btn.querySelector('.dk-tab-t')!.textContent = tabLabel(tabs, t);
    t.btn.querySelector('.dk-tab-os path')!.setAttribute('d', osGlyph(osOf(t.host)));
    t.btn.title = t.shared ? `${t.host}, shared with phosphorus` : t.host;
  }
}

function termClose(t: Tab) {
  const next = tabClose(tabs, t.id, active ?? t.id);
  t.term.then((x) => x.close());
  t.pane.remove();
  t.btn.remove();
  const w = dk.wins.get(KEY);
  if (!tabs.length) {
    if (w) dkClose(w);
    return;
  }
  termLabels();
  termShow(next);
}

// a tab on a host this desktop is logged into
function termTab(host: string, run: string, shared: boolean): DkWin | undefined {
  const c = dk.creds.get(host);
  if (!c) return;
  const w = termWin();
  if (!w || !strip) return;
  const pane = el('div', 'dk-tpane');
  w.body.appendChild(pane);
  const b = el('div', 'dk-tab');
  b.setAttribute('role', 'tab');
  const x = btn('dk-tab-x', DK_UI.close!, 'close tab');
  b.append(dkGlyph(osGlyph(osOf(host)), 'dk-tab-os'), el('span', 'dk-tab-t'), x);
  if (shared) b.classList.add('shared');
  const t = tabAdd(tabs, host, { shared, pane, btn: b, term: null as unknown as Promise<Term> });
  t.term = app('terminal').then((m) =>
    m.startTerminal(
      pane,
      host,
      newSid(),
      false,
      shared,
      { ...c, run },
      {
        themeFrom: w.body,
        onEnd: () => b.classList.add('ended'),
      },
    ),
  );
  x.addEventListener('click', () => termClose(t));
  // a middle click closes, as a browser's tab
  b.addEventListener('mousedown', (e) => {
    if (e.button === 1) e.preventDefault();
  });
  b.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      termClose(t);
    }
  });
  b.addEventListener('dblclick', (e) => e.stopPropagation());
  b.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dkMenu(
      e.clientX,
      e.clientY,
      [
        ['duplicate tab', () => termTab(host, '', false), dk.creds.has(host)],
        null,
        ['close other tabs', () => tabs.filter((o) => o !== t).forEach(termClose), tabs.length > 1],
        ['close tab', () => termClose(t), true, 'danger'],
      ],
      undefined,
      tabLabel(tabs, t),
    );
  });
  termDrag(t);
  strip.appendChild(b);
  termLabels();
  termShow(t.id);
  dkFocus(w);
  return w;
}

// pressed: shown; dragged sideways: moved past the tabs it crosses
function termDrag(t: Tab) {
  t.btn.addEventListener('pointerdown', (e) => {
    // the window's own move left to its empty title bar
    e.stopPropagation();
    if (e.button !== 0 || (e.target as Element).closest('.dk-tab-x')) return;
    termShow(t.id);
    const x0 = e.clientX;
    let moving = false;
    const move = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.abs(ev.clientX - x0) < 5) return;
        moving = true;
        t.btn.setPointerCapture(ev.pointerId);
        t.btn.classList.add('dragging');
      }
      const i = tabs.indexOf(t);
      const over = tabs.findIndex((o) => {
        const r = o.btn.getBoundingClientRect();
        return ev.clientX >= r.left && ev.clientX < r.right;
      });
      if (over < 0 || over === i) return;
      // past the other's middle only, so a wide tab doesn't flap
      const r = tabs[over]!.btn.getBoundingClientRect();
      if (over > i ? ev.clientX < r.left + r.width / 2 : ev.clientX > r.left + r.width / 2) return;
      tabMove(tabs, i, over);
      // the others moved round it, so its pointer capture holds
      const k = tabs.indexOf(t);
      for (const o of tabs.slice(0, k)) strip!.insertBefore(o.btn, t.btn);
      let ref = t.btn.nextSibling;
      for (const o of tabs.slice(k + 1)) {
        strip!.insertBefore(o.btn, ref);
        ref = o.btn.nextSibling;
      }
      termLabels();
    };
    const up = () => {
      t.btn.removeEventListener('pointermove', move);
      t.btn.removeEventListener('pointerup', up);
      t.btn.removeEventListener('pointercancel', up);
      t.btn.classList.remove('dragging');
      if (moving) dkTouch();
    };
    t.btn.addEventListener('pointermove', move);
    t.btn.addEventListener('pointerup', up);
    t.btn.addEventListener('pointercancel', up);
  });
}

// the ▾: every device, its OS and name, greyed while offline, a login asked for where none is saved
function termPick() {
  if (!pick) return;
  if (!dkMenuEl.hidden && dkMenuEl.owner === pick) {
    dkMenuEl.hidden = true;
    return;
  }
  const anchor = pick;
  const devs = devices();
  const items: MenuItem[] = devs.map(
    (d): MenuItem => [
      d.name,
      () => (d.login ? termTab(d.name, '', false) : dkUnlock(d.name, anchor, () => termTab(d.name, '', false))),
      d.up,
      'dk-term-dev',
    ],
  );
  const r = anchor.getBoundingClientRect();
  dkMenu(
    r.left,
    r.bottom + 2,
    items.length ? items : [['no devices yet', () => {}, false]],
    undefined,
    'open a tab on',
  );
  dkMenuEl.owner = anchor;
  const rows = dkMenuEl.querySelectorAll(':scope > button.dk-term-dev');
  devs.forEach((d, i) => {
    const row = rows[i]!;
    row.prepend(dkGlyph(osGlyph(d.os), 'dk-term-os'));
    if (!d.up) row.append(el('span', 'dk-term-note', 'offline'));
    else if (!d.login) row.append(el('span', 'dk-term-note', 'log in…'));
  });
}

// a new tab on the usual host: the serving one, else the last used; the ▾ opened when there's none
export function dkTermNew(): void {
  if (!dk.desk) return;
  const h = tabDefaultHost(dkLiveHosts(), st.selfHost, lastHost());
  if (h) {
    dkTerminal(h);
    return;
  }
  const w = termWin();
  if (!w) return;
  dkFocus(w);
  requestAnimationFrame(termPick);
}

// the desktop's icon: the window brought up, else opened with a tab
export function dkTermApp(): void {
  const w = dk.wins.get(KEY);
  if (w) dkFocus(w);
  else dkTermNew();
}

// a tab of a person's own, with a command typed in once logged in: run
export function dkTerminal(host: string, run = '', shared = false): DkWin | undefined {
  const w = termTab(host, run, shared);
  if (w) agentDisown(w);
  return w;
}

// a tab phosphorus asked for: one on the host already there brought forward, else a new one,
// and whether its window is new
export function dkTermFor(host: string, shared: boolean): { w: DkWin; fresh: boolean } | undefined {
  const fresh = !dk.wins.has(KEY);
  const t = tabs.find((o) => o.host === host && o.shared === shared);
  if (t) {
    const w = dk.wins.get(KEY)!;
    termShow(t.id);
    dkFocus(w);
    return { w, fresh };
  }
  const w = termTab(host, '', shared);
  return w && { w, fresh };
}

// the window with a tab on the host brought forward, a shared one first
export function dkTermOn(host: string): DkWin | undefined {
  const t = tabs.find((o) => o.host === host && o.shared) || tabs.find((o) => o.host === host);
  if (!t) return;
  termShow(t.id);
  return dk.wins.get(KEY);
}

// every tab on a host gone or logged out of closed, the rest relabelled once the
// state push that told of it is all applied
export function dkTermDrop(gone: (host: string) => boolean): void {
  for (const t of tabs.filter((o) => gone(o.host))) termClose(t);
  queueMicrotask(termLabels);
}

// the session's record: each tab's host in order, the one shown
export function dkTermSaved(): { t: 'terms'; hosts: string[]; at: number } | null {
  if (!tabs.length) return null;
  return { t: 'terms', hosts: tabs.map((t) => t.host), at: Math.max(0, tabs.indexOf(cur()!)) };
}

// the tabs back, each on a host still logged into; undefined while one may yet log in
export function dkTermRestore(hosts: string[], at: number): DkWin | undefined | null {
  const ok = hosts.filter((h) => dk.creds.has(h));
  if (!ok.length) return hosts.some((h) => st.terminalHosts.includes(h)) ? undefined : null;
  const shown = hosts[at];
  let w: DkWin | undefined;
  let back: Tab | undefined;
  for (const h of ok) {
    w = termTab(h, '', false) ?? w;
    if (h === shown && !back) back = cur();
  }
  if (back) termShow(back.id);
  return w ?? null;
}
