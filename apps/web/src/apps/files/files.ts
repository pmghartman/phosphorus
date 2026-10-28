// files: a file manager over the hosts' shares, places, a path bar, list
import { DK_UI, dkGlyph, el, icon } from '../../lib/dom.ts';
import { dkFms, fmExt, type DropTarget, type Fm } from '../../features/home/home.ts';
import type { FileEntry } from '@phosphorus/wire';
import { dkFocus, dkWin } from '../../desktop/windows.ts';
import { fmDropZone, fmMkdir, fmUpload } from './actions.ts';
import { fmCan, fmKeys, fmPaintSel, fmRender, fmStep } from './list.ts';
import { fmMenu } from './menu.ts';
import { fmGo, fmHistory, fmLoad, fmUp } from './nav.ts';
import { fmSide } from './side.ts';

// or icons, a right click's menu, cut, copy and paste across hosts

export const fmKindLabel = (e: FileEntry) => (e.dir ? 'folder' : fmExt(e.name) ? `${fmExt(e.name)} file` : 'file');
export const fmWhere = (e: FileEntry) => (e.hosts ? (e.all ? 'all hosts' : e.hosts.join(', ')) : '');
// list columns: key, label, default width; name's null for the rest of the row
export const FM_COLS: [string, string, string | null][] = [['name', 'name', null], ['where', 'hosts', '7rem'], ['mtime', 'modified', '10.5rem'], ['size', 'size', '5rem'], ['kind', 'kind', '7rem']];
export const FM_WIDTHS_KEY = 'phosphorus-fm-widths';
export const fmWidths: Record<string, number> = (() => { try { return JSON.parse(localStorage.getItem(FM_WIDTHS_KEY)!) || {}; } catch { return {}; } })();
export const fmSaveWidths = () => { try { localStorage.setItem(FM_WIDTHS_KEY, JSON.stringify(fmWidths)); } catch {} };
export const fmDate = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

export function dkFiles(at?: DropTarget): Fm | undefined {
  const w = dkWin(null, 'files', '', 'fm');
  if (!w) return;
  const btn = (cls: string, glyph: SVGSVGElement | null, label: string) => {
    const b = Object.assign(el('button', `fm-btn ${cls}`), { type: 'button', title: label, ariaLabel: label });
    if (glyph) b.append(glyph);
    return b;
  };
  const fm: Fm = {
    w, loc: null, dir: '', back: [], fwd: [], entries: [], shown: [], sel: new Set(), anchor: null,
    sort: { key: 'name', dir: 1 }, mode: 'list', filter: '', shares: new Map(), busy: '',
    backBtn: btn('', dkGlyph(DK_UI.back!), 'back (alt+←)'),
    fwdBtn: btn('', dkGlyph(DK_UI.fwd!), 'forward (alt+→)'),
    upBtn: btn('', dkGlyph(DK_UI.up!), 'up (alt+↑)'),
    crumbs: el('div', 'fm-crumbs'),
    find: Object.assign(el('input', 'fm-find'), { placeholder: 'search', spellcheck: false, autocomplete: 'off' as const }),
    modeBtn: btn('', null, 'list or icons'),
    side: el('nav', 'fm-side'),
    main: Object.assign(el('div', 'fm-main'), { tabIndex: 0 }),
    status: el('div', 'fm-status'),
    count: el('span', 'fm-count'),
    note: el('span', 'fm-note'),
    input: Object.assign(el('input'), { type: 'file', multiple: true, hidden: true }),
    cols: [],
  };
  const refresh = btn('', icon('refresh'), 'refresh (f5)');
  const mkdir = btn('', icon('mkdir'), 'new folder (ctrl+shift+n)');
  const upload = btn('', icon('upload'), 'upload here');
  const tools = el('div', 'fm-tools');
  tools.append(fm.backBtn, fm.fwdBtn, fm.upBtn, refresh, fm.crumbs, mkdir, upload, fm.modeBtn, fm.find);
  fm.status.append(fm.count, fm.note);
  const split = el('div', 'fm-split');
  split.append(fm.side, fm.main);
  w.body.append(tools, split, fm.status, fm.input);

  fm.backBtn.addEventListener('click', () => fmHistory(fm, -1));
  fm.fwdBtn.addEventListener('click', () => fmHistory(fm, 1));
  fm.upBtn.addEventListener('click', () => fmUp(fm));
  refresh.addEventListener('click', () => fmLoad(fm));
  mkdir.addEventListener('click', () => fmMkdir(fm));
  upload.addEventListener('click', () => fmCan(fm, 'w') && fm.input.click());
  fm.input.addEventListener('change', () => { fmUpload(fm, fm.loc, fm.dir, fm.input.files!); fm.input.value = ''; });
  fm.modeBtn.addEventListener('click', () => { fm.mode = fm.mode === 'list' ? 'grid' : 'list'; fmRender(fm); });
  fm.find.addEventListener('input', () => { fm.filter = fm.find.value.trim().toLowerCase(); fmRender(fm); });
  fm.find.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { fm.find.value = ''; fm.filter = ''; fmRender(fm); fm.main.focus(); }
    if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); fm.main.focus(); fmStep(fm, 0); }
  });
  fm.main.addEventListener('keydown', (e) => fmKeys(fm, e));
  fm.main.addEventListener('pointerdown', (e) => {
    if (e.target === fm.main || (e.target as Element).classList.contains('fm-items')) { fm.sel.clear(); fmPaintSel(fm); }
  });
  fm.main.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const row = (e.target as Element).closest('[data-name]') as HTMLElement | null;
    if (row && !fm.sel.has(row.dataset.name!)) { fm.sel = new Set([row.dataset.name!]); fm.anchor = row.dataset.name!; fmPaintSel(fm); }
    if (!row) { fm.sel.clear(); fmPaintSel(fm); }
    fmMenu(fm, e.clientX, e.clientY, !!row);
  });
  fmDropZone(fm, fm.main, () => (fm.loc ? { loc: fm.loc, dir: fm.dir } : null));
  w.onFocus = () => { if (!w.node.contains(document.activeElement)) fm.main.focus({ preventScroll: true }); };
  w.onClose = () => dkFms.delete(fm);
  dkFms.add(fm);
  fmSide(fm);
  if (at) fmGo(fm, at.loc, at.dir); else fmRender(fm);
  dkFocus(w);
  return fm;
}
