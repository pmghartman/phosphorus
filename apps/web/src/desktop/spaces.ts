// desktops: the shared one, phosphorus's own with the apps added to it from any host, and one
// per logged in host, the same desktop over that host's wallpaper with its apps, its whole
// file system and terminals on that computer alone

import { app } from '../apps/index.ts';
import { dkUnlock } from '../features/account.ts';
import { deskLoc, deskRel, fileOpen, filesWin } from '../features/home/home.ts';
import { acctCall } from '../lib/api.ts';
import { DK_GLYPHS } from '../lib/dom.ts';
import { dk, PREF_LS } from '../lib/state.ts';
import { newSid } from '../lib/util.ts';
import { hostApp } from './desk/hostapp.ts';
import { api, hostInfo, hostLoad, hostWarm, type Item, itemKey } from './desk/hosts.ts';
import { dkIcons, dkLiveHosts } from './desk/icons.ts';
import { siteOf } from './desk/sites.ts';
import { osGlyph, osOf } from './desk/terminal.ts';
import { dkSay, dkWallPaint } from './desk/wallpaper.ts';
import { dkView } from './desk.ts';
import { dkChips, dkPopsClose } from './taskbar.ts';
import { type DkWin, dkFocus, dkStack, dkWin } from './windows.ts';

const SPACE_KEY = 'phosphorus-space';

// the desktop a window belongs to, '' the shared one
export const spaceOf = (w: DkWin) => w.space ?? '';
export const spaceName = (h = dk.space) => h || 'phosphorus';
export const spaceGlyph = (h = dk.space) => (h ? osGlyph(osOf(h) || hostInfo(h).desk?.os || '') : DK_GLYPHS.phi!);

// a window shown on its own desktop alone, its task with it
export function spaceShow(w: DkWin) {
  const away = spaceOf(w) !== dk.space;
  w.node.classList.toggle('dk-away', away);
  w.task.classList.toggle('dk-away', away);
}

const changed = new Set<() => void>();
// told whenever the desktop or what a host says changes
export const onSpace = (f: () => void) => void changed.add(f);
const tell = () => {
  for (const f of changed) f();
};

// onto a desktop: its windows, icons and wallpaper; a host not logged into asked for a login first
export function dkSpace(h: string, from?: HTMLElement | null): void {
  if (h && !dk.creds.has(h)) {
    if (from) dkUnlock(h, from, () => dkSpace(h));
    else dkSay(`log in to ${h} first`);
    return;
  }
  dk.space = h;
  try {
    localStorage.setItem(SPACE_KEY, h);
  } catch {}
  if (!dk.desk) return;
  dkPopsClose();
  dkView.classList.toggle('dk-hostspace', !!h);
  for (const w of dk.wins.values()) spaceShow(w);
  dkWallPaint();
  dkIcons();
  dk.chips = '';
  dkChips();
  dkFocus(dkStack()[0] ?? null);
  tell();
  if (h)
    void hostLoad(h, () => {
      const i = hostInfo(h);
      if (i.error && !i.desk) dkSay(`${h}: ${i.error}`);
      if (dk.space !== h) return;
      dkWallPaint();
      dkIcons();
      tell();
    });
}

// the desktop this browser was last on, once the desk is up and the host still logged into
export function dkSpaceBoot() {
  let h = '';
  try {
    h = localStorage.getItem(SPACE_KEY) ?? '';
  } catch {}
  const m = /^#desk=([a-z0-9][a-z0-9-]*)/.exec(location.hash);
  if (m) {
    h = m[1]!;
    history.replaceState(null, '', location.pathname + location.search);
  }
  dkSpace(h && dk.creds.has(h) ? h : '');
  // every logged in host's ssh session opened and its last desk read while the page is idle,
  // so the first switch onto one finds it up
  (window.requestIdleCallback ?? setTimeout)(() => {
    for (const host of dkLiveHosts()) void hostWarm(host);
  });
}

// the next or last desktop: the shared one, then each logged in host
export function dkSpaceStep(by: number) {
  const list = ['', ...dkLiveHosts()];
  const i = Math.max(0, list.indexOf(dk.space));
  dkSpace(list[(i + by + list.length) % list.length]!);
}

// a host logged out of or gone: its desktop left for the shared one
export function dkSpaceGone() {
  if (dk.space && !dkLiveHosts().includes(dk.space)) dkSpace('');
}

// a host's whole file system in the files app, at a folder when given
export const hostFiles = (h: string, abs = '') => filesWin({ loc: deskLoc(h), dir: abs ? deskRel(abs) : '' });

// --- terminals on a host's desktop: each its own window, a session on that host alone -----

