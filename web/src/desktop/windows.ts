// the window manager: one window per terminal, files, service or app, moved, resized,
// snapped, minimized into its task bar button and back
import { DK_GLYPHS, DK_UI, dkGlyph, el, isMobile } from '../dom.ts';
import { dk } from '../state.ts';
import { dkAppsChanged, dkMenu, type MenuItem } from './desk.ts';
import type { Connection } from '../mesh.ts';

// told of any window made, moved, snapped, hidden, shown, raised or closed (session.ts)
let touched: (() => void) | null = null;
export function dkOnTouch(f: () => void): void { touched = f; }
export const dkTouch = (): void => touched?.();

// a frame in a website window, marked when its load is a back's own
export type NavFrame = HTMLIFrameElement & { dkUndo?: number };

// one window on the desk
export interface DkWin {
  key: string;
  node: HTMLElement;
  body: HTMLElement;
  head: HTMLElement;
  task: HTMLButtonElement;
  kind: string;
  glyph: string;
  onFocus: (() => void) | null;
  onClose: (() => void) | null;
  w: number;
  h: number;
  x: number;
  y: number;
  snap: string;
  // the timer of its leaving animation, and of its eased geometry
  leaving?: ReturnType<typeof setTimeout> | 0;
  tween?: ReturnType<typeof setTimeout>;
  // an editor's unsaved hold: true keeps the window
  holdClose?: () => boolean;
  // a terminal's host
  host?: string;
  // a website window's back button and frame
  back?: HTMLButtonElement;
  frame?: NavFrame;
  // the git window's own: its url, the master in its title, its connection on the graph
  git?: { url: string; master: string; conn: Connection | null };
  // lit by the agent's touch, the timer of its glow
  agentLit?: ReturnType<typeof setTimeout> | 0;
}

// the glyph a window's task button wears, by what it is
function dkWinGlyph(key: string | null, kind: string): string {
  const k = String(key || '');
  if (k.startsWith('app:')) { const id = k.slice(4); return ({ theme: 'gear', profile: 'user' } as Record<string, string>)[id] || (DK_GLYPHS[id] ? id : 'app'); }
  if (String(kind).startsWith('term')) return 'terminal';
  if (kind === 'fm') return 'files';
  if (k.startsWith('svc:')) return 'service';
  if (k.startsWith('img:') || k.startsWith('view:')) return 'doc';
  return 'app';
}

