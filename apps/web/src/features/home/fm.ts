// what the file manager windows and the desktop's files share
import { jsonPost } from '../../lib/api.ts';
import { app, appCall } from '../../apps/index.ts';
import { dkGlyph, ICONS } from '../../lib/dom.ts';
import type { FileEntry } from '@phosphorus/wire';
import type { DkWin } from '../../desktop/windows.ts';
import { dkCode, dkDeskDirs, dkDeskLoad, dkRun } from '../../desktop/deskfiles.ts';
import { filesCall, filesJoin, filesParent, may, type Loc } from './api.ts';
import { fileLabel, isCode } from './editors.ts';
import { homeAt, homeOnline, homePick, homeTarget, isHome } from './merged.ts';
import { copyFile, copyTree } from './transfer.ts';

// a file manager window's state (apps/files.ts makes one per window)
export interface ShareInfo { shares?: Loc[]; error?: string }
export interface PickedItem { rel: string; dir: boolean; name: string }
export interface Fm {
  w: DkWin;
  loc: Loc | null;
  dir: string;
  back: { loc: Loc; dir: string }[];
  fwd: { loc: Loc; dir: string }[];
  entries: FileEntry[];
  shown: FileEntry[];
  sel: Set<string>;
  anchor: string | null;
  sort: { key: string; dir: number };
  mode: string;
  filter: string;
  shares: Map<string, ShareInfo | null>;
  busy: string;
  backBtn: HTMLButtonElement;
  fwdBtn: HTMLButtonElement;
  upBtn: HTMLButtonElement;
  modeBtn: HTMLButtonElement;
  crumbs: HTMLElement;
  find: HTMLInputElement;
  side: HTMLElement;
  main: HTMLElement;
  status: HTMLElement;
  count: HTMLElement;
  note: HTMLElement;
  input: HTMLInputElement;
  cols: [string, string, string | null][];
  renderSide?: () => void;
  sideSig?: string;
  loading?: string;
  error?: string;
  pendingUpload?: File[] | FileList | null;
  noteTimer?: ReturnType<typeof setTimeout>;
  spring?: { node: Element; timer: ReturnType<typeof setTimeout> } | null;
}
// a drop zone's target: a place and a folder in it
export interface DropTarget { loc: Loc; dir: string }
// a choice in a box: label, value, why disabled
export type Choice = [string, string, string?];

export const fmExt = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');

export function fmKind(e: { name: string; dir?: boolean }): string {
  if (e.dir) return 'dir';
  const x = fmExt(e.name);
  for (const k in FM_KINDS) if (FM_KINDS[k]!.includes(x)) return k;
  return isCode(e.name) ? 'code' : 'file';
}

export const fmIcon = (kind: string) => dkGlyph(FM_GLYPHS[kind]!, `fm-${kind}`);

export const fmSame = (a: Loc | null | undefined, b: Loc | null | undefined) => !!a && !!b && a.host === b.host && a.share === b.share;

// every window showing that folder, read again
export function fmChanged(loc: Loc, ...dirs: string[]): void {
  const same = (a: Loc | null) => fmSame(a, loc) || (isHome(a) && isHome(loc));
  for (const fm of dkFms) if (same(fm.loc) && dirs.includes(fm.dir)) appCall('files', false, (m) => m.fmLoad(fm));
  if (isHome(loc) && dkDeskDirs().some((d) => dirs.includes(d))) dkDeskLoad(true);
}

// pages, wasm and NAME.app folders run, text edits, the rest shown
export const runnable = (e: { name: string; dir?: boolean }) => (e.dir ? /\.app$/i.test(e.name) : ['html', 'htm', 'wasm'].includes(fmExt(e.name)));

export function fileOpen(loc: Loc, rel: string, e: FileEntry): unknown {
  if (loc.host === '*' && !(e.dir && !runnable(e))) loc = homeAt(homePick(rel));
  if (runnable(e)) return dkRun(loc, rel);
  if (e.dir) return filesWin({ loc, dir: rel });
  if (isCode(e.name)) return dkCode({ host: loc.host, share: loc.share!, path: rel, label: fileLabel(loc.host, loc.root!, rel) });
  app('files').then((m) => m.dkViewer(loc, rel));
}

