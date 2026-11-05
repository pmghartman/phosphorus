// what a files window and the desktop share: a folder on show, its entries and
// picks, opening, copies between places, the drop zones

import type { FileEntry } from '@phosphorus/wire';
import { app, appCall } from '../../apps/index.ts';
import { dkFileApp, dkFileOffer, dkWebApp } from '../../desktop/desk/webapps.ts';
import { dkDeskDir, dkDeskLoad } from '../../desktop/deskfiles.ts';
import { deskLaunch } from '../../desktop/spaces.ts';
import type { DkWin } from '../../desktop/windows.ts';
import { dkGlyph, ICONS } from '../../lib/dom.ts';
import { deskAbs, filesApi, filesCopy, filesJoin, filesParent, hostOf, isDesk, isHome, type Loc, may } from './api.ts';

export interface PickedItem {
  rel: string;
  dir: boolean;
  name: string;
}

// a folder on show, a files window's or the desktop's: what the menu and the
// actions work on
export interface FmView {
  loc: Loc | null;
  dir: string;
  entries: FileEntry[];
  shown: FileEntry[];
  sel: Set<string>;
  anchor: string | null;
  busy: string;
  // where its dialogs go, its file picker, how it says how things went
  box: HTMLElement;
  input: HTMLInputElement;
  say: (text: string, bad?: boolean) => void;
  focus: () => void;
  // its folder read again, its picks shown, an entry opened
  load: () => void;
  paint: () => void;
  open: (rel: string, dir: boolean) => void;
}

// a files window's own, past the view (apps/files makes one per window)
export interface ShareInfo {
  shares?: Loc[];
  error?: string;
}
export interface Fm extends FmView {
  w: DkWin;
  back: { loc: Loc; dir: string }[];
  sort: { key: string; dir: number };
  shares: Map<string, ShareInfo | null>;
  backBtn: HTMLButtonElement;
  upBtn: HTMLButtonElement;
  crumbs: HTMLElement;
  badge: HTMLElement;
  side: HTMLElement;
  main: HTMLElement;
  count: HTMLElement;
  note: HTMLElement;
  renderSide?: () => void;
  sideSig?: string;
  loading?: string;
  error?: string;
  pendingUpload?: File[] | FileList | null;
  noteTimer?: ReturnType<typeof setTimeout>;
}
// a drop zone's target: a place and a folder in it
export interface DropTarget {
  loc: Loc;
  dir: string;
}

export const fmExt = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

export const FM_KINDS: Record<string, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus'],
  archive: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'zst'],
  pdf: ['pdf'],
  code: [
    ...['js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'c', 'h', 'cpp', 'hpp', 'go', 'rs', 'java', 'rb', 'lua', 'cs'],
    ...['php', 'sql', 'css', 'html', 'htm', 'xml', 'json', 'yml', 'yaml', 'toml', 'ini', 'md', 'txt', 'log', 'csv'],
  ],
};

export function fmKind(e: { name: string; dir?: boolean }): string {
  // a Windows drive at a host's disk's top; no folder's name has a colon there
  if (e.dir && /^[A-Za-z]:$/.test(e.name)) return 'drive';
  if (e.dir) return 'dir';
  const x = fmExt(e.name);
  for (const k in FM_KINDS) if (FM_KINDS[k]!.includes(x)) return k;
  return 'file';
}

export const FM_GLYPHS: Record<string, string> = {
  dir: 'M1.5 3.5h4l1.2 1.5h7.8v8h-13z',
  file: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3',
  code: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M6.5 8l-1.5 1.5 1.5 1.5M9.5 8l1.5 1.5-1.5 1.5',
  image: 'M2 3h12v10H2zM2 11l3.5-3.5 3 3 2-2 3.5 3.5M10.5 5.5h.01',
  video: 'M2 3.5h12v9H2zM6.5 6v4l3.5-2z',
  audio: 'M6 12.5a1.5 1.5 0 1 1-1.5-1.5H6V3l7-1.5v9a1.5 1.5 0 1 1-1.5-1.5H13',
  archive: 'M3.5 1.5h9v13h-9zM8 1.5v2M8 4.5v1M8 6.5v1M7 8.5h2v2H7z',
  pdf: 'M3.5 1.5h6l3 3v10h-9zM9.5 1.5v3h3M5.5 9.5h5M5.5 12h3.5',
  host: ICONS.host!,
  drive: 'M1.5 9h13v4.5h-13zM3 9l1.6-5.5h6.8L13 9M11.5 11.25h.01',
};