// one window, key: a single instance's, else a fresh one per open
export function dkWin(key: string | null, title: string, sub: string, kind: string): DkWin | null {
  if (key && dk.wins.has(key)) { dkFocus(dk.wins.get(key)!); return null; }
  const { wins, tasks } = dk.desk!;
  const node = el('div', `dk-win dk-${kind}`);
  const head = el('div', 'dk-head');
  const name = el('span', 'dk-title');
  name.appendChild(el('span', 'tab-label', title));
  if (sub) name.appendChild(el('span', 'dk-sub', ` ${sub}`));
  const btns = el('span', 'dk-btns');
  const btn = (cls: string, d: string, label: string) => {
    const b = Object.assign(el('button', cls), { type: 'button', title: label, ariaLabel: label });
    b.appendChild(dkGlyph(d));
    return b;
  };
  const min = btn('dk-min', DK_UI.min!, 'minimize');
  const max = btn('dk-max', DK_UI.max!, 'maximize');
  const close = btn('dk-close', DK_UI.close!, 'close');
  btns.append(min, max, close);
  head.append(name, btns);
  const body = el('div', 'dk-body');
  // every side and corner a resize handle
  const edges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((e) => {
    const d = el('div', 'dk-edge');
    d.dataset.e = e;
    return d;
  });
  node.append(head, body, ...edges);
  const glyph = DK_GLYPHS[dkWinGlyph(key, kind)]!;
  const task = Object.assign(el('button', 'dk-task'), { type: 'button', title: sub ? `${title} ${sub}` : title });
  task.append(dkGlyph(glyph, 'dk-task-ic'), el('span', 'dk-task-t', title));
  const w: DkWin = { key: key || `w${++dk.n}`, node, body, head, task, kind, glyph, onFocus: null, onClose: null, w: 0, h: 0, x: 0, y: 0, snap: '' };
  // cascaded from the icons, a phone's filling the desk
  const step = (dk.n++ % 8) * 24;
  const W = wins.clientWidth;
  const H = wins.clientHeight;
  w.w = Math.min(760, W - 24);
  w.h = Math.min(460, H - 24);
  w.x = Math.max(0, Math.min(W - w.w, 120 + step));
  w.y = Math.max(0, Math.min(H - w.h, 16 + step));
  dkPlace(w);
  w.snap = '';
  if (isMobile()) dkSnap(w, 'max');
  min.addEventListener('click', () => dkMin(w));
  max.addEventListener('click', () => dkMax(w));
  close.addEventListener('click', () => dkClose(w));
  head.addEventListener('dblclick', (e) => { if (!(e.target as Element).closest('button')) dkMax(w); });
  // a right click on the title or the task: the window's menu; a middle click on the task closes
  const menu = (e: MouseEvent) => { if (!(e.target as Element).closest('.dk-btns')) { e.preventDefault(); dkWinMenu(w, e.clientX, e.clientY); } };
  head.addEventListener('contextmenu', menu);
  task.addEventListener('contextmenu', menu);
  task.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); dkClose(w); } });
  task.addEventListener('click', () => {
    if (node.hidden || w.leaving) dkFocus(w); else if (node.classList.contains('focused')) dkMin(w); else dkFocus(w);
  });
  // the minimize button never raising or focusing on its way down
  node.addEventListener('pointerdown', (e) => { if (!(e.target as Element).closest('.dk-min')) dkFocus(w); }, true);
  dkMove(w, head);
  for (const edge of edges) dkDrag(w, edge, (dx, dy, o) => dkResize(w, edge.dataset.e!, dx, dy, o));
  wins.appendChild(node);
  tasks.appendChild(task);
  dk.wins.set(w.key, w);
  dkTouch();
  return w;
}

// on screen: not minimized, not leaving
export const dkShown = (w: DkWin): boolean => !w.node.hidden && !w.leaving;
// the windows on screen, topmost first
export const dkStack = (): DkWin[] => [...dk.wins.values()].filter(dkShown).sort((a, b) => Number(b.node.style.zIndex) - Number(a.node.style.zIndex));

// the window's menu, as a title bar's right click gives it
export function dkWinMenu(w: DkWin, x: number, y: number): void {
  const title = w.task.title;
  const phone = isMobile();
  const items: MenuItem[] = [
    [w.node.hidden ? 'restore' : 'minimize', () => (w.node.hidden ? dkFocus(w) : dkMin(w)), true],
    [w.snap === 'max' ? 'restore size' : 'maximize', () => dkMax(w), !phone],
    ['snap', [
      ['left half', () => dkSnapTo(w, 'l'), true], ['right half', () => dkSnapTo(w, 'r'), true],
      ['top left', () => dkSnapTo(w, 'tl'), true], ['top right', () => dkSnapTo(w, 'tr'), true],
      ['bottom left', () => dkSnapTo(w, 'bl'), true], ['bottom right', () => dkSnapTo(w, 'br'), true],
      null, ['floating', () => dkSnapTo(w, ''), !!w.snap],
    ], !phone],
    null,
    ['close', () => dkClose(w), true, 'danger'],
  ];
  dkMenu(x, y, items, undefined, title);
}

// snapped to a zone, or let go of its snap, eased there
export function dkSnapTo(w: DkWin, zone: string): void {
  if (isMobile() || zone === w.snap) return;
  dkTween(w);
  dkSnap(w, zone);
  dkFocus(w);
}

