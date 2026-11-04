// --- settings › appearance: light or dark, the theme, the desk, the bar and the windows; and the
// wallpaper, a picture of the user's kept on the mesh

import { dkPick, dkWallPaint, servicesInTabs, WALL_EVENT } from '../desktop/desk/wallpaper.ts';
import { dkSay } from '../desktop/desk.ts';
import { acctCall } from '../lib/api.ts';
import { DK_UI, dkGlyph, el } from '../lib/dom.ts';
import { MODES, modeIcon, modePick, setTheme } from '../lib/scheme.ts';
import { PREF_LS, st } from '../lib/state.ts';
import {
  BAR_ITEMS,
  CUSTOM_CORNERS,
  CUSTOM_SHADOWS,
  type CustomConfig,
  customNow,
  LAYOUT_CHOICES,
  type LayoutNow,
  PALETTE_EVENT,
  PALETTES,
  paletteNow,
  setCustom,
  setPalette,
  themeConfig,
} from '../lib/theme.ts';
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

export type ApSub = 'theme' | 'desktop' | 'bar' | 'windows';
export const AP_SUBS: readonly ApSub[] = ['theme', 'desktop', 'bar', 'windows'];

// the layout's choices by name
const LAYOUT_NAMES: Record<string, string> = {
  bottom: 'bottom',
  top: 'top',
  left: 'left',
  right: 'right',
  panel: 'floating panel',
  dock: 'dock',
  full: 'edge to edge',
  line: 'status line',
  glyphs: 'glyphs',
  lights: 'traffic lights',
  caption: 'caption buttons',
  center: 'centered',
  normal: 'normal',
  compact: 'compact',
  roomy: 'roomy',
  both: 'icons and titles',
  icons: 'icons only',
  titles: 'titles only',
};
// the bar's status items by name
const ITEM_NAMES: Record<string, string> = {
  hosts: 'hosts',
  mesh: 'mesh',
  update: 'update',
  agent: 'agent',
  bell: 'notifications',
  clock: 'clock',
  profile: 'profile',
};

// a swatch: an accent over its ground
function swatch(accent: string, bg: string): HTMLElement {
  const sw = el('span', 'dk-ap-swatch');
  sw.style.background = `linear-gradient(135deg, ${accent} 50%, ${bg} 50%)`;
  return sw;
}

let sub: ApSub = 'theme';
// the part shown, its submenu marked in the settings rail
export const appearanceSub = (): ApSub => sub;

