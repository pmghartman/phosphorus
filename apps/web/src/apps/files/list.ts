// the list: sorting, rows, selection and keys

import type { FileEntry } from '@phosphorus/wire';
import { hostInfo } from '../../desktop/desk/hosts.ts';
import {
  type Fm,
  type FmView,
  filesJoin,
  fmIcon,
  fmKind,
  isDesk,
  isHome,
  may,
  type PickedItem,
} from '../../features/home/home.ts';
import { el, isMobile } from '../../lib/dom.ts';
import { dk } from '../../lib/state.ts';
import { humanSize } from '../../lib/util.ts';
import { fmClip, fmDelete, fmDropZone, fmMkdir, fmPaste, fmRename } from './actions.ts';
import { FM_COLS, fmDate } from './files.ts';
import { fmBack, fmGo, fmLoad, fmUp } from './nav.ts';
import { shareLabel } from './side.ts';

export const fmCan = (v: FmView, perm: string) => !!v.loc && may(v.loc, perm);

export function fmSorted(fm: Fm): FileEntry[] {
  const { key, dir } = fm.sort;
  const val = (e: FileEntry): string | number =>
    key === 'size' ? (e.size ?? -1) : key === 'mtime' ? (e.mtime ?? 0) : e.name.toLowerCase();
  return [...fm.entries].sort((a, b) =>
    a.dir !== b.dir ? (a.dir ? -1 : 1) : (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir,
  );
}

export function fmRender(fm: Fm) {
  fm.backBtn.disabled = !fm.back.length;
  fm.upBtn.disabled = !fm.dir;
  fm.badge.hidden = !fm.loc || fmCan(fm, 'w');
  // the path bar: the place, then each folder, any one a jump
  const crumbs: HTMLElement[] = [];
  // a host's disk: the host, its drives under it, or its / on Linux
  const deskTop = (h: string) => (hostInfo(h).desk?.os === 'windows' ? h : `${h} /`);
  const top = !fm.loc
    ? ''
    : isHome(fm.loc)
      ? 'home'
      : isDesk(fm.loc)
        ? deskTop(fm.loc.host)
        : `${fm.loc.host}: ${shareLabel(fm.loc.root!)}`;
  if (fm.loc) {
    const parts = fm.dir ? fm.dir.split('/') : [];
    [top, ...parts].forEach((name, i) => {
      const c = Object.assign(el('button', 'fm-crumb', name), { type: 'button' });
      const to = parts.slice(0, i).join('/');
      c.addEventListener('click', () => to !== fm.dir && fmGo(fm, fm.loc!, to));
      fmDropZone(fm, c, () => ({ loc: fm.loc!, dir: to }));
      crumbs.push(...(crumbs.length ? [el('span', 'fm-crumb-sep', '›')] : []), c);
    });
  }
  fm.crumbs.replaceChildren(...crumbs);
  const name = fm.loc ? fm.dir.split('/').pop() || top : 'files';
  fm.w.task.querySelector('.dk-task-t')!.textContent = name;
  fm.w.head.querySelector('.tab-label')!.textContent = name;

  fm.shown = fmSorted(fm);
  const items = el('div', 'fm-items');
  const head = el('div', 'fm-row fm-cols');
  for (const [key, label] of FM_COLS) {
    const c = Object.assign(el('button', `fm-col fm-c-${key}`, label), { type: 'button' });
    if (fm.sort.key === key) c.append(el('span', 'fm-arrow', fm.sort.dir > 0 ? ' ▴' : ' ▾'));
    c.addEventListener('click', () => {
      fm.sort = { key, dir: fm.sort.key === key ? -fm.sort.dir : 1 };
      fmRender(fm);
    });
    head.appendChild(c);
  }
  items.appendChild(head);
  for (const e of fm.shown) items.appendChild(fmItem(fm, e));
  const note = !fm.loc
    ? 'pick a place'
    : fm.loading && !fm.entries.length
      ? 'loading…'
      : fm.error && !fm.entries.length
        ? fm.error
        : !fm.shown.length
          ? 'empty'
          : '';
  if (note) items.appendChild(el('div', 'fm-empty', note));
  fm.main.replaceChildren(items);
  fmPaintSel(fm);
}

export function fmItem(fm: Fm, e: FileEntry): HTMLElement {
  const row = el('div', 'fm-row fm-item');
  row.dataset.name = e.name;
  row.draggable = true;
  const name = el('span', 'fm-name');
  name.append(fmIcon(fmKind(e)), el('span', 'fm-label', e.name));
  row.append(
    name,
    el('span', 'fm-c-size', e.dir ? '' : humanSize(e.size || 0)),
    el('span', 'fm-c-mtime', fmDate(e.mtime)),
  );
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
    dk.drag = { v: fm, loc: fm.loc!, items: fmPicked(fm) };
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
export const fmPicked = (v: FmView): PickedItem[] =>
  v.shown.filter((e) => v.sel.has(e.name)).map((e) => ({ rel: filesJoin(v.dir, e.name), dir: e.dir, name: e.name }));

// a folder opened in this window, a file downloaded
export const fmOpen = (fm: Fm, e: FileEntry) => fm.open(filesJoin(fm.dir, e.name), e.dir);

const fmReveal = (fm: Fm, name: string) =>
  [...fm.main.querySelectorAll<HTMLElement>('.fm-item')]
    .find((r) => r.dataset.name === name)
    ?.scrollIntoView({ block: 'nearest' });

// keys as a file manager's: arrows, enter, delete, f2, and the clipboard's
export function fmKeys(fm: Fm, e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key;
  const one =
    fm.shown.find((x) => x.name === fm.anchor && fm.sel.has(x.name)) || fm.shown.find((x) => fm.sel.has(x.name));
  if ((k === 'ArrowDown' || k === 'ArrowUp') && !e.altKey) fmStep(fm, k === 'ArrowDown' ? 1 : -1, e.shiftKey);
  else if (e.altKey && k === 'ArrowLeft') fmBack(fm);
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
  else if (k === 'Escape') {
    fm.sel.clear();
    fmPaintSel(fm);
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
