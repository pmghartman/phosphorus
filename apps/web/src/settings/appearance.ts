// --- settings › appearance: light, dark or black; the wallpaper, a picture of the user's kept on
// the mesh; how services open

import { dkPick, dkWallPaint, servicesInTabs, WALL_EVENT } from '../desktop/desk/wallpaper.ts';
import { dkSay } from '../desktop/desk.ts';
import { acctCall } from '../lib/api.ts';
import { el } from '../lib/dom.ts';
import { MODES, modeIcon, modePick, setTheme } from '../lib/scheme.ts';
import { PREF_LS, st } from '../lib/state.ts';
import { cardify } from './settings.ts';

// --- the wallpaper ------------------------------------------------------------------------------

export const DK_WALL_MAX = 2560;

// shrunk to the screen's size at most, a jpeg; '' once set, else why not
export async function dkWallSet(blob: Blob): Promise<string> {
  let url;
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, DK_WALL_MAX / Math.max(bmp.width, bmp.height));
    const c = Object.assign(document.createElement('canvas'), {
      width: Math.round(bmp.width * k),
      height: Math.round(bmp.height * k),
    });
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    url = c.toDataURL('image/jpeg', 0.85);
  } catch {
    return 'not an image';
  }
  const r = await acctCall('/api/me/wallpaper', { data: url });
  if (!r.ok) return r.error || 'not saved';
  st.acct!.wallpaper = r.wallpaper;
  dkWallPaint();
  return '';
}

export async function dkWallClear(): Promise<void> {
  const r = await acctCall('/api/me/wallpaper', { data: '' });
  if (!r.ok) return;
  st.acct!.wallpaper = 0;
  dkWallPaint();
}

// a picture picked for the wallpaper
export const dkWallPick = (): void => dkPick('image/*', false, ([f]) => dkWallSet(f!).then((why) => why && dkSay(why)));

// --- the section ---------------------------------------------------------------------------------

export function appearanceSection(pane: HTMLElement): () => void {
  const body = el('div', 'set-sub');
  pane.append(body);

  const head = (t: string) => el('div', 'dk-ap-head', t);
  const note = (t: string) => el('p', 'dk-note', t);
  const row = (label: string, ctl: HTMLElement) => {
    const r = el('div', 'dk-ap-row');
    r.append(el('span', 'dk-ap-k', label), ctl);
    return r;
  };
  const check = (k: string, label: string, on: boolean, set: (on: boolean) => void, sub?: string) => {
    const r = el('label', 'dk-ap-check');
    const inp = Object.assign(el('input'), { type: 'checkbox', checked: on });
    inp.dataset.k = k;
    inp.addEventListener('change', () => set(inp.checked));
    r.append(inp, el('span', 'dk-ap-check-t', label));
    if (sub) r.append(el('span', 'dk-ap-note', sub));
    return r;
  };
  const btn = (label: string, act: () => void, cls = '') => {
    const b = Object.assign(el('button', `btn dk-ap-btn${cls ? ` ${cls}` : ''}`, label), { type: 'button' });
    b.addEventListener('click', act);
    return b;
  };
  const acts = (...kids: HTMLElement[]) => {
    const d = el('div', 'dk-ap-acts');
    d.append(...kids);
    return d;
  };

  const draw = () => {
    const focus = (document.activeElement as HTMLElement | null)?.dataset.k;
    const modes = el('div', 'dk-ap-segs');
    for (const m of MODES) {
      const b = Object.assign(el('button', `dk-ap-seg${modePick() === m ? ' on' : ''}`), { type: 'button' });
      b.dataset.k = `mode:${m}`;
      b.append(modeIcon(m), m);
      b.addEventListener('click', () => {
        setTheme(m);
        draw();
      });
      modes.append(b);
    }
    const acct = st.acct;
    const can = !!acct && !acct.boot;
    const wall = acts(
      el('span', 'dk-ap-state', acct?.wallpaper ? 'a picture of yours' : 'plain'),
      btn('change…', dkWallPick),
      ...(acct?.wallpaper
        ? [
            btn(
              'remove',
              () => {
                void dkWallClear();
              },
              'danger',
            ),
          ]
        : []),
    );
    body.replaceChildren(
      ...cardify([
        head('light or dark'),
        modes,
        note('system follows the browser; black is for oled screens'),
        head('wallpaper'),
        can ? row('picture', wall) : note('log in to keep a wallpaper'),
        head('windows'),
        check(
          'svctab',
          'open services in a browser tab',
          servicesInTabs(),
          (on) => {
            try {
              if (on) localStorage.setItem(PREF_LS.svctab!, '1');
              else localStorage.removeItem(PREF_LS.svctab!);
            } catch {}
          },
          'pages like jellyfin or forgejo; code, files and the other desktop apps still open in a window',
        ),
      ]),
    );
    if (focus) pane.querySelector<HTMLElement>(`[data-k="${CSS.escape(focus)}"]`)?.focus();
  };
  addEventListener(WALL_EVENT, draw);
  draw();
  return () => removeEventListener(WALL_EVENT, draw);
}
