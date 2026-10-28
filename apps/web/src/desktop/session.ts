// the session: every window's place kept per user in this browser, put back on the
// next visit once its host, route or login is there

import { app } from '../apps/index.ts';
import { dkProfileWin, dkUsersWin } from '../features/account.ts';
import { dkFms, filesWin, type Loc } from '../features/home/home.ts';
import { dk, st } from '../lib/state.ts';
import { dkAppearanceWin } from './control.ts';
import { dkOpenApp, dkService, dkTerminal } from './desk.ts';
import { dkCode, dkRun } from './deskfiles.ts';
import { type DkWin, dkFocus, dkHide, dkOnTouch, dkPlace, dkSnap } from './windows.ts';

interface Saved {
  open: Record<string, any>;
  x: number;
  y: number;
  w: number;
  h: number;
  snap: string;
  min: boolean;
  z: number;
}
interface Session {
  wins: Saved[];
}

const KEY = () => (st.acct && !st.acct.boot ? `phosphorus-dk-session:${st.acct.user}` : '');
let timer: ReturnType<typeof setTimeout> | null = null;
// saving held while the desk goes down or a session is put back
let hold = false;
let pending: Saved[] = [];

// what opens a window again, from its key and kind; null for one that can't come back
function openerOf(w: DkWin): Record<string, any> | null {
  const k = w.key;
  if (k.startsWith('app:')) return { t: 'app', id: k.slice(4) };
  if (k.startsWith('svc:')) {
    const [host, name] = k.slice(4).split('::');
    return { t: 'svc', host, name };
  }
  if (w.kind === 'term' && w.host) return { t: 'term', host: w.host };
  if (k.startsWith('view:edit\n')) {
    const [, host, share, path] = k.split('\n');
    return { t: 'edit', host, share, path };
  }
  if (k.startsWith('view:')) {
    const [host, share, rel] = k.slice(5).split('\n');
    return { t: 'view', host, share, rel };
  }
  if (k.startsWith('run:')) {
    const [host, share, rel] = k.slice(4).split('\n');
    return { t: 'run', host, share, rel };
  }
  if (w.kind === 'fm') {
    const fm = [...dkFms].find((f) => f.w === w);
    return fm?.loc ? { t: 'fm', loc: fm.loc, dir: fm.dir } : null;
  }
  return null;
}

function save() {
  timer = null;
  const key = KEY();
  if (!key || hold || !dk.desk) return;
  const wins: Saved[] = [];
  for (const w of dk.wins.values()) {
    const open = openerOf(w);
    if (open)
      wins.push({
        open,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
        snap: w.snap,
        min: !!w.node.hidden,
        z: Number(w.node.style.zIndex) || 0,
      });
  }
  // what's still waiting to come back kept, never dropped by an early save
  wins.push(...pending);
  const s: Session = { wins };
  try {
    localStorage.setItem(key, JSON.stringify(s));
  } catch {}
}

dkOnTouch(() => {
  if (!timer) timer = setTimeout(save, 400);
});

export function dkSessionHold(on: boolean): void {
  hold = on;
}

// one saved window opened, undefined while what it needs isn't here yet
async function reopen(s: Saved): Promise<DkWin | undefined | null> {
  const o = s.open;
  const was = new Set(dk.wins.keys());
  const fresh = () => [...dk.wins.values()].find((w) => !was.has(w.key));
  switch (o.t) {
    case 'app': {
      const id = String(o.id);
      if (id === 'profile') dkProfileWin();
      else if (id === 'users') {
        if (!st.acct?.admin) return null;
        dkUsersWin();
      } else if (id === 'appearance') dkAppearanceWin();
      else if (id === 'git') {
        if (!st.gitRoute) return undefined;
        dkOpenApp('git');
      } else dkOpenApp(id);
      return dk.wins.get(`app:${id}`) ?? null;
    }
    case 'svc': {
      const r = dk.services.find((x) => x.host === o.host && x.name === o.name);
      if (!r) return undefined;
      return dkService(r) ?? null;
    }
    case 'term':
      if (!dk.creds.has(String(o.host))) return st.terminalHosts.includes(String(o.host)) ? undefined : null;
      return dkTerminal(String(o.host)) ?? null;
    case 'edit':
      await dkCode({ host: String(o.host), share: String(o.share), path: String(o.path) });
      return fresh() ?? null;
    case 'view':
      await app('files').then((m) => m.dkViewer({ host: String(o.host), share: String(o.share) }, String(o.rel)));
      return fresh() ?? null;
    case 'run':
      await dkRun({ host: String(o.host), share: String(o.share) }, String(o.rel));
      return fresh() ?? null;
    case 'fm': {
      const fm = await filesWin({ loc: o.loc as Loc, dir: String(o.dir) });
      return fm?.w ?? null;
    }
  }
  return null;
}

// the geometry a window had put back on it
function place(w: DkWin, s: Saved) {
  Object.assign(w, { x: s.x, y: s.y, w: s.w, h: s.h });
  dkPlace(w);
  if (s.snap) dkSnap(w, s.snap);
  if (s.min) dkHide(w);
}

let trying = false;
// each waiting window tried again: a route, host or login may have come
export async function dkSessionTry(): Promise<void> {
  if (!pending.length || trying || !dk.desk) return;
  trying = true;
  hold = true;
  try {
    const left: Saved[] = [];
    for (const s of pending) {
      let w: DkWin | undefined | null;
      try {
        w = await reopen(s);
      } catch {
        w = null;
      }
      if (w === undefined) {
        left.push(s);
        continue;
      }
      if (w) place(w, s);
    }
    pending = left;
  } finally {
    hold = false;
    trying = false;
    save();
  }
}

// the desk just up: its last session read, the windows tried
export function dkSessionRestore(): void {
  const key = KEY();
  pending = [];
  if (!key) return;
  let s: Session | null = null;
  try {
    s = JSON.parse(localStorage.getItem(key) || 'null');
  } catch {}
  if (!s || !Array.isArray(s.wins)) return;
  pending = s.wins.filter((x) => x && typeof x === 'object' && x.open).sort((a, b) => a.z - b.z);
  dkSessionTry().then(() => {
    const top = [...dk.wins.values()]
      .filter((w) => !w.node.hidden)
      .sort((a, b) => Number(b.node.style.zIndex) - Number(a.node.style.zIndex))[0];
    if (top) dkFocus(top);
  });
}
