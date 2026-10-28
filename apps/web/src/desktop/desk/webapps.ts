// the optional apps: each one the mesh wants and this host serves, its page in a window

import type { AppWant } from '@phosphorus/wire';
import { DK_UI, dkGlyph, el } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { type FileRef } from '../deskfiles.ts';
import { type DkWin, dkFocus, dkNav, dkSize, dkWin, type NavFrame } from '../windows.ts';

// the apps picked for the mesh that this host has a copy of, each served under /<id>/
export function dkWebApps(): { id: string; mount: string; want: AppWant }[] {
  const wants = st.lastState?.apps || {};
  const mine = st.hostsInfo[st.selfHost]?.apps || {};
  return Object.entries(wants)
    .filter(([id, w]) => w && mine[id]?.version === w.version)
    .map(([id, w]) => ({ id, mount: `/${id}/`, want: w }));
}

// the app's window, the page's url carrying query when given (a file for sulfur to open)
export function dkWebApp(id: string, query?: Record<string, string>): DkWin | undefined {
  const a = dkWebApps().find((x) => x.id === id);
  if (!a) return;
  const w = dkWin(`webapp:${id}`, id, `v${a.want.version}`, 'svc dk-webapp');
  if (!w) return;
  const pop = Object.assign(el('button', 'dk-out'), {
    type: 'button',
    title: 'open in a browser tab',
    ariaLabel: 'open in a browser tab',
  });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  pop.addEventListener('click', () => window.open(a.mount, '_blank', 'noopener'));
  w.head.querySelector('.dk-btns')!.prepend(pop);
  const src = query ? `${a.mount}?${new URLSearchParams(query)}` : a.mount;
  const frame: NavFrame = Object.assign(el('iframe', 'dk-frame'), {
    src,
    title: id,
    allow: 'clipboard-read; clipboard-write; fullscreen',
  });
  w.frame = frame;
  w.body.appendChild(frame);
  dkNav(w, frame);
  dkSize(w, 1100, 680);
  w.onFocus = () => frame.contentWindow?.focus();
  w.onClose = () => {
    frame.contentWindow?.location.replace('about:blank');
  };
  dkFocus(w);
  return w;
}

// a file opened in sulfur: its window made on the file, or the one up told of it; false when
// this host doesn't serve sulfur
export function dkSulfurOpen(f: FileRef): boolean {
  if (!dkWebApps().some((a) => a.id === 'sulfur')) return false;
  const o = { host: f.host, share: String(f.share || 'home'), path: f.path };
  const w = dk.wins.get('webapp:sulfur');
  if (w?.frame) {
    w.frame.contentWindow?.postMessage({ t: 'sulfur-open', ...o }, location.origin);
    dkFocus(w);
    return true;
  }
  return !!dkWebApp('sulfur', o);
}
