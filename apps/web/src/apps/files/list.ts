// the list: sorting, columns, rows, selection and keys

import type { FileEntry } from '@phosphorus/wire';
import {
  dkFms,
  type Fm,
  fileOpen,
  filesJoin,
  fmIcon,
  fmKind,
  may,
  type PickedItem,
  runnable,
} from '../../features/home/home.ts';
import { DK_UI, dkGlyph, el, isMobile } from '../../lib/dom.ts';
import { dk } from '../../lib/state.ts';
import { humanSize } from '../../lib/util.ts';
import { fmClip, fmDelete, fmDropZone, fmMkdir, fmPaste, fmRename } from './actions.ts';
import { FM_COLS, fmDate, fmKindLabel, fmSaveWidths, fmWhere, fmWidths } from './files.ts';
import { fmReveal } from './menu.ts';
import { fmGo, fmHistory, fmLoad, fmUp } from './nav.ts';

export const fmCan = (fm: Fm, perm: string) => !!fm.loc && may(fm.loc, perm);

export function fmSorted(fm: Fm): FileEntry[] {
  const { key, dir } = fm.sort;
  const val = (e: FileEntry): string | number =>
    key === 'size'
      ? (e.size ?? -1)
      : key === 'mtime'
        ? (e.mtime ?? 0)
        : key === 'kind'
          ? fmKindLabel(e)
          : key === 'where'
            ? fmWhere(e)
            : e.name.toLowerCase();
  return fm.entries
    .filter((e) => !fm.filter || e.name.toLowerCase().includes(fm.filter))
    .sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir));
}

export function fmRender(fm: Fm) {
  fm.backBtn.disabled = !fm.back.length;
  fm.fwdBtn.disabled = !fm.fwd.length;
  fm.upBtn.disabled = !fm.dir;
  fm.modeBtn.replaceChildren(dkGlyph(fm.mode === 'list' ? DK_UI.grid! : DK_UI.list!));
  // the path bar: host, the share, then each folder, any one a jump
  const crumbs: HTMLElement[] = [];
  if (fm.loc) {
    if (fm.loc.host !== '*') crumbs.push(el('span', 'fm-crumb-host', fm.loc.host));
    const parts = fm.dir ? fm.dir.split('/') : [];
    [fm.loc.root, ...parts].forEach((name, i) => {
      const c = Object.assign(el('button', 'fm-crumb', name), { type: 'button' });
      const to = parts.slice(0, i).join('/');
      c.addEventListener('click', () => to !== fm.dir && fmGo(fm, fm.loc!, to));
      fmDropZone(fm, c, () => ({ loc: fm.loc!, dir: to }));
      crumbs.push(...(crumbs.length ? [el('span', 'fm-crumb-sep', '›')] : []), c);
    });
  }
  fm.crumbs.replaceChildren(...crumbs);
  const name = fm.loc ? fm.dir.split('/').pop() || fm.loc.root : 'files';
  fm.w.task.querySelector('.dk-task-t')!.textContent = name!;
  fm.w.head.querySelector('.tab-label')!.textContent = name!;

  fm.cols = FM_COLS.filter(([key]) => key !== 'where' || fm.loc?.host === '*');
  if (!fm.cols.some(([key]) => key === fm.sort.key)) fm.sort = { key: 'name', dir: 1 };
  fm.shown = fmSorted(fm);
  const items = el('div', `fm-items fm-${fm.mode}`);
  if (fm.mode === 'list') {
    fmColWidths(fm, items);
    const head = el('div', 'fm-row fm-cols');
    fm.cols.forEach(([key, label], i) => {
      const c = Object.assign(el('button', `fm-col fm-c-${key}`, label), { type: 'button' });
      if (fm.sort.key === key) c.append(el('span', 'fm-arrow', fm.sort.dir > 0 ? ' ▴' : ' ▾'));
      const grip = Object.assign(el('span', 'fm-grip'), { title: 'drag to resize, double click to fit' });
      c.append(grip);
      fmGrip(fm, items, grip, key, i);
      c.addEventListener('click', (e) => {
        if (e.target === grip) return;
        fm.sort = { key, dir: fm.sort.key === key ? -fm.sort.dir : 1 };
        fmRender(fm);
      });
      head.appendChild(c);
    });
    items.appendChild(head);
  }
  for (const e of fm.shown) items.appendChild(fmItem(fm, e));
  const note = !fm.loc
    ? 'pick a place'
    : fm.loading && !fm.entries.length
      ? 'loading…'
      : fm.error && !fm.entries.length
        ? fm.error
        : !fm.shown.length
          ? fm.filter
            ? 'no match'
            : 'empty'
          : '';
  if (note) items.appendChild(el('div', 'fm-empty', note));
  fm.main.replaceChildren(items);
  fmPaintSel(fm);
}

