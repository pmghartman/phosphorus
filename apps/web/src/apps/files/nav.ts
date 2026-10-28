// navigation: paths, history, the listing loaded
import { filesCall, filesParent, fmSame, type Fm, type Loc } from '../../features/home/home.ts';
import { fmUpload } from './actions.ts';
import { fmRender } from './list.ts';

export function fmGo(fm: Fm, loc: Loc, dir: string, how?: string): void {
  if (how !== 'history' && fm.loc) { fm.back.push({ loc: fm.loc, dir: fm.dir }); fm.fwd = []; }
  const from = fmSame(fm.loc, loc) ? fm.dir : null;
  fm.loc = loc;
  fm.dir = dir;
  fm.sel.clear();
  fm.find.value = '';
  fm.filter = '';
  // back up a level: the folder left, picked
  if (from != null && filesParent(from) === dir && from !== dir) { fm.sel.add(from.split('/').pop()!); fm.anchor = from.split('/').pop()!; }
  fm.entries = [];
  fm.renderSide?.();
  fmLoad(fm);
}

export function fmHistory(fm: Fm, step: number) {
  const from = step < 0 ? fm.back : fm.fwd;
  const to = step < 0 ? fm.fwd : fm.back;
  const at = from.pop();
  if (!at) return;
  to.push({ loc: fm.loc!, dir: fm.dir });
  fmGo(fm, at.loc, at.dir, 'history');
}

export const fmUp = (fm: Fm) => fm.loc && fm.dir && fmGo(fm, fm.loc, filesParent(fm.dir));

export async function fmLoad(fm: Fm): Promise<void> {
  if (!fm.loc) return fmRender(fm);
  const want = `${fm.loc.host}\n${fm.loc.share}\n${fm.dir}`;
  fm.loading = want;
  fmRender(fm);
  try {
    const body = await filesCall(fm.loc, 'list', undefined, { path: fm.dir });
    if (fm.loading !== want) return;
    fm.entries = body.entries;
    fm.error = body.truncated ? 'truncated' : '';
  } catch (err) {
    if (fm.loading !== want) return;
    fm.entries = [];
    fm.error = (err as Error).message;
  }
  fm.loading = '';
  fmRender(fm);
  // files added from the desktop, into the first folder shown
  const up = fm.pendingUpload;
  if (up) { fm.pendingUpload = null; fmUpload(fm, fm.loc, fm.dir, up); }
}
