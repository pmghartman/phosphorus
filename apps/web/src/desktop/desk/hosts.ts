// a logged in host as phosphorus knows it over the viewer's own ssh login: its wallpaper,
// home, desktop shortcuts and every app it has, kept in this browser for a first paint

import { acctCall } from '../../lib/api.ts';
import { iconsPrune, iconsWarm, iconUrl } from '../../lib/iconcache.ts';

export type Kind = 'file' | 'folder' | 'cli' | 'web' | 'gui' | 'bin';
export interface Item {
  name: string;
  kind: Kind;
  path?: string;
  // the desk's own file where path is what it names (a shortcut's target): what a delete takes
  file?: string;
  icon?: string;
  iv?: string;
  run?: string;
  url?: string;
  group?: string;
  id?: string;
}
export interface Desk {
  os: 'windows' | 'linux';
  shell: string;
  user: string;
  home: string;
  wallpaper: { path: string; fit: string; color: string; iv: string };
  icons: Item[];
  pins: Item[];
}
// what a host last said, its error while it refuses
export interface HostInfo {
  desk?: Desk;
  apps: Item[];
  error?: string;
}

export const api = (h: string, op: string, q: Record<string, string> = {}) =>
  `/api/hostdesk/${encodeURIComponent(h)}/${op}${Object.keys(q).length ? `?${new URLSearchParams(q)}` : ''}`;

// an icon's source: the blob already in this page, else the server's copy
export const iconSrc = (host: string, it: Item) =>
  it.icon ? (iconUrl(host, it) ?? api(host, 'icon', { k: it.icon, v: it.iv ?? '' })) : '';

export const wallSrc = (host: string, d: Desk) =>
  d.wallpaper.path ? api(host, 'wallpaper', { v: d.wallpaper.iv || d.wallpaper.path }) : '';

const lsKey = (h: string) => `phosphorus-desk:${h}`;
const known = new Map<string, HostInfo>();

// what's known of a host: this page's last answer, else this browser's
export function hostInfo(h: string): HostInfo {
  let i = known.get(h);
  if (!i) {
    i = { apps: [] };
    try {
      const v = JSON.parse(localStorage.getItem(lsKey(h)) ?? 'null');
      if (v?.desk) Object.assign(i, { desk: v.desk, apps: v.apps ?? [] });
    } catch {}
    known.set(h, i);
  }
  return i;
}

function keep(h: string, i: HostInfo) {
  try {
    localStorage.setItem(lsKey(h), JSON.stringify({ desk: i.desk, apps: i.apps }));
  } catch {}
}

const asking = new Map<string, Promise<void>>();
// the hosts whose live desk this page has read
const fresh = new Set<string>();
const walls = new Map<string, HTMLImageElement>();

// a desk's icons and wallpaper fetched into this page, so a switch paints them with no gap
function deskWarm(h: string, d: Desk) {
  void iconsWarm(h, [...d.icons, ...d.pins]);
  const src = wallSrc(h, d);
  if (!src || walls.get(h)?.src.endsWith(src)) return;
  const im = new Image();
  im.src = src;
  walls.set(h, im);
  im.decode().catch(() => {});
}

// the host asked again: the cached desk, the live one, then its apps, changed called after each;
// each desk's icons fetched as it lands, the apps' after, their store trimmed to them
export function hostLoad(h: string, changed: () => void): Promise<void> {
  const had = asking.get(h);
  if (had) return had.then(changed);
  const i = hostInfo(h);
  const go = (async () => {
    const live = acctCall<{ desk: Desk }>(api(h, 'desktop'));
    const c = await acctCall<{ desk?: Desk; apps?: Item[] }>(api(h, 'desktop', { cached: '1' }));
    if (!c.ok) {
      i.error = c.error || `${h} didn't answer`;
      return changed();
    }
    if (c.desk && !i.desk) {
      i.desk = c.desk;
      if (c.apps?.length) i.apps = c.apps;
      changed();
    }
    if (i.desk) deskWarm(h, i.desk);
    const r = await live;
    if (!r.ok || !r.desk) {
      i.error = r.error || `${h} didn't answer`;
      return changed();
    }
    i.error = undefined;
    i.desk = r.desk;
    fresh.add(h);
    keep(h, i);
    changed();
    deskWarm(h, r.desk);
    const a = await acctCall<{ apps: Item[] }>(api(h, 'apps'));
    if (a.ok && a.apps) {
      i.apps = a.apps;
      keep(h, i);
      changed();
      await iconsWarm(h, a.apps, true);
      void iconsPrune(h, [...r.desk.icons, ...r.desk.pins, ...a.apps]);
    }
  })().finally(() => asking.delete(h));
  asking.set(h, go);
  return go;
}

const warmed = new Set<string>();

// a host read ahead of a first switch: its cached desk asked for, which has the server open
// the ssh session, then its live desk, apps and every icon fetched in the background; once a
// page, true when the cached desk was one this browser hadn't seen
export async function hostWarm(h: string): Promise<boolean> {
  if (warmed.has(h)) return false;
  warmed.add(h);
  // a switch onto it already reading it, or has: nothing more to ask
  if (fresh.has(h) || asking.has(h)) return false;
  const i = hostInfo(h);
  if (i.desk) {
    deskWarm(h, i.desk);
    void hostLoad(h, () => {});
    return false;
  }
  const c = await acctCall<{ desk?: Desk; apps?: Item[] }>(api(h, 'desktop', { cached: '1' }));
  if (c.ok && c.desk && !i.desk) {
    i.desk = c.desk;
    if (c.apps?.length) i.apps = c.apps;
    keep(h, i);
  }
  if (!fresh.has(h)) void hostLoad(h, () => {});
  return c.ok && !!c.desk;
}

// a host's app as one name everywhere: its path, else its command, else its name
export const itemKey = (it: Item) => it.path || it.run || it.url || it.name;