// the rows' grid from the widths dragged, name filling the rest until it's set
export function fmColWidths(fm: Fm, items: HTMLElement) {
  const cols = fm.cols.map(([key, , def]) => (fmWidths[key] ? `${fmWidths[key]}px` : def || 'minmax(8rem, 1fr)'));
  items.style.setProperty('--fm-cols', cols.join(' '));
  items.classList.toggle('fm-sized', !!fmWidths.name);
}

// a header's right edge: dragged for a width, double clicked to fit its cells
export function fmGrip(fm: Fm, items: HTMLElement, grip: HTMLElement, key: string, i: number) {
  const cells = () =>
    [...items.querySelectorAll('.fm-row')]
      .map((r) => r.children[i] as HTMLElement | undefined)
      .filter((c): c is HTMLElement => !!c);
  const set = (px: number) => {
    fmWidths[key] = Math.max(40, Math.round(px));
    for (const f of dkFms) if (f.mode === 'list' && f.main.firstChild) fmColWidths(f, f.main.firstChild as HTMLElement);
  };
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = grip.parentElement!.offsetWidth;
    const move = (ev: PointerEvent) => set(w0 + ev.clientX - x0);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      fmSaveWidths();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  grip.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const fit = (c: HTMLElement) =>
      key === 'name'
        ? [...c.children].reduce((t, k) => t + ((k as HTMLElement).scrollWidth || (k as HTMLElement).offsetWidth), 0) +
          8 * (c.children.length - 1)
        : c.scrollWidth;
    set(Math.max(...cells().map(fit)) + 4);
    fmSaveWidths();
  });
}

export function fmItem(fm: Fm, e: FileEntry): HTMLElement {
  const kind = fmKind(e);
  const row = el('div', fm.mode === 'list' ? 'fm-row fm-item' : 'fm-tile fm-item');
  row.dataset.name = e.name;
  row.draggable = true;
  const name = el('span', 'fm-name');
  name.append(fmIcon(kind), el('span', 'fm-label', e.name));
  // the merged home: greyed while only an offline host has it
  if (e.stale) {
    row.classList.add('fm-stale');
    row.title = `on ${e.hosts!.join(', ')}, offline`;
  }
  if (fm.mode === 'list') {
    const cell: Record<string, HTMLElement> = {
      name,
      where: el('span', 'fm-c-where', fmWhere(e)),
      mtime: el('span', 'fm-c-mtime', fmDate(e.mtime)),
      size: el('span', 'fm-c-size', e.dir ? '' : humanSize(e.size || 0)),
      kind: el('span', 'fm-c-kind', fmKindLabel(e)),
    };
    row.append(...fm.cols.map(([key]) => cell[key]!));
  } else {
    row.append(name);
    row.title = `${e.name}\n${e.dir ? 'folder' : humanSize(e.size || 0)}\n${fmDate(e.mtime)}`;
  }
  row.addEventListener('click', (ev) => {
    fmClick(fm, e.name, ev);
    // a phone's tap opens, as its launcher's does
    if (isMobile() && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) fmOpen(fm, e);
  });
  row.addEventListener('dblclick', () => fmOpen(fm, e));
  row.addEventListener('dragstart', (ev) => {
    if (!fm.sel.has(e.name)) {
      fm.sel = new Set([e.name]);
      fmPaintSel(fm);
    }
    dk.drag = { fm, loc: fm.loc!, items: fmPicked(fm) };
    ev.dataTransfer!.effectAllowed = 'copyMove';
    ev.dataTransfer!.setData(
      'text/plain',
      fmPicked(fm)
        .map((p) => p.rel)
        .join('\n'),
    );
  });
  row.addEventListener('dragend', () => {
    dk.drag = null;
  });
  if (e.dir) fmDropZone(fm, row, () => ({ loc: fm.loc!, dir: filesJoin(fm.dir, e.name) }));
  return row;
}

export function fmPaintSel(fm: Fm) {
  for (const r of fm.main.querySelectorAll<HTMLElement>('.fm-item'))
    r.classList.toggle('sel', fm.sel.has(r.dataset.name!));
  const n = fm.shown.length;
  const picked = fm.shown.filter((e) => fm.sel.has(e.name));
  const bytes = picked.reduce((t, e) => t + (e.size || 0), 0);
  fm.count.textContent = `${n} item${n === 1 ? '' : 's'}${picked.length ? `, ${picked.length} selected${bytes ? ` (${humanSize(bytes)})` : ''}` : ''}`;
}

