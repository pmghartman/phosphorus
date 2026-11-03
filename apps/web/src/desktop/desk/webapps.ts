// the optional apps: each one the mesh wants and this host serves, its page in a window

import type { AppWant } from '@phosphorus/wire';
import { appCall } from '../../apps/index.ts';
import { away, noteAdd, notifying, notifyOs } from '../../features/notes.ts';
import { jsonPost } from '../../lib/api.ts';
import { DK_UI, dkGlyph, el, pageAsk } from '../../lib/dom.ts';
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

const extOf = (name: string) => {
  const base = name.split('/').pop()!;
  return base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
};

// the installed app that opens a file so named, by the extensions its catalogue
// entry lists; none and the app that would is offered
export function dkFileApp(name: string): string | undefined {
  const x = extOf(name);
  return x ? dkWebApps().find((a) => a.want.opens?.includes(x))?.id : undefined;
}

// --- a file no installed app opens: the catalogue's app that would, offered ---

type Offer = { id: string; name: string; opens: string[] };
let offers: { at: number; list: Promise<Offer[]> } | null = null;

// the catalogue's apps and what each opens, asked again after ten minutes
function catalogue(): Promise<Offer[]> {
  if (!offers || Date.now() - offers.at > 600000) {
    const list = fetch('/api/apps', { cache: 'no-store', signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((b) =>
        (Array.isArray(b?.apps) ? b.apps : []).map((a: Record<string, unknown>) => ({
          id: String(a.id),
          name: String(a.name).toLowerCase(),
          opens: Array.isArray(a.opens) ? a.opens.map(String) : [],
        })),
      )
      .catch(() => {
        offers = null;
        return [] as Offer[];
      });
    offers = { at: Date.now(), list };
  }
  return offers.list;
}

// a file waiting on its app, opened once this host serves it
let waiting: { id: string; query: Record<string, string>; at: number } | null = null;

// on each change of the apps here (desk/icons.ts)
export function dkOpenWaiting(): void {
  if (!waiting) return;
  if (Date.now() - waiting.at > 30 * 60000) {
    waiting = null;
    return;
  }
  const { id, query } = waiting;
  if (!dkWebApps().some((a) => a.id === id)) return;
  waiting = null;
  dkWebApp(id, query);
}

// the app that would open the file asked about: an admin gets it for every host, the file
// opening once it's here; false when the catalogue has none, download then the file's
export async function dkFileOffer(
  name: string,
  query: Record<string, string>,
  download?: () => void,
): Promise<boolean> {
  const x = extOf(name);
  const app = x ? (await catalogue()).find((a) => a.opens.includes(x)) : undefined;
  if (!app) return false;
  const base = name.split('/').pop()!;
  const coming = !!st.lastState?.apps?.[app.id];
  const get = !coming && !!st.acct?.admin;
  const message = coming
    ? `${app.name} opens .${x} files and is still being installed on ${st.selfHost}; ${base} opens in it once it's here`
    : get
      ? `${app.name} opens .${x} files; get it for every host and ${base} opens in it once it's here`
      : `${app.name} opens .${x} files; an admin gets it for the mesh from the service wizard`;
  const action = coming ? 'open when ready' : get ? `get ${app.name}` : download ? 'download' : 'ok';
  const r = await pageAsk({
    title: `open ${base}`,
    message,
    action,
    cancel: coming || get || !!download,
    alt: (coming || get) && download ? 'download' : undefined,
  });
  if (r === 'alt') download?.();
  else if (r && !coming && !get) download?.();
  else if (r) {
    waiting = { id: app.id, query, at: Date.now() };
    if (get) {
      try {
        const res = await fetch('/api/apps/install', jsonPost({ id: app.id }));
        const out = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(out.error || `status ${res.status}`);
      } catch (e) {
        waiting = null;
        noteAdd(`${app.name} wasn't installed`, (e as Error).message);
        return true;
      }
      // its progress on its page
      appCall('store', true, (m) => m.storeShow(app.id));
    }
    dkOpenWaiting();
  }
  return true;
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
