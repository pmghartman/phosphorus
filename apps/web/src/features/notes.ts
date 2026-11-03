// --- unread and notifications -------------------------------------------------

import type { Chain, State } from '@phosphorus/wire';
import { dkAnchor, dkBarSide, dkPopsClose, type Pop } from '../desktop/taskbar.ts';
import { DK_GLYPHS, dkGlyph, el } from '../lib/dom.ts';
import { dk, st } from '../lib/state.ts';
import { ago2 } from '../lib/util.ts';
import { dkSettings } from '../settings/settings.ts';

// away: another tab, minimized, or a window behind this one
export function away(): boolean {
  return document.hidden || !document.hasFocus();
}

// desktop notifications, opt-in per browser (an app's bell sets the switch), on a secure page only
const canNotify = 'Notification' in window;
const notifyGranted = () => Notification.permission === 'granted';
// whether the bell is on
export const notifying = () => canNotify && notifyGranted() && localStorage.getItem('phosphorus-chat-notify') === '1';

// a burst's group in the bell: a channel's, a person's, an agent's
export interface NoteGroup {
  key: string;
  label: string;
  line?: string;
  seen?: boolean;
}
// where an entry leads when clicked, a view
export interface NoteGo {
  view?: string;
}
// one entry of the notification center
export interface Note {
  t: string;
  b: string;
  at: number;
  read: boolean;
  g?: string;
  c?: number;
  go?: NoteGo;
}

// one notification, the browser's
export function notifyOs(title: string, body: string): void {
  if (!canNotify || !notifyGranted()) return;
  try {
    const n = new Notification(title, { body, tag: 'phosphorus-chat', silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {}
}

// mesh updates in the bell: one note as one starts, one as it ends
// with the hosts that failed in it if any
// kept across the reload a host's own update brings
const CHAIN_SEEN = 'phosphorus-chain-running';
export function notifyMesh(state: State): void {
  notifyWildcard(state);
  const ch: Chain | null | undefined = state.chain;
  if (!ch?.chainId) return;
  let running = '';
  try {
    running = sessionStorage.getItem(CHAIN_SEEN) || '';
  } catch {}
  if (!ch.done) {
    if (running === ch.chainId) return;
    try {
      sessionStorage.setItem(CHAIN_SEEN, ch.chainId);
    } catch {}
    noteAdd('mesh update started', (ch.order || []).join(', '), null, { view: 'update' });
    if (notifying()) notifyOs('mesh update started', '');
    return;
  }
  if (ch.chainId !== running) return;
  try {
    sessionStorage.removeItem(CHAIN_SEEN);
  } catch {}
  const failed = Object.entries(ch.results || {})
    .filter(([, r]) => r === 'fail' || r === 'unreachable')
    .map(([h]) => h);
  const t = failed.length ? `update failed on ${failed.join(', ')}` : 'update done';
  const b = failed
    .map((h) => ch.errors?.[h])
    .filter(Boolean)
    .join('; ');
  noteAdd(t, b, null, { view: 'update' });
  if (notifying()) notifyOs(t, b);
}

// *.<domain> not reaching the mesh, to admins in the bell: once per reason, the
// Cloudflare entries that fix it in the body
const WILDCARD_SEEN = 'phosphorus-wildcard-seen';
function notifyWildcard(state: State): void {
  if (!st.acct?.admin || !state.domain) return;
  const infos = Object.values(state.hosts ?? {});
  const miss = infos.find((h) => h.wildcard?.state === 'missing');
  let seen = '';
  try {
    seen = localStorage.getItem(WILDCARD_SEEN) || '';
  } catch {}
  const why = miss ? miss.wildcard!.why || 'missing' : '';
  // a host that sees it up clears the last reason, so a later break is told again
  if (!miss && !infos.some((h) => h.wildcard?.state === 'up')) return;
  if (why === seen) return;
  try {
    localStorage.setItem(WILDCARD_SEEN, why);
  } catch {}
  if (why) noteAdd(`*.${state.domain} isn't reaching the mesh`, why);
}

// --- the notification center: what happened mesh-wide, newest first, kept per browser

const NOTES_KEY = 'phosphorus-notes';
const NOTES_MAX = 50;
let notes: Note[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(NOTES_KEY)!);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
})();

// go where the entry leads when clicked, a view
export function noteAdd(title: string, body: string, g: NoteGroup | null = null, go: NoteGo | null = null): void {
  // a burst still unread folded into its one entry, raised to the top
  const at = g?.key ? notes.findIndex((n) => n.g === g.key && !n.read) : -1;
  let n: Note;
  if (at >= 0) {
    n = notes.splice(at, 1)[0]!;
    n.c = (n.c || 1) + 1;
    Object.assign(
      n,
      { t: `${g!.label} · ${n.c} new`, b: String(g!.line || body || ''), at: Date.now() },
      go ? { go } : {},
    );
    notes.unshift(n);
  } else {
    n = {
      t: String(title || ''),
      b: String(body || ''),
      at: Date.now(),
      read: false,
      ...(g?.key ? { g: g.key } : {}),
      ...(go ? { go } : {}),
    };
    notes.unshift(n);
    notes = notes.slice(0, NOTES_MAX);
  }
  notesSave();
  toastShow(n);
}

// --- popups in the bottom corner: each new entry shown a few seconds above the bar,
// a burst's one entry updated in place, clicking one going where the entry leads

const TOAST_MS = 6000;
const TOAST_MAX = 4;
let toastHost: HTMLElement | null = null;
type ToastEl = HTMLElement & { note?: Note; go?: NoteGo | null; timer?: ReturnType<typeof setTimeout> };

function toastShow(n: Note) {
  if (away()) return;
  if (!toastHost) {
    toastHost = Object.assign(el('div', 'toasts'), { role: 'status' });
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
  }
  toastPlace();
  let t: ToastEl | null = n.g ? toastHost.querySelector(`.toast[data-g="${CSS.escape(n.g)}"]`) : null;
  if (!t) {
    const tt: ToastEl = el('div', 'toast');
    t = tt;
    if (n.g) t.dataset.g = n.g;
    const x = Object.assign(el('button', 'toast-x', '×'), { type: 'button', title: 'dismiss', ariaLabel: 'dismiss' });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      toastClose(tt);
    });
    t.append(el('div', 'toast-t'), el('div', 'toast-b'), x);
    t.addEventListener('click', () => {
      toastClose(tt);
      notes = notes.filter((x) => x !== tt.note);
      notesSave();
      if (tt.go) noteGo(tt.go);
    });
    t.addEventListener('pointerenter', () => clearTimeout(tt.timer));
    t.addEventListener('pointerleave', () => {
      tt.timer = setTimeout(() => toastClose(tt), TOAST_MS / 2);
    });
    toastHost.appendChild(t);
    while (toastHost.children.length > TOAST_MAX) toastHost.firstChild!.remove();
  }
  t.note = n;
  t.go = n.go || null;
  t.classList.toggle('go', !!n.go);
  t.querySelector('.toast-t')!.textContent = n.t;
  const b = t.querySelector('.toast-b') as HTMLElement;
  b.textContent = n.b;
  b.hidden = !n.b;
  clearTimeout(t.timer);
  t.timer = setTimeout(() => toastClose(t!), TOAST_MS);
}