// inside one share a move is a rename, anything else bytes through the page,
// a move's source deleted once its copy is whole
export async function fmTransfer(fm: Fm, from: Loc, items: PickedItem[], to: Loc, dir: string, move: boolean): Promise<void> {
  if (!may(to, 'w')) return fmSay(fm, 'read-only', true);
  // into the home, other than a move inside it: where the copies go; every
  // host's a folder copied to each, a file kept in step
  let all = false;
  let alsoTo: Loc[] = [];
  if (to.host === '*' && !(move && fmSame(from, to))) {
    const t = await homeTarget(fm, items.some((it) => it.dir) ? 0 : 1, items.length === 1 ? items[0]!.name : `${items.length} items`);
    if (!t) return;
    all = t.all;
    if (all) alsoTo = homeOnline().filter((h) => h !== t.host).map(homeAt);
    to = homeAt(t.host);
  }
  const label = move ? 'moving' : 'copying';
  let failed = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    const dst = filesJoin(dir, it.name);
    if (fmSame(from, to) && (dst === it.rel || `${dir}/`.startsWith(`${it.rel}/`))) {
      if (move || it.dir) { failed += 1; fmSay(fm, 'into itself', true); continue; }
    }
    const tick = (f: number, child?: string) => { fm.busy = 'x'; fmSay(fm, `${label} ${Math.round(f * 100)}%`); };
    try {
      if (move && fmSame(from, to)) {
        await filesCall(to, 'rename', jsonPost({ from: it.rel, to: dst }));
      } else {
        // a copy into its own folder, as a file manager's: "name copy.ext"
        let target = dst;
        if (fmSame(from, to) && filesParent(it.rel) === dir) {
          const x = it.dir ? '' : fmExt(it.name);
          target = filesJoin(dir, x ? `${it.name.slice(0, -x.length - 1)} copy.${x}` : `${it.name} copy`);
        }
        if (it.dir) {
          await copyTree(from, it.rel, to, target, tick);
          for (const other of alsoTo) await copyTree(from, it.rel, other, target, tick);
        } else {
          await copyFile(from, it.rel, to, target, tick);
          if (all) await filesCall(to, 'mirror', jsonPost({ path: target, on: true }));
        }
        if (move) await filesCall(from, 'delete', jsonPost({ path: it.rel }));
      }
    } catch (err) { failed += 1; fm.busy = ''; fmSay(fm, `${it.name}: ${(err as Error).message}`, true); }
  }
  fm.busy = '';
  if (!failed) fmSay(fm, move ? 'moved' : 'copied');
  fmChanged(to, dir);
  if (move) fmChanged(from, ...new Set(items.map((it) => filesParent(it.rel))));
}

export function fmSpring(fm: Fm, node: Element, t: DropTarget): void {
  if (fm.spring?.node === node) return;
  clearTimeout(fm.spring?.timer);
  fm.spring = null;
  if (fmSame(t.loc, fm.loc) && t.dir === fm.dir) return;
  fm.spring = { node, timer: setTimeout(() => { fm.spring = null; node.classList.remove('drop'); app('files').then((m) => m.fmGo(fm, t.loc, t.dir)); }, FM_SPRING_MS) };
}

export function fmUnspring(fm: Fm, node?: Element): void {
  if (node && fm.spring?.node !== node) return;
  clearTimeout(fm.spring?.timer);
  fm.spring = null;
}

// every drop zone's window and target, for the desktop's own icon drags
export const fmZones = new WeakMap<Element, { fm: Fm; where: () => DropTarget | null }>();

export function fmMark(fm: Fm, node: Element | null): void {
  for (const root of [fm.main, fm.side]) root?.querySelectorAll('.drop').forEach((x) => x !== node && x.classList.remove('drop'));
  node?.classList.add('drop');
}

export const FM_KINDS: Record<string, string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
  video: ['mp4', 'webm', 'mkv', 'mov', 'avi'],
  audio: ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'opus'],
  archive: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2', 'zst'],
  pdf: ['pdf'],
};

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
};

// every file manager open, for a change one makes shown in the rest
export const dkFms = new Set<Fm>();

// a folder or place held under a drag this long: opened, the drag going on
export const FM_SPRING_MS = 700;

export const fmSay = (fm: Fm, text: string, bad?: boolean) => {
  fm.note.textContent = text || '';
  fm.note.classList.toggle('bad', !!bad);
  clearTimeout(fm.noteTimer);
  if (text && !fm.busy) fm.noteTimer = setTimeout(() => { if (fm.note.textContent === text) fm.note.textContent = ''; }, 6000);
};

// the file manager's window and its choices, fetched on first open
export const filesWin = (at?: DropTarget) => app('files').then((m) => m.dkFiles(at));
export const filesChoose = (fm: Fm, ask: { title: string; message: string; options: Choice[] }) => app('files').then((m) => m.dkChoose(fm, ask));
