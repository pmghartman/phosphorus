// --- the desktop's files: the user's own Desktop folder in the home, a view
// the files app's menu and actions work on as on a window's

import type { FileEntry } from '@phosphorus/wire';
import { app } from '../apps/index.ts';
import {
  type FmView,
  fileOpen,
  filesApi,
  filesCall,
  filesJoin,
  filesParent,
  fmHomeChanged,
  fmIcon,
  fmKind,
  homeLoc,
} from '../features/home/home.ts';
import { el } from '../lib/dom.ts';
import { dk, st } from '../lib/state.ts';
import { dkPaintSel } from './desk/icons.ts';
import { dkFileApp, dkFileOffer, dkWebApp } from './desk/webapps.ts';
import { dkIcon, dkIcons, dkSay } from './desk.ts';
import type { DkWin } from './windows.ts';

// the Desktop folder in the home, none for the boot admin
export const dkDeskDir = () => (st.acct && !st.acct.boot ? `${st.acct.user}/Desktop` : '');
// where a drop lands
export const dkDeskAt = () => (dkDeskDir() && st.selfHost ? { loc: homeLoc(), dir: dkDeskDir() } : null);

// read again whenever the serving host or the user changes
export function dkDeskWatch(): void {
  const key = dkDeskAt() ? `${st.selfHost}\n${st.acct!.user}` : '';
  if (key === dk.deskKey) return;
  dk.deskKey = key;
  dk.deskFiles = [];
  dk.deskReady = false;
  if (key) dkDeskLoad();
}

// the home's digest from the state: a change anywhere in it, every view of it read again,
// as on the first state, a window opened before this host was known among them
export function dkHomeSeen(digest: string | undefined): void {
  if (!digest || digest === dk.homeSeen) return;
  dk.homeSeen = digest;
  fmHomeChanged();
}

// the Desktop folder listed, its last icons kept when it can't be
export async function dkDeskLoad(): Promise<void> {
  const at = dkDeskAt();
  if (!at) return;
  const key = dk.deskKey;
  try {
    const b = await filesCall(at.loc, 'list', undefined, { path: at.dir });
    if (key !== dk.deskKey) return;
    dk.deskFiles = b.entries;
    dk.deskReady = true;
  } catch {}
  dkIcons();
}

const dkInput = Object.assign(el('input'), { type: 'file', multiple: true, hidden: true });

// the desktop as a view: its picks the icons picked
export function dkDeskView(): FmView {
  const at = dkDeskAt();
  const dir = at?.dir ?? '';
  const sel = new Set(dk.deskFiles.filter((e) => dk.sel.has(`doc\n${filesJoin(dir, e.name)}`)).map((e) => e.name));
  const v: FmView = {
    loc: at?.loc ?? null,
    dir,
    entries: dk.deskFiles,
    shown: dk.deskFiles,
    sel,
    anchor: null,
    busy: '',
    box: document.body,
    input: dkInput,
    say: (text) => text && dkSay(text),
    focus: () => {},
    load: () => dkDeskLoad(),
    paint: () => {
      dk.sel = new Set([...v.sel].map((n) => `doc\n${filesJoin(dir, n)}`));
      dkPaintSel();
    },
    open: (rel, isDir) => at && fileOpen(at.loc, rel, { dir: isDir }),
  };
  return v;
}
dkInput.addEventListener('change', () => {
  const v = dkDeskView();
  const list = [...(dkInput.files || [])];
  dkInput.value = '';
  if (v.loc) app('files').then((m) => m.fmUpload(v, v.loc, v.dir, list));
});
document.body.appendChild(dkInput);

// computer files onto the desktop
export function dkDeskUpload(list: File[]): void {
  const v = dkDeskView();
  if (v.loc && list.length) app('files').then((m) => m.fmUpload(v, v.loc, v.dir, list));
}

// a long name cut in its middle, its extension always shown
const DK_NAME_MAX = 24;
function dkShort(n: string): string {
  if (n.length <= DK_NAME_MAX) return n;
  const dot = n.lastIndexOf('.');
  const ext = dot > 0 && n.length - dot <= 8 ? n.slice(dot) : '';
  return `${n.slice(0, DK_NAME_MAX - ext.length - 1)}…${ext}`;
}

export function dkFileIcon(e: FileEntry): HTMLButtonElement {
  const rel = filesJoin(dkDeskDir(), e.name);
  const kind = fmKind(e);
  const pic = kind === 'image' ? filesApi(homeLoc(), 'download', { path: rel, inline: 1 }) : '';
  const b = dkIcon('doc', dkShort(e.name), '', () => fileOpen(homeLoc(), rel, e), pic);
  if (!pic) b.querySelector('.dk-tile')!.replaceChildren(fmIcon(kind));
  b.classList.add(`dk-doc-${kind}`);
  b.dataset.file = rel;
  // placed by its path, whatever its label says
  b.dataset.id = `doc\n${rel}`;
  b.title = e.name;
  return b;
}

// --- a file opened for the agent or a share

// a file as an app, the agent or a share names it; label and share may be missing
export interface FileRef {
  host: string;
  share?: string;
  path: string;
  label?: string;
}

// whether a file is still where it was: its folder listed, it in it
export async function fileThere(f: FileRef): Promise<boolean> {
  try {
    const body = await filesCall({ host: f.host, share: String(f.share ?? '') }, 'list', undefined, {
      path: filesParent(f.path),
    });
    return body.entries.some((e) => e.name === f.path.split('/').pop() && !e.dir);
  } catch {
    return false;
  }
}

// a file in the app that opens it, the app offered when none here does; refused with
// a note when it's gone or nothing could
export async function dkCode(f: FileRef): Promise<DkWin | undefined> {
  const name = f.path.split('/').pop() || f.path;
  if (!(await fileThere(f))) {
    dkSay(`${name} is gone`);
    return;
  }
  const query = { host: f.host, share: String(f.share || '0'), path: f.path };
  const id = dkFileApp(name);
  if (id) return dkWebApp(id, query);
  if (!(await dkFileOffer(name, query))) dkSay(`nothing installed opens ${name}`);
}