export function fmClick(fm: Fm, name: string, e: MouseEvent) {
  const names = fm.shown.map((x) => x.name);
  if (e.shiftKey && fm.anchor != null && names.includes(fm.anchor)) {
    const [a, b] = [names.indexOf(fm.anchor), names.indexOf(name)].sort((x, y) => x - y) as [number, number];
    if (!(e.ctrlKey || e.metaKey)) fm.sel.clear();
    for (const n of names.slice(a, b + 1)) fm.sel.add(n);
  } else if (e.ctrlKey || e.metaKey) {
    if (fm.sel.has(name)) fm.sel.delete(name);
    else fm.sel.add(name);
    fm.anchor = name;
  } else {
    fm.sel = new Set([name]);
    fm.anchor = name;
  }
  fmPaintSel(fm);
}

// the picked entries as {rel, dir, name}
export const fmPicked = (fm: Fm): PickedItem[] =>
  fm.shown.filter((e) => fm.sel.has(e.name)).map((e) => ({ rel: filesJoin(fm.dir, e.name), dir: e.dir, name: e.name }));

export function fmOpen(fm: Fm, e: FileEntry) {
  const rel = filesJoin(fm.dir, e.name);
  if (e.dir && !runnable(e)) return fmGo(fm, fm.loc!, rel);
  fileOpen(fm.loc!, rel, e);
}

// keys as a file manager's: arrows, enter, delete, f2, and the clipboard's
export function fmKeys(fm: Fm, e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  const one =
    fm.shown.find((x) => x.name === fm.anchor && fm.sel.has(x.name)) || fm.shown.find((x) => fm.sel.has(x.name));
  if (
    k === 'ArrowDown' ||
    k === 'ArrowUp' ||
    ((k === 'ArrowLeft' || k === 'ArrowRight') && fm.mode === 'grid' && !e.altKey)
  ) {
    const cols =
      fm.mode === 'grid'
        ? Math.max(
            1,
            Math.floor(
              fm.main.clientWidth / ((fm.main.querySelector('.fm-tile') as HTMLElement | null)?.offsetWidth || 1),
            ),
          )
        : 1;
    fmStep(
      fm,
      ({ ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[k]!,
      e.shiftKey,
    );
  } else if (e.altKey && k === 'ArrowLeft') fmHistory(fm, -1);
  else if (e.altKey && k === 'ArrowRight') fmHistory(fm, 1);
  else if ((e.altKey && k === 'ArrowUp') || k === 'Backspace') fmUp(fm);
  else if (k === 'Enter' && one) fmOpen(fm, one);
  else if ((k === 'Delete' || (e.metaKey && k === 'Backspace')) && fm.sel.size) fmDelete(fm);
  else if (k === 'F2' && one) fmRename(fm, one);
  else if (k === 'F5') fmLoad(fm);
  else if (mod && e.shiftKey && k.toLowerCase() === 'n') fmMkdir(fm);
  else if (mod && k.toLowerCase() === 'a') {
    fm.sel = new Set(fm.shown.map((x) => x.name));
    fmPaintSel(fm);
  } else if (mod && k.toLowerCase() === 'c' && fm.sel.size) fmClip(fm, 'copy');
  else if (mod && k.toLowerCase() === 'x' && fm.sel.size) fmClip(fm, 'cut');
  else if (mod && k.toLowerCase() === 'v') fmPaste(fm);
  else if (mod && k.toLowerCase() === 'f') fm.find.focus();
  else if (k === 'Escape') {
    fm.sel.clear();
    fmPaintSel(fm);
  } else if (k.length === 1 && !mod && !e.altKey) {
    // typed letters jump to the next name starting with them
    const names = fm.shown.map((x) => x.name);
    const at = names.indexOf(fm.anchor!);
    const hit = [...names.slice(at + 1), ...names.slice(0, at + 1)].find((n) =>
      n.toLowerCase().startsWith(k.toLowerCase()),
    );
    if (hit) {
      fm.sel = new Set([hit]);
      fm.anchor = hit;
      fmPaintSel(fm);
      fmReveal(fm, hit);
    }
  } else return;
  e.preventDefault();
  e.stopPropagation();
}

export function fmStep(fm: Fm, by: number, extend?: boolean) {
  const names = fm.shown.map((x) => x.name);
  if (!names.length) return;
  const at = names.indexOf(fm.anchor!);
  const to = names[Math.max(0, Math.min(names.length - 1, at < 0 ? 0 : at + by))]!;
  if (!extend) fm.sel.clear();
  fm.sel.add(to);
  fm.anchor = to;
  fmPaintSel(fm);
  fmReveal(fm, to);
}
