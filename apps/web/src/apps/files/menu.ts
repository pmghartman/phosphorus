// the menu
import { fileLabel, filesApi, fmKind, fmSay, homeOnline, runnable, type Fm } from '../../features/home/home.ts';
import { dk } from '../../lib/state.ts';
import { dkMenu, dkWallSet, type MenuItem } from '../../desktop/desk.ts';
import { dkCode, dkRunItems } from '../../desktop/deskfiles.ts';
import { fmClip, fmDelete, fmDownload, fmMirror, fmMkdir, fmMoveHost, fmPaste, fmRename, fmTouch } from './actions.ts';
import { fmCan, fmOpen, fmPaintSel, fmPicked } from './list.ts';
import { fmGo, fmLoad } from './nav.ts';

export const fmReveal = (fm: Fm, name: string) => [...fm.main.querySelectorAll<HTMLElement>('.fm-item')].find((r) => r.dataset.name === name)?.scrollIntoView({ block: 'nearest' });

export async function fmWallpaper(fm: Fm, rel: string) {
  fmSay(fm, 'setting…');
  try {
    const r = await fetch(filesApi(fm.loc!, 'download', { path: rel }));
    if (!r.ok) throw new Error(`${r.status}`);
    const why = await dkWallSet(await r.blob());
    fmSay(fm, why || 'wallpaper set', !!why);
  } catch (err) { fmSay(fm, `wallpaper: ${(err as Error).message}`, true); }
}

// a right click's menu, on the page so no window's transform shifts it
export function fmMenu(fm: Fm, x: number, y: number, onItem: boolean) {
  const picked = fmPicked(fm);
  const one = picked.length === 1 ? fm.shown.find((e) => e.name === picked[0]!.name) : null;
  const w = fmCan(fm, 'w');
  const items: (MenuItem | false | undefined)[] = onItem ? [
    ['open', () => one && fmOpen(fm, one), !!one],
    one && one.dir && runnable(one) && ['browse inside', () => fmGo(fm, fm.loc!, picked[0]!.rel), true],
    one && !one.dir && ['open in editor', () => dkCode({ host: fm.loc!.host, share: fm.loc!.share, path: picked[0]!.rel, label: fileLabel(fm.loc!.host, fm.loc!.root!, picked[0]!.rel) }), true],
    one && !one.dir && ['download', () => fmDownload(fm, picked[0]!.rel), fmCan(fm, 'r')],
    ...(one && !one.dir && fm.loc!.share === 'home' ? dkRunItems(picked[0]!.rel, fm.loc!.host === '*' ? (one.all ? homeOnline() : one.live || []) : [fm.loc!.host]) : []),
    one && fmKind(one) === 'image' && ['set as wallpaper', () => fmWallpaper(fm, picked[0]!.rel), fmCan(fm, 'r')],
    one && !one.dir && one.hosts && ['keep on every host', () => fmMirror(fm, one, !one.all), true, one.all ? 'on' : ''],
    one && !one.dir && one.hosts && !one.all && ['move to host…', () => fmMoveHost(fm, one), homeOnline().length > 1],
    null,
    ['cut', () => fmClip(fm, 'cut'), fmCan(fm, 'd')],
    ['copy', () => fmClip(fm, 'copy'), true],
    ['paste', () => fmPaste(fm, one?.dir ? picked[0]!.rel : fm.dir), !!dk.clip && w],
    null,
    ['rename', () => fmRename(fm, one!), !!one && w],
    ['delete', () => fmDelete(fm), fmCan(fm, 'd'), 'danger'],
  ] : [
    ['new folder', () => fmMkdir(fm), w],
    ['new text file', () => fmTouch(fm), w],
    ['upload here', () => fm.input.click(), w],
    null,
    ['paste', () => fmPaste(fm), !!dk.clip && w],
    ['select all', () => { fm.sel = new Set(fm.shown.map((e) => e.name)); fmPaintSel(fm); }, true],
    ['refresh', () => fmLoad(fm), true],
  ];
  dkMenu(x, y, items.filter((i): i is MenuItem => i !== false && i !== undefined), () => fm.main.focus({ preventScroll: true }));
}