// the geometry a drag started from
interface Geo { x: number; y: number; w: number; h: number }

// a side's drag: its own edge moved, the opposite one held, never under the minimum
const DK_MIN_W = 280;
const DK_MIN_H = 160;
function dkResize(w: DkWin, e: string, dx: number, dy: number, o: Geo) {
  if (e.includes('e')) w.w = Math.max(DK_MIN_W, o.w + dx);
  if (e.includes('s')) w.h = Math.max(DK_MIN_H, o.h + dy);
  if (e.includes('w')) {
    const nx = Math.min(o.x + dx, o.x + o.w - DK_MIN_W);
    w.w = o.w + o.x - nx;
    w.x = nx;
  }
  if (e.includes('n')) {
    const ny = Math.max(0, Math.min(o.y + dy, o.y + o.h - DK_MIN_H));
    w.h = o.h + o.y - ny;
    w.y = ny;
  }
}

export function dkPlace(w: DkWin): void {
  w.node.style.transform = `translate3d(${w.x}px, ${w.y}px, 0)`;
  w.node.style.width = `${w.w}px`;
  w.node.style.height = `${w.h}px`;
  dkTouch();
}

// pointer captured from press to release, one write per frame
function dkDrag(w: DkWin, handle: HTMLElement, move: (dx: number, dy: number, o: Geo) => void) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest('button') || w.snap) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const o = { x: w.x, y: w.y, w: w.w, h: w.h, px: e.clientX, py: e.clientY };
    let frame = 0;
    dk.desk!.el.classList.add('dk-moving');
    const onMove = (ev: PointerEvent) => {
      move(ev.clientX - o.px, ev.clientY - o.py, o);
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; dkPlace(w); });
    };
    const onUp = () => {
      handle.removeEventListener('pointermove', onMove);
      dk.desk?.el.classList.remove('dk-moving');
      cancelAnimationFrame(frame);
      dkPlace(w);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
    handle.addEventListener('pointercancel', onUp, { once: true });
  });
}

// where letting go snaps: the top edge maximized, a side its half, a side's
// end its quarter
const DK_EDGE = 14;
function dkZone(x: number, y: number, W: number, H: number): string {
  if (y < DK_EDGE && x > DK_EDGE * 3 && x < W - DK_EDGE * 3) return 'max';
  const side = x < DK_EDGE ? 'l' : x > W - DK_EDGE ? 'r' : '';
  if (!side) return y < DK_EDGE ? (x < W / 2 ? 'tl' : 'tr') : '';
  return y < H * 0.25 ? `t${side}` : y > H * 0.75 ? `b${side}` : side;
}

export function dkSnap(w: DkWin, zone: string): void {
  w.snap = zone || '';
  if (zone) w.node.dataset.snap = zone; else delete w.node.dataset.snap;
  (w.node.querySelector('.dk-max') as HTMLElement).title = zone === 'max' ? 'restore' : 'maximize';
  dkTouch();
}

