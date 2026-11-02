// actions: make, rename, delete, the clipboard, upload, drops

import type { FileEntry } from '@phosphorus/wire';
import {
  type DropTarget,
  type FmView,
  filesCall,
  filesJoin,
  filesPath,
  fmChanged,
  fmMark,
  fmSame,
  fmTransfer,
  fmZones,
  isHome,
  type Loc,
  may,
  putFile,
} from '../../features/home/home.ts';
import { jsonPost } from '../../lib/api.ts';
import { dk } from '../../lib/state.ts';
import { dkAsk } from './dialogs.ts';
import { fmCan, fmPicked } from './list.ts';

// where a view's folder is, for a dialog
const fmWhere = (v: FmView) => (isHome(v.loc) ? filesJoin('Home', v.dir) : filesPath(v.loc!.host, v.loc!.root!, v.dir));

export async function fmMkdir(v: FmView) {
  if (!fmCan(v, 'w')) return v.say('read-only', true);
  const name = await dkAsk(v, {
    title: 'new folder',
    message: `in ${fmWhere(v)}`,
    value: 'new folder',
    action: 'create',
  });
  if (typeof name !== 'string') return;
  try {
    await filesCall(v.loc!, 'mkdir', jsonPost({ path: filesJoin(v.dir, name) }));
    v.sel = new Set([name]);
    v.anchor = name;
    fmChanged(v.loc!, v.dir);
  } catch (err) {
    v.say((err as Error).message, true);
  }
}

export async function fmRename(v: FmView, e: FileEntry) {
  const name = await dkAsk(v, { title: 'rename', message: `in ${fmWhere(v)}`, value: e.name, action: 'rename' });
  if (typeof name !== 'string' || name === e.name) return;
  try {
    await filesCall(v.loc!, 'rename', jsonPost({ from: filesJoin(v.dir, e.name), to: filesJoin(v.dir, name) }));
    v.sel = new Set([name]);
    v.anchor = name;
    fmChanged(v.loc!, v.dir);
  } catch (err) {
    v.say((err as Error).message, true);
  }
}

// into the folder's trash (.trash); what's in a trash already, gone for good
export async function fmDelete(v: FmView) {
  const picked = fmPicked(v);
  if (!picked.length) return;
  const what = picked.length === 1 ? picked[0]!.name : `${picked.length} items`;
  const gone = v.dir.split('/').includes('.trash');
  const ok = await dkAsk(v, {
    title: 'delete',
    message: gone ? `delete ${what} for good?` : `move ${what} to the trash?`,
    action: 'delete',
    danger: true,
  });
  if (!ok) return;
  const loc = v.loc!;
  const dir = v.dir;
  for (const p of picked) {
    try {
      await filesCall(loc, 'delete', jsonPost({ path: p.rel }));
    } catch (err) {
      v.say(`${p.name}: ${(err as Error).message}`, true);
    }
  }
  v.sel.clear();
  fmChanged(loc, dir);
}

export function fmClip(v: FmView, op: 'cut' | 'copy') {
  dk.clip = { op, loc: v.loc!, items: fmPicked(v) };
  v.say(op === 'cut' ? 'cut' : 'copied');
}

export async function fmPaste(v: FmView, dir = v.dir) {
  const clip = dk.clip;
  if (!clip || !v.loc) return;
  if (clip.op === 'cut') dk.clip = null;
  await fmTransfer(v, clip.loc, clip.items, v.loc, dir, clip.op === 'cut');
}

export async function fmUpload(v: FmView, loc: Loc | null, dir: string, fileList: FileList | File[]) {
  const list = [...fileList];
  if (!list.length || !loc) return;
  if (!may(loc, 'w')) return v.say('read-only', true);
  v.busy = 'x';
  for (const f of list) {
    try {
      await putFile(loc, filesJoin(dir, f.name), f, (sent) =>
        v.say(`uploading ${f.name} ${f.size ? Math.round((sent / f.size) * 100) : 100}%`),
      );
    } catch (err) {
      v.say(`${f.name}: ${(err as Error).message}`, true);
    }
  }
  v.busy = '';
  v.say('uploaded');
  fmChanged(loc, dir);
}

// a folder, a place or blank space taking a drag: the computer's own files
// uploaded, a view's moved inside one share or copied (ctrl) across them
export function fmDropZone(v: FmView, node: HTMLElement, where: () => DropTarget | null) {
  fmZones.set(node, { v, where });
  node.dataset.fmDrop = '';
  node.addEventListener('dragover', (e) => {
    const t = where();
    if (!t || (!dk.drag && !e.dataTransfer!.types.includes('Files'))) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer!.dropEffect = dk.drag && fmSame(dk.drag.loc, t.loc) && !e.ctrlKey && !e.altKey ? 'move' : 'copy';
    fmMark(node);
  });
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget as Node | null)) node.classList.remove('drop');
  });
  node.addEventListener('drop', (e) => {
    const t = where();
    node.classList.remove('drop');
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const drag = dk.drag;
    dk.drag = null;
    if (drag) {
      const items = drag.items.filter((it) => !(fmSame(drag.loc, t.loc) && it.rel === t.dir));
      if (items.length)
        fmTransfer(v, drag.loc, items, t.loc, t.dir, fmSame(drag.loc, t.loc) && !e.ctrlKey && !e.altKey);
    } else fmUpload(v, t.loc, t.dir, e.dataTransfer!.files);
  });
}
