// navigation: paths, back, the listing loaded
import { type Fm, filesCall, filesParent, fmSame, type Loc } from '../../features/home/home.ts';
import { fmUpload } from './actions.ts';
import { fmRender } from './list.ts';

export function fmGo(fm: Fm, loc: Loc, dir: string, how?: string): void {
  if (how !== 'back' && fm.loc && !(fmSame(fm.loc, loc) && fm.dir === dir)) fm.back.push({ loc: fm.loc, dir: fm.dir });
  const from = fmSame(fm.loc, loc) ? fm.dir : null;
  fm.loc = loc;
  fm.dir = dir;
  fm.sel.clear();
  // up a level: the folder left, picked
  if (from != null && filesParent(from) === dir && from !== dir) {
    fm.sel.add(from.split('/').pop()!);
    fm.anchor = from.split('/').pop()!;
  }
  fm.entries = [];
  fm.renderSide?.();
  fmLoad(fm);
}

export function fmBack(fm: Fm) {
  const at = fm.back.pop();
  if (at) fmGo(fm, at.loc, at.dir, 'back');
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
  if (up) {
    fm.pendingUpload = null;
    fmUpload(fm, fm.loc, fm.dir, up);
  }
}
