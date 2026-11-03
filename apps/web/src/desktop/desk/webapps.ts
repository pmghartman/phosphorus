// the optional apps: each one the mesh wants and this host serves, its page in a window

import type { AppWant } from '@phosphorus/wire';
import { away, noteAdd, notifying, notifyOs } from '../../features/notes.ts';
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

// the installed app that opens a file so named, by the extensions its catalogue
// entry lists; none and the file downloads
export function dkFileApp(name: string): string | undefined {
  const base = name.split('/').pop()!;
  const x = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  return x ? dkWebApps().find((a) => a.want.opens?.includes(x))?.id : undefined;
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

// the app windows whose page asked for the theme, and those taking opens while up
const themed = new Set<HTMLIFrameElement>();
const opening = new WeakSet<HTMLIFrameElement>();
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
    } else if (a.kind === 'opens') {
      opening.add(frame);
    } else if (a.kind === 'title' && typeof a.title === 'string') {
      for (const t of [w.head.querySelector('.tab-label'), w.task.querySelector('.dk-task-t')])
        if (t) t.textContent = a.title.slice(0, 80);
    } else if (a.kind === 'unsaved') {
      w.node.classList.toggle('dirty', a.on === true);
    } else if (a.kind === 'notify' && typeof a.title === 'string') {
      const [t, b] = [a.title.slice(0, 120), String(a.body ?? '').slice(0, 500)];
      noteAdd(t, b);
      // the browser's own while the tab is away, once its bell is on
      if (away() && notifying()) notifyOs(t, b);
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

// the app's window, the page's url carrying query when given; a window already
// up handed the query, or loaded anew with it when its page doesn't take opens
export function dkWebApp(id: string, query?: Record<string, string>): DkWin | undefined {
  const a = dkWebApps().find((x) => x.id === id);
  if (!a) return;
  const up = dk.wins.get(`webapp:${id}`);
  if (up && query && up.frame) {
    const f = up.frame as HTMLIFrameElement;
    if (opening.has(f)) f.contentWindow?.postMessage({ kind: 'open', query }, location.origin);
    else if (!up.holdClose?.()) {
      up.node.classList.remove('dirty');
      f.src = `${a.mount}?${new URLSearchParams(query)}`;
    }
    dkFocus(up);
    return up;
  }
  const w = dkWin(`webapp:${id}`, id, `v${a.want.version}`, 'svc dk-webapp');
  if (!w) return;
  const pop = Object.assign(el('button', 'dk-out'), {
    type: 'button',
    title: 'open in a browser tab',
    ariaLabel: 'open in a browser tab',
  });
  pop.appendChild(dkGlyph(DK_UI.pop!));
  // where the page is now, the file it shows with it
  pop.addEventListener('click', () => {
    let at = a.mount;
    try {
      at = frame.contentWindow?.location.href || at;
    } catch {}
    window.open(at, '_blank', 'noopener');
  });
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
  // unsaved changes asked about first
  w.holdClose = () =>
    w.node.classList.contains('dirty') &&
    !confirm(
      `${(w.head.querySelector('.tab-label')?.textContent || id).replace(/ •$/, '')} has unsaved changes. Close without saving?`,
    );
  const unbridge = bridge(w, frame);
  w.onClose = () => {
    unbridge();
    frame.contentWindow?.location.replace('about:blank');
  };
  dkFocus(w);
  return w;
}
