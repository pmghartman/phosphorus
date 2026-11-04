// files: Home on top, then each host's shares; a path bar and one list

import { dkFocus, dkWin } from '../../desktop/windows.ts';
import { type DropTarget, dkFms, type Fm, fileOpen } from '../../features/home/home.ts';
import { DK_UI, dkGlyph, el, icon } from '../../lib/dom.ts';
import { when } from '../../lib/util.ts';
import { fmDropZone, fmMkdir, fmUpload } from './actions.ts';
import { fmCan, fmKeys, fmPaintSel, fmRender } from './list.ts';
import { fmMenu } from './menu.ts';
import { fmBack, fmGo, fmLoad, fmUp } from './nav.ts';
import { fmSide } from './side.ts';

// list columns: key, label
export const FM_COLS: [string, string][] = [
  ['name', 'name'],
  ['size', 'size'],
  ['mtime', 'modified'],
];
export const fmDate = (ms: number | null | undefined) => (ms ? when(ms) : '');

// a line in the status bar, gone after a while unless a transfer is still going
export function fmSay(fm: Fm, text: string, bad?: boolean) {
  fm.note.textContent = text || '';
  fm.note.classList.toggle('bad', !!bad);
  clearTimeout(fm.noteTimer);
  if (text && !fm.busy)
    fm.noteTimer = setTimeout(() => {
      if (fm.note.textContent === text) fm.note.textContent = '';
    }, 6000);
}

export function dkFiles(at?: DropTarget): Fm | undefined {
  const w = dkWin(null, 'files', '', 'fm');
  if (!w) return;
  const btn = (glyph: SVGSVGElement, label: string) => {
    const b = Object.assign(el('button', 'fm-btn'), { type: 'button', title: label, ariaLabel: label });
    b.append(glyph);
    return b;
  };
  const fm: Fm = {
    w,
    loc: null,
    dir: '',
    back: [],
    entries: [],
    shown: [],
    sel: new Set(),
    anchor: null,
    sort: { key: 'name', dir: 1 },
    shares: new Map(),
    busy: '',
    backBtn: btn(dkGlyph(DK_UI.back!), 'back (alt+←)'),
    upBtn: btn(dkGlyph(DK_UI.up!), 'up (alt+↑)'),
    crumbs: el('div', 'fm-crumbs'),
    badge: Object.assign(el('span', 'fm-ro', 'read-only'), { hidden: true }),
    side: el('nav', 'fm-side'),
    main: Object.assign(el('div', 'fm-main'), { tabIndex: 0 }),
    count: el('span', 'fm-count'),
    note: el('span', 'fm-note'),
    box: w.body,
    input: Object.assign(el('input'), { type: 'file', multiple: true, hidden: true }),
    say: (text, bad) => fmSay(fm, text, bad),
    focus: () => fm.main.focus({ preventScroll: true }),
    load: () => fmLoad(fm),
    paint: () => fmPaintSel(fm),
    open: (rel, dir) => (dir ? fmGo(fm, fm.loc!, rel) : fileOpen(fm.loc!, rel, { dir })),
  };
  const refresh = btn(icon('refresh'), 'refresh (f5)');
  const mkdir = btn(icon('mkdir'), 'new folder (ctrl+shift+n)');
  const upload = btn(icon('upload'), 'upload here');
  const tools = el('div', 'fm-tools');
  tools.append(fm.backBtn, fm.upBtn, refresh, fm.crumbs, fm.badge, mkdir, upload);
  const status = el('div', 'fm-status');
  status.append(fm.count, fm.note);
  const split = el('div', 'fm-split');
  split.append(fm.side, fm.main);
  w.body.append(tools, split, status, fm.input);

  fm.backBtn.addEventListener('click', () => fmBack(fm));
  fm.upBtn.addEventListener('click', () => fmUp(fm));
  refresh.addEventListener('click', () => fmLoad(fm));
  mkdir.addEventListener('click', () => fmMkdir(fm));
  upload.addEventListener('click', () => fmCan(fm, 'w') && fm.input.click());
  fm.input.addEventListener('change', () => {
    fmUpload(fm, fm.loc, fm.dir, fm.input.files!);
    fm.input.value = '';
  });
  fm.main.addEventListener('keydown', (e) => fmKeys(fm, e));
  fm.main.addEventListener('pointerdown', (e) => {
    if (e.target === fm.main || (e.target as Element).classList.contains('fm-items')) {
      fm.sel.clear();
      fmPaintSel(fm);
    }
  });
  fm.main.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = (e.target as Element).closest('[data-name]') as HTMLElement | null;
    if (row && !fm.sel.has(row.dataset.name!)) {
      fm.sel = new Set([row.dataset.name!]);
      fm.anchor = row.dataset.name!;
      fmPaintSel(fm);
    }
    if (!row) {
      fm.sel.clear();
      fmPaintSel(fm);
    }
    fmMenu(fm, e.clientX, e.clientY, !!row);
  });
  fmDropZone(fm, fm.main, () => (fm.loc ? { loc: fm.loc, dir: fm.dir } : null));
  w.onFocus = () => {
    if (!w.node.contains(document.activeElement)) fm.focus();
  };
  w.onClose = () => dkFms.delete(fm);
  dkFms.add(fm);
  fmSide(fm);
  if (at) fmGo(fm, at.loc, at.dir);
  else fmRender(fm);
  dkFocus(w);
  return fm;
}