// a title bar's drag: a snapped window let go of its snap first, under the
// pointer where it was held, a dashed outline showing the snap to come
function dkMove(w: DkWin, head: HTMLElement) {
  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || (e.target as Element).closest('button') || isMobile()) return;
    e.preventDefault();
    head.setPointerCapture(e.pointerId);
    const { wins } = dk.desk!;
    const box = wins.getBoundingClientRect();
    const at = w.node.getBoundingClientRect();
    const grab = (e.clientX - at.left) / at.width;
    let o: { x: number; y: number } | null = null;
    let zone = '';
    let frame = 0;
    const preview = el('div', 'dk-snap');
    const onMove = (ev: PointerEvent) => {
      if (!o) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        if (w.snap) {
          w.x = e.clientX - box.left - grab * w.w;
          w.y = Math.max(0, e.clientY - box.top - 12);
          dkSnap(w, '');
        }
        o = { x: w.x, y: w.y };
        dk.desk!.el.classList.add('dk-moving');
        wins.appendChild(preview);
      }
      w.x = o.x + ev.clientX - e.clientX;
      w.y = Math.max(0, o.y + ev.clientY - e.clientY);
      const next = dkZone(ev.clientX - box.left, ev.clientY - box.top, box.width, box.height);
      if (next !== zone) {
        zone = next;
        if (zone) preview.dataset.snap = zone; else delete preview.dataset.snap;
      }
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; dkPlace(w); });
    };
    const onUp = () => {
      head.removeEventListener('pointermove', onMove);
      preview.remove();
      if (!o) return;
      dk.desk?.el.classList.remove('dk-moving');
      cancelAnimationFrame(frame);
      // never lost under the task bar or off either side
      w.x = Math.max(48 - w.w, Math.min(box.width - 48, w.x));
      w.y = Math.max(0, Math.min(box.height - 28, w.y));
      dkPlace(w);
      if (zone) { dkTween(w); dkSnap(w, zone); }
    };
    head.addEventListener('pointermove', onMove);
    head.addEventListener('pointerup', onUp, { once: true });
    head.addEventListener('pointercancel', onUp, { once: true });
  });
}

// a class played out before done, cut short by a refocus
function dkLeave(w: DkWin, done: () => void, cls = 'dk-leaving') {
  const n = w.node;
  const end = () => {
    if (w.leaving !== t) return;
    clearTimeout(t);
    w.leaving = 0;
    n.removeEventListener('animationend', onEnd);
    n.classList.remove(cls);
    done();
  };
  const onEnd = (e: AnimationEvent) => { if (e.target === n) end(); };
  const t = setTimeout(end, 300);
  w.leaving = t;
  n.classList.add(cls);
  n.addEventListener('animationend', onEnd);
}

// a geometry change eased, never a drag's
function dkTween(w: DkWin) {
  w.node.classList.add('dk-tween');
  clearTimeout(w.tween);
  w.tween = setTimeout(() => w.node.classList.remove('dk-tween'), 220);
}

export function dkFocus(w: DkWin | null): void {
  if (w?.leaving) {
    clearTimeout(w.leaving);
    w.leaving = 0;
    w.node.classList.remove('dk-leaving', 'dk-minimizing');
  }
  for (const o of dk.wins.values()) {
    o.node.classList.toggle('focused', o === w);
    o.task.classList.toggle('active', o === w);
  }
  if (dk.desk?.app) {
    dk.desk.app.querySelector('.dk-menubar-app-t')!.textContent = w ? w.task.querySelector('.dk-task-t')!.textContent : 'phosphorus';
    dk.desk.app.querySelector('path')!.setAttribute('d', w ? w.glyph : DK_GLYPHS.mesh!);
  }
  if (!w) return;
  if (w.node.hidden) dkRestore(w);
  if (w.node.style.zIndex !== String(dk.z)) w.node.style.zIndex = String(++dk.z);
  w.onFocus?.();
  dkAppsChanged();
  dkTouch();
}

// the offset from the window to its task bar button; the scale also pulls
// the window's own offset in, made up for in the translate
const DK_MIN_SCALE = 0.1;
function dkToTask(w: DkWin) {
  const a = w.node.getBoundingClientRect();
  const b = w.task.getBoundingClientRect();
  const k = 1 - DK_MIN_SCALE;
  const mx = w.snap ? 0 : w.x;
  const my = w.snap ? 0 : w.y;
  w.node.style.setProperty('--min-x', `${b.left + b.width / 2 - (a.left + a.width / 2) + k * mx}px`);
  w.node.style.setProperty('--min-y', `${b.top + b.height / 2 - (a.top + a.height / 2) + k * my}px`);
}

// shrunk into its task bar button, focused and on top the whole way, the
// next window focused only once it's gone
export function dkMin(w: DkWin): void {
  dkToTask(w);
  dkLeave(w, () => {
    dkHide(w);
    const top = dkStack()[0];
    if (top) dkFocus(top);
    dkAppsChanged();
  }, 'dk-minimizing');
}

