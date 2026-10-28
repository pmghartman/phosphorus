// actions: mirror, move, make, rename, delete, download, paste, upload

import type { FileEntry } from '@phosphorus/wire';
import { dkCode } from '../../desktop/deskfiles.ts';
import {
  type Choice,
  copyFile,
  type DropTarget,
  type Fm,
  fileLabel,
  filesApi,
  filesCall,
  filesJoin,
  filesPath,
  fmChanged,
  fmMark,
  fmSame,
  fmSay,
  fmSpring,
  fmTransfer,
  fmUnspring,
  fmZones,
  HOME,
  homeAt,
  homeHolders,
  homeOnline,
  homePick,
  homeTarget,
  type Loc,
  may,
  putFile,
} from '../../features/home/home.ts';
import { jsonPost } from '../../lib/api.ts';
import { dk } from '../../lib/state.ts';
import { dkAsk, dkChoose } from './dialogs.ts';
import { fmCan, fmPicked } from './list.ts';

// a home file kept on every host, or back to only the one it's read from

export async function fmMirror(fm: Fm, e: FileEntry, on: boolean) {
  const rel = filesJoin(fm.dir, e.name);
  const host = homePick(rel);
  if (!on) {
    const keep = await dkChoose(fm, {
      title: 'keep it only on',
      message: e.name,
      options: homeOnline().map((h): Choice => [h, h]),
    });
    if (!keep) return;
    try {
      await filesCall(homeAt(keep), 'mirror', jsonPost({ path: rel, on: false }));
    } catch (err) {
      return fmSay(fm, (err as Error).message, true);
    }
    fmSay(fm, `kept on ${keep}`);
  } else {
    try {
      await filesCall(homeAt(host), 'mirror', jsonPost({ path: rel, on: true }));
    } catch (err) {
      return fmSay(fm, (err as Error).message, true);
    }
    fmSay(fm, 'mirroring');
  }
  setTimeout(() => fmChanged(HOME, fm.dir), 4000);
  fmChanged(HOME, fm.dir);
}

// the bytes to one host, then off the rest
export async function fmMoveHost(fm: Fm, e: FileEntry) {
  const rel = filesJoin(fm.dir, e.name);
  const to = await dkChoose(fm, {
    title: 'move to',
    message: `${e.name}, now on ${e.hosts!.join(', ')}`,
    options: homeOnline().map(
      (h): Choice => [h, h, e.hosts!.includes(h) && e.hosts!.length === 1 ? 'already there' : ''],
    ),
  });
  if (!to) return;
  try {
    const from = homePick(rel);
    if (from !== to)
      await copyFile(homeAt(from), rel, homeAt(to), rel, (f) => fmSay(fm, `moving ${Math.round(f * 100)}%`));
    for (const h of homeHolders(rel)) if (h !== to) await filesCall(homeAt(h), 'delete', jsonPost({ path: rel }));
    fmSay(fm, `moved to ${to}`);
  } catch (err) {
    fmSay(fm, (err as Error).message, true);
  }
  fmChanged(HOME, fm.dir);
}

export async function fmMkdir(fm: Fm) {
  if (!fmCan(fm, 'w')) return fmSay(fm, 'read-only', true);
  const name = await dkAsk(fm, {
    title: 'new folder',
    message: `in ${filesPath(fm.loc!.host, fm.loc!.root!, fm.dir)}`,
    value: 'new folder',
    action: 'create',
  });
  if (!name) return;
  try {
    await filesCall(fm.loc!, 'mkdir', jsonPost({ path: filesJoin(fm.dir, name as string) }));
    fm.sel = new Set([name as string]);
    fm.anchor = name as string;
    fmChanged(fm.loc!, fm.dir);
  } catch (err) {
    fmSay(fm, (err as Error).message, true);
  }
}

// an empty file, then the editor on it
export async function fmTouch(fm: Fm) {
  const name = (await dkAsk(fm, {
    title: 'new text file',
    message: `in ${filesPath(fm.loc!.host, fm.loc!.root!, fm.dir)}`,
    value: 'untitled.txt',
    action: 'create',
  })) as string | null;
  if (!name) return;
  const rel = filesJoin(fm.dir, name);
  if (fm.entries.some((e) => e.name === name)) return fmSay(fm, 'exists', true);
  let loc = fm.loc!;
  let all = false;
  if (loc.host === '*') {
    const t = await homeTarget(fm, 0, name);
    if (!t) return;
    loc = homeAt(t.host);
    all = t.all;
  }
  try {
    await putFile(loc, rel, new Blob([]));
    if (all) await filesCall(loc, 'mirror', jsonPost({ path: rel, on: true }));
    fmChanged(loc, fm.dir);
    dkCode({ host: loc.host, share: loc.share, path: rel, label: fileLabel(loc.host, loc.root!, rel) });
  } catch (err) {
    fmSay(fm, (err as Error).message, true);
  }
}