export function hostTerm(h: string, run = ''): DkWin | undefined {
  const c = dk.creds.get(h);
  if (!c || !dk.desk) return;
  const w = dkWin(null, 'terminal', h, 'term');
  if (!w) return;
  const pane = Object.assign(document.createElement('div'), { className: 'dk-tpane' });
  w.body.append(pane);
  const term = app('terminal').then((m) =>
    m.startTerminal(pane, h, newSid(), false, false, { ...c, run }, { themeFrom: w.body, onEnd: () => {} }),
  );
  w.onFocus = () => void term.then((t) => t.focus());
  w.onClose = () => void term.then((t) => t.close());
  void term.then((t) => t.show());
  dkFocus(w);
  return w;
}

// --- a host's apps: phosphorus's own where it has one, the rest streamed with afterglow -----

const filesName = /^(file explorer|explorer|files|nautilus|dolphin|thunar|nemo|pcmanfm|caja|this pc)$/i;
const filesPath = /(\\explorer\.exe|nautilus|dolphin|thunar|nemo|pcmanfm|caja)[^\\/]*$/i;
const termName =
  /^(terminal|windows terminal|(windows )?powershell( \d.*)?|pwsh|command prompt|cmd|console|konsole|xterm|alacritty|kitty|tilix|wezterm|gnome terminal|xfce terminal)$/i;
const termPath =
  /(\\(wt|powershell|pwsh|cmd)\.exe|gnome-terminal|org\.gnome\.(console|terminal)|konsole|xterm|alacritty|kitty|tilix|xfce4-terminal|kgx)[^\\/]*$/i;

// a desk icon's host app, for its right click
export const hostIcons = new WeakMap<Element, { host: string; it: Item }>();

// phosphorus's own app a host's app opens as, '' for none
export function inHouse(it: Item): 'files' | 'terminal' | '' {
  if (it.kind === 'folder') return 'files';
  if (it.kind === 'cli') return 'terminal';
  const p = it.path ?? '';
  if (filesName.test(it.name) || filesPath.test(p)) return 'files';
  if (termName.test(it.name) || termPath.test(p)) return 'terminal';
  return '';
}

export function openHostItem(h: string, it: Item) {
  if (it.kind === 'folder') return void hostFiles(h, it.path);
  if (it.kind === 'file' && it.path) return fileOpen(deskLoc(h), deskRel(it.path), {});
  if (it.kind === 'web' && it.url) return void window.open(it.url, '_blank', 'noopener');
  if (it.kind === 'bin') return void hostFiles(h);
  const own = inHouse(it);
  if (own === 'files') return void hostFiles(h);
  if (own === 'terminal') return void hostTerm(h, it.kind === 'cli' ? (it.run ?? '') : '');
  const site = siteOf(it);
  if (site) return void window.open(site.url, '_blank', 'noopener');
  if (it.path) return hostApp(h, it);
  dkSay(`${it.name} has nothing to start it by`);
}

// a shortcut or program on a host's disk, followed as that host's own desktop would
export async function deskLaunch(h: string, path: string) {
  const r = await acctCall<{ item: Item }>(api(h, 'open'), { path });
  if (!r.ok || !r.item) return dkSay(r.error || `${path} didn't open`);
  openHostItem(h, r.item);
}

// the tip an app's icon wears: what opens it
export const itemTip = (h: string, it: Item) => {
  const own = inHouse(it);
  if (own) return `${it.name}: opens phosphorus ${own} on ${h}`;
  const site = siteOf(it);
  return site ? `${it.name}: opens ${new URL(site.url).host} in a new tab` : `${it.name} on ${h}`;
};

// a site app's menu entry for the host's own copy, streamed
export const streamPick = (h: string, it: Item): [string, () => void, boolean][] =>
  siteOf(it) && (it.path || it.id) ? [[`open from ${h}`, () => hostApp(h, it), true]] : [];

// --- the shared desktop's apps: any host's, added from its desktop or the apps menu -------

export type Shared = Item & { host: string };

export function sharedApps(): Shared[] {
  try {
    const v = JSON.parse(localStorage.getItem(PREF_LS.shared!) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => x && typeof x.host === 'string' && typeof x.name === 'string') : [];
  } catch {
    return [];
  }
}

export const isShared = (h: string, it: Item) => sharedApps().some((s) => s.host === h && itemKey(s) === itemKey(it));

export function setShared(h: string, it: Item, on: boolean) {
  const rest = sharedApps().filter((s) => !(s.host === h && itemKey(s) === itemKey(it)));
  const { name, kind, path, icon, iv, run, url } = it;
  const next = on ? [...rest, { host: h, name, kind, path, icon, iv, run, url }] : rest;
  try {
    if (next.length) localStorage.setItem(PREF_LS.shared!, JSON.stringify(next));
    else localStorage.removeItem(PREF_LS.shared!);
  } catch {}
  dkSay(on ? `${it.name} added to the shared desktop` : `${it.name} taken off the shared desktop`);
  dkIcons();
  tell();
}