// right over the task bar that's showing, its clock never covered; under it were it on top, the
// screen's corner by a side bar
export function toastPlace(): void {
  if (!toastHost) return;
  const el = [...document.querySelectorAll<HTMLElement>('.dk-bar:not(.dk-menubar)')].find(
    (b) => b.getBoundingClientRect().height > 0,
  );
  const side = el ? dkBarSide(el) : 'bottom';
  const bar = el && side !== 'left' && side !== 'right' ? el.getBoundingClientRect() : null;
  const top = side === 'top';
  toastHost.style.top = top ? `${bar!.bottom + 8}px` : '';
  toastHost.style.bottom = top ? '' : `${bar ? Math.max(0, innerHeight - bar.top) + 8 : 12}px`;
}
addEventListener('resize', toastPlace);

function toastClose(t: ToastEl) {
  clearTimeout(t.timer);
  t.classList.add('out');
  setTimeout(() => t.remove(), 180);
}

function noteGo(go: NoteGo) {
  if (go?.view === 'status') dkSettings('hosts');
  else if (go?.view === 'update') dkSettings('update');
  else if (go?.view === 'control') dk.ctl?.show(true);
}

function notesSave() {
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch {}
  dk.bell?.paint();
}

export function dkBellTray(): HTMLElement {
  const wrap = el('div', 'dk-tray-wrap');
  const b = Object.assign(el('button', 'dk-tray dk-bell'), {
    type: 'button',
    title: 'notifications',
    ariaLabel: 'notifications',
  });
  b.setAttribute('aria-expanded', 'false');
  b.appendChild(dkGlyph(DK_GLYPHS.bell!));
  const pop = Object.assign(el('div', 'dk-note-pop dk-pop'), { hidden: true }) as Pop;
  wrap.append(b, pop);
  dkAnchor(pop, b, { fill: 280 });
  const draw = () => {
    const head = el('div', 'dk-note-head');
    const clear = Object.assign(el('button', 'dk-note-clear', 'clear'), { type: 'button', hidden: !notes.length });
    clear.addEventListener('click', () => {
      notes = [];
      notesSave();
      draw();
    });
    head.append(el('span', '', 'notifications'), clear);
    const list = el('ul', 'dk-note-list');
    list.replaceChildren(
      ...(notes.length
        ? notes.map((n) => {
            const li = el('li', `dk-note${n.read ? '' : ' new'}${n.go ? ' go' : ''}`);
            // clicked, an entry is gone, and goes where it leads when it leads anywhere
            li.addEventListener('click', () => {
              notes = notes.filter((x) => x !== n);
              notesSave();
              if (n.go) {
                show(false);
                noteGo(n.go);
              } else draw();
            });
            const top = el('div', 'dk-note-top');
            top.append(el('span', 'dk-note-t', n.t), el('span', 'dk-note-at', ago2(n.at)));
            li.append(top);
            if (n.b) li.append(el('div', 'dk-note-b', n.b));
            return li;
          })
        : [el('li', 'dk-note-none', 'nothing yet')]),
    );
    pop.replaceChildren(head, list);
  };
  const show = (on: boolean) => {
    if (!on && pop.hidden) return;
    if (on) dkPopsClose('bell');
    pop.hidden = !on;
    b.setAttribute('aria-expanded', String(on));
    if (on) draw();
    // seen once it closes, so the open list still marks what was new
    if (!on && notes.some((n) => !n.read)) {
      for (const n of notes) n.read = true;
      notesSave();
    }
  };
  b.addEventListener('click', () => show(pop.hidden as boolean));
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!pop.hidden && !wrap.contains(e.target as Node)) show(false);
    },
    true,
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) show(false);
  });
  const paint = () => {
    const n = notes.filter((x) => !x.read).length;
    b.classList.toggle('has-new', n > 0);
    b.title = n ? `notifications (${n} new)` : 'notifications';
    if (!pop.hidden) draw();
  };
  dk.bell = { show, paint };
  paint();
  return wrap;
}