export const fmIcon = (kind: string) => dkGlyph(FM_GLYPHS[kind]!, `fm-${kind}`);

// one place: the home is the same on every host
export const fmSame = (a: Loc | null | undefined, b: Loc | null | undefined) =>
  !!a && !!b && ((isHome(a) && isHome(b)) || (a.host === b.host && a.share === b.share));

// every files window open, for a change one makes shown in the rest
export const dkFms = new Set<Fm>();

// every view showing one of those folders, read again
export function fmChanged(loc: Loc, ...dirs: string[]): void {
  for (const fm of dkFms) if (fmSame(fm.loc, loc) && dirs.includes(fm.dir)) fm.load();
  if (isHome(loc) && dirs.includes(dkDeskDir())) dkDeskLoad();
}

// the home changed on this host: every view of it read again
export function fmHomeChanged(): void {
  for (const fm of dkFms) if (isHome(fm.loc) && !fm.busy) fm.load();
  dkDeskLoad();
}

// a folder opens in a files window, a file in the app that opens it or downloads
export function fileOpen(loc: Loc, rel: string, e: { dir?: boolean }): void {
  if (e.dir) {
    filesWin({ loc, dir: rel });
    return;
  }
  // in the installed app that opens its kind, else that app offered, else downloaded
  // a shortcut or program on a host's disk: launched there, as its own desktop would
  if (isDesk(loc) && /\.(lnk|desktop|url|exe)$/i.test(rel)) return void deskLaunch(loc.host, deskAbs(rel));
  // a host's disk: the path as the host names it
  const query = { host: hostOf(loc), share: loc.share || '0', path: isDesk(loc) ? deskAbs(rel) : rel };
  const id = dkFileApp(rel);
  if (id) dkWebApp(id, query);
  else
    dkFileOffer(rel, query, () => fileDownload(loc, rel)).then((asked) => {
      if (!asked) fileDownload(loc, rel);
    });
}

export function fileDownload(loc: Loc, rel: string): void {
  const a = Object.assign(document.createElement('a'), {
    href: filesApi(loc, 'download', { path: rel }),
    download: rel.split('/').pop()!,
  });
  a.click();
}

// items copied, or moved, into dir: one server-side copy each, between any hosts;
// a copy into its own folder named as a file manager's, "name copy.ext"
export async function fmTransfer(
  v: FmView,
  from: Loc,
  items: PickedItem[],
  to: Loc,
  dir: string,
  move: boolean,
): Promise<void> {
  if (!may(to, 'w')) return v.say('read-only', true);
  const label = move ? 'moving' : 'copying';
  let failed = 0;
  v.busy = 'x';
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    let dst = filesJoin(dir, it.name);
    const here = fmSame(from, to);
    if (here && (dst === it.rel || `${dir}/`.startsWith(`${it.rel}/`)) && (move || it.dir)) {
      failed += 1;
      v.say('not into itself', true);
      continue;
    }
    if (here && !move && filesParent(it.rel) === dir) {
      const x = it.dir ? '' : fmExt(it.name);
      dst = filesJoin(dir, x ? `${it.name.slice(0, -x.length - 1)} copy.${x}` : `${it.name} copy`);
    }
    v.say(items.length > 1 ? `${label} ${i + 1} of ${items.length}` : `${label} ${it.name}`);
    try {
      await filesCopy(from, it.rel, to, dst, move);
    } catch (err) {
      failed += 1;
      v.say(`${it.name}: ${(err as Error).message}`, true);
    }
  }
  v.busy = '';
  if (!failed) v.say(move ? 'moved' : 'copied');
  fmChanged(to, dir);
  if (move) fmChanged(from, ...new Set(items.map((it) => filesParent(it.rel))));
}

// every drop zone's view and target, for the desktop's own icon drags
export const fmZones = new WeakMap<Element, { v: FmView; where: () => DropTarget | null }>();

export function fmMark(node: Element | null): void {
  document.querySelectorAll('[data-fm-drop].drop').forEach((x) => x !== node && x.classList.remove('drop'));
  node?.classList.add('drop');
}

// a files window, at a folder when given
export const filesWin = (at?: DropTarget) => app('files').then((m) => m.dkFiles(at));
// a view's right click menu, from the files app
export const fmMenuAt = (v: FmView, x: number, y: number, onItem: boolean) =>
  appCall('files', true, (m) => m.fmMenu(v, x, y, onItem));
