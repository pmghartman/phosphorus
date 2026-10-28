// the window switcher (ctrl+alt+tab) and the overview (ctrl+alt+o): every window in
// reach by a key or a click
import { dkGlyph, el, isMobile } from '../dom.ts';
import { dk } from '../state.ts';
import { dkClose, dkFocus, dkStack, dkTouch, type DkWin } from './windows.ts';

// --- the switcher: a list in the middle, tab stepping while ctrl+alt are held, let go to land

let sw: { box: HTMLElement; list: DkWin[]; at: number } | null = null;

export const dkSwitching = (): boolean => !!sw;

function swPaint() {
  if (!sw) return;
  [...sw.box.querySelectorAll('.dk-sw-row')].forEach((r, i) => r.classList.toggle('cur', i === sw!.at));
}

// the windows, minimized ones last, most recent first
function swOrder(): DkWin[] {
  const shown = dkStack();
  const hidden = [...dk.wins.values()].filter((w) => w.node.hidden && !w.leaving);
  return [...shown, ...hidden];
}

export function dkSwitchStep(back: boolean): void {
  if (isMobile() || !dk.desk) return;
  if (!sw) {
    const list = swOrder();
    if (!list.length) return;
    const box = el('div', 'dk-sw');
    box.setAttribute('role', 'listbox');
    for (const w of list) {
      const row = el('div', 'dk-sw-row');
      row.append(dkGlyph(w.glyph, 'dk-sw-ic'), el('span', 'dk-sw-t', w.task.querySelector('.dk-task-t')!.textContent || ''), el('span', 'dk-sw-s', w.node.hidden ? 'minimized' : ''));
      row.addEventListener('pointerup', () => { sw!.at = list.indexOf(w); dkSwitchEnd(); });
      box.appendChild(row);
    }
    dk.desk.el.appendChild(box);
    sw = { box, list, at: 0 };
  }
  const n = sw.list.length;
  sw.at = (sw.at + (back ? -1 : 1) + n) % n;
  swPaint();
}

export function dkSwitchEnd(cancel = false): void {
  if (!sw) return;
  const { list, at, box } = sw;
  sw = null;
  box.remove();
  if (!cancel && list[at]) dkFocus(list[at]!);
}

// --- the overview: every window scaled into a grid, a click picks one

let ov: { cells: HTMLElement; wins: DkWin[] } | null = null;
export const dkOverviewOn = (): boolean => !!ov;

export function dkOverview(): void {
  if (ov) { dkOverviewEnd(); return; }
  if (isMobile() || !dk.desk) return;
  const wins = swOrder();
  if (!wins.length) return;
  const { wins: area } = dk.desk;
  const box = area.getBoundingClientRect();
  const W = box.width;
  const H = box.height;
  const n = wins.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const pad = 28;
  const gap = 18;
  const cellW = (W - pad * 2 - gap * (cols - 1)) / cols;
  const cellH = (H - pad * 2 - gap * (rows - 1)) / rows - 22;
  const cells = el('div', 'dk-ov-cells');
  dk.desk.el.classList.add('dk-overview');
  wins.forEach((w, i) => {
    const node = w.node;
    // a minimized one shown for the overview alone
    if (node.hidden) { node.hidden = false; node.classList.add('dk-ov-shown'); }
    const r = node.getBoundingClientRect();
    const k = Math.min(cellW / r.width, cellH / r.height, 1);
    const c = i % cols;
    const row = Math.floor(i / cols);
    // centered in its cell
    const tx = pad + c * (cellW + gap) + (cellW - r.width * k) / 2;
    const ty = pad + row * (cellH + gap + 22) + (cellH - r.height * k) / 2;
    // the transform replaces the window's own, so its untransformed spot is taken off
    const ox = r.left - box.left - (w.snap ? 0 : w.x);
    const oy = r.top - box.top - (w.snap ? 0 : w.y);
    node.style.setProperty('--ov-x', `${tx - ox}px`);
    node.style.setProperty('--ov-y', `${ty - oy}px`);
    node.style.setProperty('--ov-s', String(k));
    const cell = Object.assign(el('button', 'dk-ov-cell'), { type: 'button', title: w.task.title });
    Object.assign(cell.style, { left: `${tx}px`, top: `${ty}px`, width: `${r.width * k}px`, height: `${r.height * k}px` });
    const label = el('span', 'dk-ov-t', w.task.querySelector('.dk-task-t')!.textContent || '');
    const close = Object.assign(el('span', 'dk-ov-x', '×'), { title: 'close' });
    close.addEventListener('click', (e) => { e.stopPropagation(); dkOverviewEnd(); dkClose(w); });
    cell.append(label, close);
    cell.addEventListener('click', () => { dkOverviewEnd(); dkFocus(w); });
    cells.appendChild(cell);
  });
  cells.addEventListener('click', (e) => { if (e.target === cells) dkOverviewEnd(); });
  area.appendChild(cells);
  ov = { cells, wins };
}

export function dkOverviewEnd(): void {
  if (!ov) return;
  const { cells, wins } = ov;
  ov = null;
  cells.remove();
  dk.desk?.el.classList.remove('dk-overview');
  for (const w of wins) {
    const n = w.node;
    if (n.classList.contains('dk-ov-shown')) { n.classList.remove('dk-ov-shown'); n.hidden = true; }
    n.style.removeProperty('--ov-x');
    n.style.removeProperty('--ov-y');
    n.style.removeProperty('--ov-s');
  }
  dkTouch();
}
