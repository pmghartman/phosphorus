// the menu, a files window's and the desktop's files' alike

import { dkMenu, type MenuItem } from '../../desktop/desk.ts';
import { type FmView, fileDownload } from '../../features/home/home.ts';
import { dk } from '../../lib/state.ts';
import { fmClip, fmDelete, fmMkdir, fmPaste, fmRename } from './actions.ts';
import { fmCan, fmPicked } from './list.ts';

// on picked entries: open, download, the clipboard, rename, delete
export function fmItemItems(v: FmView): MenuItem[] {
  const picked = fmPicked(v);
  const one = picked.length === 1 ? picked[0]! : null;
  const w = fmCan(v, 'w');
  return [
    ['open', () => one && v.open(one.rel, one.dir), !!one],
    ...(one && !one.dir ? [['download', () => fileDownload(v.loc!, one.rel), fmCan(v, 'r')] as MenuItem] : []),
    null,
    ['cut', () => fmClip(v, 'cut'), fmCan(v, 'd')],
    ['copy', () => fmClip(v, 'copy'), true],
    ['paste', () => fmPaste(v, one?.dir ? one.rel : v.dir), !!dk.clip && w],
    null,
    ['rename', () => one && fmRename(v, v.shown.find((e) => e.name === one.name)!), !!one && w],
    ['delete', () => fmDelete(v), fmCan(v, 'd'), 'danger'],
  ];
}

// on the folder itself: a new folder, an upload, the clipboard
export function fmBlankItems(v: FmView): MenuItem[] {
  const w = fmCan(v, 'w');
  return [
    ['new folder', () => fmMkdir(v), w],
    ['upload here', () => v.input.click(), w],
    ['paste', () => fmPaste(v), !!dk.clip && w],
  ];
}

// a right click's menu, on the page so no window's transform shifts it
export function fmMenu(v: FmView, x: number, y: number, onItem: boolean) {
  const items: MenuItem[] = onItem
    ? fmItemItems(v)
    : [
        ...fmBlankItems(v),
        null,
        [
          'select all',
          () => {
            v.sel = new Set(v.shown.map((e) => e.name));
            v.paint();
          },
          true,
        ],
        ['refresh', () => v.load(), true],
      ];
  dkMenu(x, y, items, () => v.focus());
}