// Every control shows what is worn: a built-in theme's own values, or the custom theme's. Changing
// one makes the custom theme, based on the theme worn, and wears it at once; it is kept with the
// user's settings on every host
export function appearanceSection(pane: HTMLElement, at?: ApSub): () => void {
  if (at && AP_SUBS.includes(at)) sub = at;
  const body = el('div', 'set-sub');
  pane.append(body);

  const shown = (): CustomConfig => (paletteNow() === 'custom' ? customNow() : themeConfig(paletteNow()));
  // quiet while a color is dragged: the page follows, the controls stay put until it is let go
  let quiet = false;
  const change = (fn: (c: CustomConfig) => void, redraw = true) => {
    const c = shown();
    fn(c);
    quiet = !redraw;
    setCustom(c);
    quiet = false;
  };
  const lay = (fn: (l: LayoutNow) => void) =>
    change((c) => {
      fn(c.layout);
    });

  const head = (t: string) => el('div', 'dk-ap-head', t);
  const note = (t: string) => el('p', 'dk-note', t);
  const row = (label: string, ctl: HTMLElement, sub?: string) => {
    const r = el('div', 'dk-ap-row');
    r.append(el('span', 'dk-ap-k', label), ctl);
    if (sub) r.append(el('span', 'dk-ap-note', sub));
    return r;
  };
  const select = (k: string, choices: [string, string][], now: string, set: (v: string) => void) => {
    const s = el('select', 'dk-ap-in');
    s.dataset.k = k;
    for (const [v, label] of choices)
      s.append(Object.assign(el('option', '', label), { value: v, selected: now === v }));
    s.addEventListener('change', () => set(s.value));
    return s;
  };
  const named = (vals: string[]) => vals.map((v): [string, string] => [v, LAYOUT_NAMES[v] || v]);
  const layoutSel = (k: string) =>
    select(k, named(LAYOUT_CHOICES[k]!), shown().layout[k] as string, (v) =>
      lay((l) => {
        l[k] = v;
      }),
    );
  const check = (k: string, label: string, on: boolean, set: (on: boolean) => void, sub?: string) => {
    const r = el('label', 'dk-ap-check');
    const inp = Object.assign(el('input'), { type: 'checkbox', checked: on });
    inp.dataset.k = k;
    inp.addEventListener('change', () => set(inp.checked));
    r.append(inp, el('span', 'dk-ap-check-t', label));
    if (sub) r.append(el('span', 'dk-ap-note', sub));
    return r;
  };
  const color = (k: 'accent' | 'desk') => {
    const box = el('span', 'dk-ap-color');
    const inp = Object.assign(el('input', 'dk-ap-in'), { type: 'color', value: shown()[k] });
    inp.dataset.k = k;
    const hexNote = el('span', 'dk-ap-note', shown()[k]);
    inp.addEventListener('input', () => {
      hexNote.textContent = inp.value;
      change((c) => {
        c[k] = inp.value;
      }, false);
    });
    inp.addEventListener('change', () => draw());
    box.append(inp, hexNote);
    return box;
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

  // the status items: each shown or not, a shown one dragged by its handle to its place (or moved
  // a step by the arrow keys on it)
  const items = (L: LayoutNow) => {
    const now = L.items;
    const all = [...now, ...BAR_ITEMS.filter((i) => !now.includes(i))];
    const set = (next: string[]) =>
      lay((l) => {
        l.items = next;
      });
    const list = el('div', 'dk-ap-items');
    const rows: HTMLElement[] = [];
    // a shown row dragged: it follows the pointer, the others making room, its place taken on letting go
    const drag = (e: PointerEvent, r: HTMLElement, i: number) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const shownRows = rows.slice(0, now.length);
      const tops = shownRows.map((x) => x.getBoundingClientRect());
      const h = tops[i]!.height;
      const y0 = e.clientY;
      let to = i;
      const grip = e.currentTarget as HTMLElement;
      grip.setPointerCapture(e.pointerId);
      list.classList.add('dragging');
      r.classList.add('lifted');
      const move = (ev: PointerEvent) => {
        const dy = ev.clientY - y0;
        r.style.transform = `translateY(${dy}px)`;
        const mid = tops[i]!.top + h / 2 + dy;
        to = tops.filter((t, j) => j !== i && t.top + t.height / 2 < mid).length;
        shownRows.forEach((x, j) => {
          if (j === i) return;
          const shift = j > i && j <= to ? -h : j < i && j >= to ? h : 0;
          x.style.transform = shift ? `translateY(${shift}px)` : '';
        });
      };
      const end = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', end);
        grip.removeEventListener('pointercancel', end);
        list.classList.remove('dragging');
        r.classList.remove('lifted');
        for (const x of shownRows) x.style.transform = '';
        if (to === i) return;
        const next = [...now];
        next.splice(to, 0, ...next.splice(i, 1));
        set(next);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    };
    all.forEach((id, i) => {
      const r = el('div', 'dk-ap-item');
      const on = now.includes(id);
      const box = Object.assign(el('input'), {
        type: 'checkbox',
        checked: on,
        id: `dk-ap-item-${id}`,
      });
      box.dataset.k = `item:${id}`;
      box.addEventListener('change', () =>
        set(box.checked ? all.filter((x) => x === id || now.includes(x)) : now.filter((x) => x !== id)),
      );
      const name = Object.assign(el('label', '', ITEM_NAMES[id] || id), { htmlFor: box.id });
      const grip = Object.assign(el('button', 'dk-ap-grip'), {
        type: 'button',
        title: on ? 'drag to move it; or the arrow keys' : 'shown items move',
        ariaLabel: `move ${ITEM_NAMES[id] || id}, up or down arrow`,
        disabled: !on,
      });
      grip.dataset.k = `grip:${id}`;
      grip.append(dkGlyph(DK_UI.grip!));
      grip.addEventListener('pointerdown', (e) => drag(e, r, i));
      grip.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
        if (!d || !now.includes(all[i + d]!)) return;
        e.preventDefault();
        e.stopPropagation();
        const next = [...now];
        [next[i], next[i + d]] = [next[i + d]!, next[i]!];
        set(next);
      });
      r.append(grip, box, name);
      rows.push(r);
      list.append(r);
    });
    return list;
  };

  const themeSection = (): HTMLElement[] => {
    const c = shown();
    const worn = paletteNow();
    const base = PALETTES.find((p) => p.id === c.base);
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
    const cards = el('div', 'dk-ap-cards');
    for (const p of PALETTES) {
      const b = Object.assign(el('button', `dk-ap-card${p.id === worn ? ' on' : ''}`), { type: 'button' });
      b.dataset.k = `theme:${p.id}`;
      const top = el('span', 'dk-ap-card-top');
      const [accent, bg] = p.custom ? [c.accent, base?.swatch?.[1] || '#222222'] : p.swatch || ['#888888', '#222222'];
      top.append(swatch(accent, bg), el('span', 'dk-ap-card-name', p.label));
      b.append(
        top,
        el('span', 'dk-ap-card-about', p.custom ? `yours, based on ${base?.label || c.base}` : p.about || ''),
      );
      b.addEventListener('click', () => {
        if (p.id !== worn) setPalette(p.id);
      });
      cards.append(b);
    }
    return [
      head('light or dark'),
      modes,
      note('system follows the browser'),
      head('theme'),
      cards,
      head('yours'),
      note('any change makes the theme yours'),
      row('accent', color('accent')),
      row(
        'page font',
        select(
          'font',
          [
            ['system', 'system sans'],
            ['mono', 'monospaced'],
            ['serif', 'serif'],
          ],
          c.font,
          (v) =>
            change((x) => {
              x.font = v;
            }),
        ),
      ),
      row(
        'code font',
        select(
          'mono',
          [
            ['system', 'system mono'],
            ['cascadia', 'cascadia'],
            ['jetbrains', 'jetbrains mono'],
          ],
          c.mono,
          (v) =>
            change((x) => {
              x.mono = v;
            }),
        ),
      ),
      row(
        'corners',
        select(
          'corners',
          CUSTOM_CORNERS.map((n): [string, string] => [n, n === '0' ? 'square' : `${n}px`]),
          c.corners,
          (v) =>
            change((x) => {
              x.corners = v;
            }),
        ),
      ),
      row(
        'shadows',
        select(
          'shadows',
          Object.keys(CUSTOM_SHADOWS).map((k): [string, string] => [k, k]),
          c.shadows,
          (v) =>
            change((x) => {
              x.shadows = v;
            }),
        ),
      ),
      ...(worn === 'custom' ? [row('', acts(btn(`back to ${base?.label || c.base}`, () => setPalette(c.base))))] : []),
    ];
  };

  const desktopSection = (): HTMLElement[] => {
    const acct = st.acct;
    const can = !!acct && !acct.boot;
    const wall = acts(
      el('span', 'dk-ap-state', acct?.wallpaper ? 'a picture of yours' : 'none'),
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
    return [
      head('wallpaper'),
      can ? row('picture', wall) : note('log in to keep a wallpaper'),
      head('desk'),
      row('color', color('desk')),
    ];
  };

  const barSection = (): HTMLElement[] => {
    const L = shown().layout;
    const menubarOn = L.menubar !== 'off';
    return [
      head('task bar'),
      row('edge', layoutSel('bar')),
      row('style', layoutSel('barStyle')),
      check(
        'autohide',
        'autohide',
        L.autohide === 'on',
        (on) =>
          lay((l) => {
            l.autohide = on ? 'on' : 'off';
          }),
        'while a window is maximized',
      ),
      row('labels', layoutSel('labels')),
      row('items', items(L), 'log out is also under profile'),
      head('menu bar'),
      check('menubar', 'status items in a bar of their own', menubarOn, (on) =>
        lay((l) => {
          l.menubar = on ? 'top' : 'off';
        }),
      ),
      ...(menubarOn
        ? [
            row(
              'edge',
              select('menubarEdge', named(['top', 'bottom']), L.menubar, (v) =>
                lay((l) => {
                  l.menubar = v;
                }),
              ),
            ),
          ]
        : []),
    ];
  };

  const windowsSection = (): HTMLElement[] => [
    head('opening'),
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
    head('title bar'),
    row('buttons', layoutSel('btns')),
    row('button style', layoutSel('btnStyle')),
    row('title', layoutSel('title')),
    row('height', layoutSel('density')),
  ];

  const draw = () => {
    const focus = (document.activeElement as HTMLElement | null)?.dataset.k;
    const subs: Record<ApSub, () => HTMLElement[]> = {
      theme: themeSection,
      desktop: desktopSection,
      bar: barSection,
      windows: windowsSection,
    };
    body.replaceChildren(...cardify(subs[sub]()));
    if (focus) pane.querySelector<HTMLElement>(`[data-k="${CSS.escape(focus)}"]`)?.focus();
  };
  const onPalette = () => {
    if (!quiet) draw();
  };
  const onWall = () => draw();
  addEventListener(PALETTE_EVENT, onPalette);
  addEventListener(WALL_EVENT, onWall);
  draw();
  return () => {
    removeEventListener(PALETTE_EVENT, onPalette);
    removeEventListener(WALL_EVENT, onWall);
  };
}