export async function fmRename(fm: Fm, e: FileEntry) {
  const name = (await dkAsk(fm, {
    title: 'rename',
    message: filesPath(fm.loc!.host, fm.loc!.root!, filesJoin(fm.dir, e.name)),
    value: e.name,
    action: 'rename',
  })) as string | null;
  if (!name || name === e.name) return;
  try {
    await filesCall(fm.loc!, 'rename', jsonPost({ from: filesJoin(fm.dir, e.name), to: filesJoin(fm.dir, name) }));
    fm.sel = new Set([name]);
    fm.anchor = name;
    fmChanged(fm.loc!, fm.dir);
  } catch (err) {
    fmSay(fm, (err as Error).message, true);
  }
}

export async function fmDelete(fm: Fm) {
  const picked = fmPicked(fm);
  if (!picked.length) return;
  const what = picked.length === 1 ? picked[0]!.name : picked.length;
  const ok = await dkAsk(fm, { title: 'delete', message: `delete ${what}?`, action: 'delete', danger: true });
  if (!ok) return;
  const loc = fm.loc!;
  const dir = fm.dir;
  for (const p of picked) {
    try {
      await filesCall(loc, 'delete', jsonPost({ path: p.rel }));
    } catch (err) {
      fmSay(fm, `${p.name}: ${(err as Error).message}`, true);
    }
  }
  fm.sel.clear();
  fmChanged(loc, dir);
}

export function fmDownload(fm: Fm, rel: string) {
  const a = Object.assign(document.createElement('a'), {
    href: filesApi(fm.loc!, 'download', { path: rel }),
    download: rel.split('/').pop()!,
  });
  a.click();
}

export function fmClip(fm: Fm, op: 'cut' | 'copy') {
  dk.clip = { op, loc: fm.loc!, items: fmPicked(fm) };
  fmSay(fm, op === 'cut' ? 'cut' : 'copied');
}

export async function fmPaste(fm: Fm, dir = fm.dir) {
  const clip = dk.clip;
  if (!clip || !fm.loc) return;
  if (clip.op === 'cut') dk.clip = null;
  await fmTransfer(fm, clip.loc, clip.items, fm.loc, dir, clip.op === 'cut');
}

export async function fmUpload(fm: Fm, loc: Loc | null, dir: string, fileList: FileList | File[]) {
  const list = [...fileList];
  if (!list.length || !loc) return;
  if (!may(loc, 'w')) return fmSay(fm, 'read-only', true);
  let all = false;
  if (loc.host === '*') {
    const bytes = list.reduce((t, f) => Math.max(t, f.size), 0);
    const t = await homeTarget(fm, bytes, list.length === 1 ? list[0]!.name : `${list.length} files`);
    if (!t) return;
    loc = homeAt(t.host);
    all = t.all;
  }
  for (let i = 0; i < list.length; i++) {
    const f = list[i]!;
    try {
      fm.busy = 'x';
      await putFile(loc, filesJoin(dir, f.name), f, (sent) =>
        fmSay(fm, `uploading ${f.size ? Math.round((sent / f.size) * 100) : 100}%`),
      );
      if (all) await filesCall(loc, 'mirror', jsonPost({ path: filesJoin(dir, f.name), on: true }));
    } catch (err) {
      fm.busy = '';
      fmSay(fm, `${f.name}: ${(err as Error).message}`, true);
    }
  }
  fm.busy = '';
  fmSay(fm, 'uploaded');
  fmChanged(loc, dir);
}

// a folder, a place or blank space taking a drag: the computer's own files
// uploaded, a window's moved inside one share or copied (ctrl) across them
export function fmDropZone(fm: Fm, node: HTMLElement, where: () => DropTarget | null) {
  fmZones.set(node, { fm, where });
  node.dataset.fmDrop = '';
  node.addEventListener('dragover', (e) => {
    const t = where();
    if (!t || (!dk.drag && !e.dataTransfer!.types.includes('Files'))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = dk.drag && fmSame(dk.drag.loc, t.loc) && !e.ctrlKey && !e.altKey ? 'move' : 'copy';
    fmMark(fm, node);
    fmSpring(fm, node, t);
  });
  node.addEventListener('dragleave', (e) => {
    if (node.contains(e.relatedTarget as Node | null)) return;
    node.classList.remove('drop');
    fmUnspring(fm, node);
  });
  node.addEventListener('drop', (e) => {
    const t = where();
    fmUnspring(fm);
    node.classList.remove('drop');
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const drag = dk.drag;
    dk.drag = null;
    if (drag) {
      const items = drag.items.filter((it) => !(fmSame(drag.loc, t.loc) && it.rel === t.dir));
      if (items.length)
        fmTransfer(fm, drag.loc, items, t.loc, t.dir, fmSame(drag.loc, t.loc) && !e.ctrlKey && !e.altKey);
    } else fmUpload(fm, t.loc, t.dir, e.dataTransfer!.files);
  });
}
