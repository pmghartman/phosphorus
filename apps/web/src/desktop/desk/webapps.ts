// the optional apps: each one the mesh wants and this host serves, its page in a window

import type { AppWant } from '@phosphorus/wire';
import { noteAdd } from '../../features/notes.ts';
import { DK_UI, dkGlyph, el } from '../../lib/dom.ts';
import { dk, st } from '../../lib/state.ts';
import { PALETTE_EVENT } from '../../lib/theme.ts';
import { type DkWin, dkFocus, dkNav, dkSize, dkWin, type NavFrame } from '../windows.ts';
import { dkTerminal } from './terminal.ts';
import { dkOpenTerminal } from './windows.ts';

// the apps picked for the mesh that this host has a copy of, each under its mount
export function dkWebApps(): { id: string; mount: string; want: AppWant }[] {
  const wants = st.lastState?.apps || {};
  const mine = st.hostsInfo[st.selfHost]?.apps || {};
  return Object.entries(wants)
    .filter(([id, w]) => w && mine[id]?.version === w.version)
    .map(([id, w]) => ({ id, mount: w.mount || `/${id}/`, want: w }));
}

// --- the bridge: an app's page asking the desktop (@phosphorus/app-sdk/web) ---

// the theme's tokens as this page has them now, for an app's page to wear
function themeNow(): { kind: 'theme'; vars: Record<string, string>; scheme: string } {
  const css = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (let i = 0; i < css.length; i++) {
    const k = css[i]!;
    if (k.startsWith('--')) vars[k] = css.getPropertyValue(k).trim();
  }
  return { kind: 'theme', vars, scheme: document.documentElement.dataset.theme || '' };
}

// the app windows whose page asked for the theme
const themed = new Set<HTMLIFrameElement>();
function sendTheme(f: HTMLIFrameElement) {
  f.contentWindow?.postMessage(themeNow(), location.origin);
}
const retheme = () => {
  for (const f of themed)
    if (f.isConnected) sendTheme(f);
    else themed.delete(f);
};
addEventListener(PALETTE_EVENT, retheme);
new MutationObserver(retheme).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme', 'data-palette', 'data-theme-id', 'style'],
});

function bridge(w: DkWin, frame: HTMLIFrameElement) {
  const on = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
    const a = e.data as Record<string, any> | null;
    if (!a || a.phos !== 1 || typeof a.kind !== 'string') return;
    if (a.kind === 'ready') {
      themed.add(frame);
      sendTheme(frame);
    } else if (a.kind === 'title' && typeof a.title === 'string') {
      const t = w.head.querySelector('.tab-label');
      if (t) t.textContent = a.title.slice(0, 80);
    } else if (a.kind === 'notify' && typeof a.title === 'string') {
      noteAdd(a.title.slice(0, 120), String(a.body ?? '').slice(0, 500));
    } else if (a.kind === 'terminal' && typeof a.host === 'string') {
      if (typeof a.run === 'string' && a.run && dk.creds.has(a.host)) dkTerminal(a.host, a.run.slice(0, 2000));
      else dkOpenTerminal(a.host);
    } else if (a.kind === 'open' && typeof a.id === 'string') {
      const q = a.query && typeof a.query === 'object' ? a.query : undefined;
      dkWebApp(a.id, q);
    }
  };
  addEventListener('message', on);
  return () => {
    removeEventListener('message', on);
    themed.delete(frame);
  };
}

// the app's window, the page's url carrying query when given
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
  const unbridge = bridge(w, frame);
  w.onClose = () => {
    unbridge();
    frame.contentWindow?.location.replace('about:blank');
  };
  dkFocus(w);
  return w;
}
