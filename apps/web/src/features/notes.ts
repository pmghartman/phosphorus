// --- unread and notifications -------------------------------------------------

import type { Chain, State } from '@phosphorus/wire';
import { dkPressed } from '../desktop/desk/windows.ts';
import { dkAnchor, dkPopsClose, type Pop } from '../desktop/taskbar.ts';
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
// where an entry leads when clicked, a view; keep holds it until that view is seen
export interface NoteGo {
  view?: string;
  keep?: boolean;
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
  notifyDomain(state);
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
    noteAdd('mesh update started', (ch.order || []).join(', '), null, { view: 'update', keep: true });
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
  noteAdd(t, b, null, { view: 'update', keep: true });
  if (notifying()) notifyOs(t, b);
}

// the domain, to admins in the bell: none set yet, once; an edge host whose dns or
// https isn't serving, once per reason
const EDGE_SEEN = 'phosphorus-edge-seen';
function notifyDomain(state: State): void {
  if (!st.acct?.admin) return;
  let why = '';
  if (!state.domain) why = 'tailnet only: add a domain in settings › network for access from anywhere';
  else
    for (const [host, h] of Object.entries(state.hosts ?? {})) {
      const e = h.edge;
      if (!e) continue;
      if (e.dns !== 'serving') why = `${host}: dns ${e.dns}`;
      else if (e.tls !== 'serving') why = `${host}: https ${e.tls}`;
      if (why) break;
    }
  let seen = '';
  try {
    seen = localStorage.getItem(EDGE_SEEN) || '';
  } catch {}
  if (why === seen) return;
  try {
    localStorage.setItem(EDGE_SEEN, why);
  } catch {}
  if (why)
    noteAdd(state.domain ? `${state.domain} isn't fully served` : 'no domain yet', why, null, { view: 'network' });
}

// --- the notification center: what happened mesh-wide, newest first, kept per browser

const NOTES_KEY = 'phosphorus-notes';
const NOTES_MAX = 50;
// an entry gone an hour after it came, unless kept until its view is seen
const NOTE_TTL_MS = 3600000;
const live = (n: Note) => !!n.go?.keep || Date.now() - n.at < NOTE_TTL_MS;
let notes: Note[] = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(NOTES_KEY)!);
    return Array.isArray(v) ? v.filter(live) : [];
  } catch {
    return [];
  }
})();
setInterval(() => {
  if (notes.every(live)) return;
  notes = notes.filter(live);
  notesSave();
}, 60000);

// a view seen: the entries kept for it gone
export function noteSeen(view: string): void {
  if (!notes.some((n) => n.go?.keep && n.go.view === view)) return;
  notes = notes.filter((n) => !(n.go?.keep && n.go.view === view));
  notesSave();
}

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

// right over the task bar that's showing, its clock never covered
export function toastPlace(): void {
  if (!toastHost) return;
  const el = [...document.querySelectorAll<HTMLElement>('.dk-bar')].find((b) => b.getBoundingClientRect().height > 0);
  const bar = el?.getBoundingClientRect();
  toastHost.style.bottom = `${bar ? Math.max(0, innerHeight - bar.top) + 8 : 12}px`;
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
  // the control panel, or settings while the profile is hidden from the bar
  else if (go?.view === 'control') {
    if (dk.ctl?.btn.offsetParent) dk.ctl.show(true);
    else dkSettings();
  } else if (go?.view) dkPressed({ kind: 'view', view: go.view });
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
