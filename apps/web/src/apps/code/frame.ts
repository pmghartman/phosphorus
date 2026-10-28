// the frame: side list, main pane
import { el, noFill } from '../../lib/dom.ts';
import { acctOpen } from './account.ts';
import { go, paintList } from './list.ts';
import { cd, lsGet, lsSet, SIDE_LS, view } from './state.ts';

export const root = el('div', 'cd');
export const side = el('div', 'cd-side');
export const grip = Object.assign(el('div', 'cd-grip'), {
  tabIndex: 0,
  role: 'separator',
  title: 'drag to resize, double click to reset',
});
grip.setAttribute('aria-orientation', 'vertical');
export const main = el('div', 'cd-main');
export const scrim = el('div', 'cd-scrim');
root.append(side, grip, main, scrim);
view.replaceChildren(root);
scrim.addEventListener('click', () => drawer(false));

// the side's width dragged on its grip, kept per browser
export function sideWidth(px: number): number {
  if (!px) {
    root.style.removeProperty('--cd-side');
    return 0;
  }
  const w = Math.round(Math.min(Math.max(220, root.clientWidth * 0.45), Math.max(150, px)));
  root.style.setProperty('--cd-side', `${w}px`);
  return w;
}
if (lsGet(SIDE_LS, 0)) root.style.setProperty('--cd-side', `${lsGet(SIDE_LS, 0)}px`);
grip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  grip.setPointerCapture(e.pointerId);
  const x0 = e.clientX;
  const w0 = side.getBoundingClientRect().width;
  root.classList.add('cd-resizing');
  const move = (ev: PointerEvent) => sideWidth(w0 + ev.clientX - x0);
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    grip.removeEventListener('pointercancel', up);
    root.classList.remove('cd-resizing');
    lsSet(SIDE_LS, Math.round(side.getBoundingClientRect().width));
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
});
grip.addEventListener('keydown', (e) => {
  const d = ({ ArrowLeft: -16, ArrowRight: 16 } as Record<string, number>)[e.key];
  if (!d) return;
  e.preventDefault();
  e.stopPropagation();
  lsSet(SIDE_LS, sideWidth(side.getBoundingClientRect().width + d));
});
grip.addEventListener('dblclick', () => {
  sideWidth(0);
  lsSet(SIDE_LS, 0);
});

export const sideTop = el('div', 'cd-side-top');
export const newBtn = Object.assign(el('button', 'cd-new', '+ new session'), { type: 'button', title: 'new session' });
// a plain text box: a search or password-looking field gets a saved login filled in
export const find = noFill(
  Object.assign(el('input', 'cd-find'), { placeholder: 'filter sessions', spellcheck: false }),
);
sideTop.append(newBtn, find);
export const listEl = Object.assign(el('nav', 'cd-list'), { ariaLabel: 'sessions' });
// the Claude account at the side's foot: its state, the token box opened over it
export const acct = el('div', 'cd-acct');
export const acctBox = el('div', 'cd-acct-box');
acctBox.hidden = true;
export const acctBtn = Object.assign(el('button', 'cd-acct-btn'), {
  type: 'button',
  title: 'your Claude subscription, for Opus, Sonnet and Haiku',
});
acctBtn.setAttribute('aria-expanded', 'false');
acct.append(acctBox, acctBtn);
side.append(sideTop, listEl, acct);
acctBtn.addEventListener('click', () => acctOpen(acctBox.hidden as boolean));
newBtn.addEventListener('click', () => go('new'));
find.addEventListener('input', () => {
  cd.filter = find.value.trim().toLowerCase();
  cd.listSig = '';
  paintList();
});
find.addEventListener('keydown', (e) => e.stopPropagation());

export function drawer(on: boolean) {
  cd.drawer = on;
  root.classList.toggle('cd-drawer', on);
}