// minimized at once, no animation: a session's windows put back as they were
export function dkHide(w: DkWin): void {
  w.node.hidden = true;
  w.node.classList.remove('focused');
  w.task.classList.remove('active');
  dkTouch();
}

// grown back out of its task bar button, measured unanimated first
function dkRestore(w: DkWin) {
  const n = w.node;
  n.style.animation = 'none';
  n.hidden = false;
  dkToTask(w);
  n.style.animation = '';
  n.classList.add('dk-restoring');
  const end = (e?: AnimationEvent) => {
    if (e && e.target !== n) return;
    n.classList.remove('dk-restoring');
    n.removeEventListener('animationend', end);
  };
  n.addEventListener('animationend', end);
  setTimeout(end, 400);
}

export function dkMax(w: DkWin): void {
  if (isMobile()) return;
  dkTween(w);
  dkSnap(w, w.snap === 'max' ? '' : 'max');
  dkFocus(w);
}

// force: past an editor's unsaved hold
export function dkClose(w: DkWin, force?: boolean): void {
  if (!force && w.holdClose?.()) return;
  w.onClose?.();
  if (w.back) dkNavDrop(w);
  if (force) w.node.remove(); else dkLeave(w, () => w.node.remove());
  w.task.remove();
  dk.wins.delete(w.key);
  dkAppsChanged();
  dkTouch();
}

// --- a website window's back: history.back() undoes the newest frame load
// anywhere, so only the window holding it gets one

let dkNavs: NavFrame[] = [];
const dkNavWins = new Set<DkWin>();
const DK_NAV_UNDO_MS = 3000;
function dkNavSync() { for (const w of dkNavWins) w.back!.disabled = !w.frame || dkNavs.at(-1) !== w.frame; }
function dkNavDrop(w: DkWin) {
  dkNavs = dkNavs.filter((f) => f.isConnected && f !== w.frame);
  dkNavWins.delete(w);
  dkNavSync();
}
export function dkNav(w: DkWin, frame: NavFrame): void {
  if (!w.back) {
    w.back = Object.assign(el('button', 'dk-back'), { type: 'button', title: 'back', ariaLabel: 'back' });
    w.back.appendChild(dkGlyph(DK_UI.back!));
    w.back.addEventListener('click', () => {
      if (dkNavs.at(-1) !== w.frame) return;
      dkNavs.pop();
      w.frame!.dkUndo = performance.now();
      history.back();
      dkNavSync();
    });
    w.head.prepend(w.back);
    dkNavWins.add(w);
  }
  if (w.frame && w.frame !== frame) dkNavs = dkNavs.filter((f) => f !== w.frame);
  w.frame = frame;
  let first = true;
  // the first load the page itself, one just after a back that back's
  frame.addEventListener('load', () => {
    if (first) { first = false; return; }
    if (performance.now() - (frame.dkUndo || -Infinity) < DK_NAV_UNDO_MS) { frame.dkUndo = 0; return; }
    dkNavs.push(frame);
    dkNavSync();
  });
  dkNavSync();
}

// a fresh window's size, centered, a phone's left filling the desk
export function dkSize(w: DkWin, width: number, height: number): void {
  if (w.snap) return;
  const W = dk.desk!.wins.clientWidth;
  const H = dk.desk!.wins.clientHeight;
  w.w = Math.min(width, W - 24);
  w.h = Math.min(height, H - 24);
  // centered, each next one stepped down and right
  const step = (dk.n % 6) * 26;
  w.x = Math.max(0, Math.min(W - w.w, Math.round((W - w.w) / 2) - 65 + step));
  w.y = Math.max(0, Math.min(H - w.h, Math.round((H - w.h) / 3) - 65 + step));
  dkPlace(w);
}
