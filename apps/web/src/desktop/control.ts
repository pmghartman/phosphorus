// --- the control panel and the appearance window: the mesh, the update, light or dark, the theme
// and everything of yours over it, one button for all
import { acctLogout, dkProfileWin, dkUserGlyph, dkUsersWin } from '../account.ts';
import { DK_GLYPHS, DK_UI, dkGlyph, el } from '../dom.ts';
import { phosphorusHosts } from '../mesh.ts';
import { MODES, modeIcon, modePick, setTheme } from '../scheme.ts';
import { dk, st } from '../state.ts';
import { BAR_ITEMS, CUSTOM_CORNERS, CUSTOM_SHADOWS, customNow, LAYOUT_CHOICES, PALETTE_EVENT, PALETTES, paletteNow, setCustom, setPalette, themeConfig, type CustomConfig, type LayoutNow } from '../theme.ts';
import { checkUpdates, meshLockNow, openUpdateModal, updates } from '../update.ts';
import { dkWallClear, dkWallPick, WALL_EVENT } from './desk.ts';
import { dkAnchor, dkPopsClose, type Pop } from './taskbar.ts';
import { dkFocus, dkSize, dkWin } from './windows.ts';

// --- appearance: light or dark, the theme, the desk, the bar and the windows -------------------

export type Section = 'theme' | 'desktop' | 'bar' | 'windows';
const SECTIONS: { id: Section; label: string; glyph: () => string }[] = [
  { id: 'theme', label: 'theme', glyph: () => DK_GLYPHS.palette! },
  { id: 'desktop', label: 'desktop', glyph: () => DK_UI.desk! },
  { id: 'bar', label: 'bar', glyph: () => DK_UI.list! },
  { id: 'windows', label: 'windows', glyph: () => DK_GLYPHS.app! },
];

// the layout's choices by name
const LAYOUT_NAMES: Record<string, string> = {
  bottom: 'bottom', top: 'top', left: 'left', right: 'right', panel: 'floating panel', dock: 'dock', full: 'edge to edge', line: 'status line',
  glyphs: 'glyphs', lights: 'traffic lights', caption: 'caption buttons', center: 'centered', normal: 'normal', compact: 'compact', roomy: 'roomy',
  both: 'icons and titles', icons: 'icons only', titles: 'titles only',
};
// the bar's status items by name
const ITEM_NAMES: Record<string, string> = { search: 'search', hosts: 'hosts', agent: 'agent', bell: 'notifications', clock: 'clock', profile: 'profile' };

// a swatch: an accent over its ground
function swatch(accent: string, bg: string): HTMLElement {
  const sw = el('span', 'dk-ap-swatch');
  sw.style.background = `linear-gradient(135deg, ${accent} 50%, ${bg} 50%)`;
  return sw;
}

let section: Section = 'theme';
// the open window's way to another section, null while none is open
let live: ((s: Section) => void) | null = null;

// the appearance window. Every control shows what is worn: a built-in theme's own values, or the
// custom theme's. Changing one makes the custom theme, based on the theme worn, and wears it at
// once; it is kept with the user's settings on every host
export function dkAppearanceWin(at?: Section): void {
  if (at) section = at;
  const w = dkWin('app:appearance', 'appearance', '', 'app dk-app-appearance');
  if (!w) { live?.(section); return; }
  const pane = el('div', 'dk-ap-pane');
  const nav = el('nav', 'dk-ap-nav');
  const body = el('div', 'dk-ap-body');
  pane.append(nav, body);
  w.body.appendChild(pane);
  dkSize(w, 580, 600);

  const shown = (): CustomConfig => (paletteNow() === 'custom' ? customNow() : themeConfig(paletteNow()));
  // quiet while a color is dragged: the page follows, the controls stay put until it is let go
  let quiet = false;
  const change = (fn: (c: CustomConfig) => void, redraw = true) => { const c = shown(); fn(c); quiet = !redraw; setCustom(c); quiet = false; };
  const lay = (fn: (l: LayoutNow) => void) => change((c) => { fn(c.layout); });

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
    for (const [v, label] of choices) s.append(Object.assign(el('option', '', label), { value: v, selected: now === v }));
    s.addEventListener('change', () => set(s.value));
    return s;
  };
  const named = (vals: string[]) => vals.map((v): [string, string] => [v, LAYOUT_NAMES[v] || v]);
  const layoutSel = (k: string) => select(k, named(LAYOUT_CHOICES[k]!), shown().layout[k] as string, (v) => lay((l) => { l[k] = v; }));
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
    inp.addEventListener('input', () => { hexNote.textContent = inp.value; change((c) => { c[k] = inp.value; }, false); });
    inp.addEventListener('change', () => draw());
    box.append(inp, hexNote);
    return box;
  };
  const btn = (label: string, act: () => void, cls = '') => {
    const b = Object.assign(el('button', `dk-ap-btn${cls ? ` ${cls}` : ''}`, label), { type: 'button' });
    b.addEventListener('click', act);
    return b;
  };
  const acts = (...kids: HTMLElement[]) => { const d = el('div', 'dk-ap-acts'); d.append(...kids); return d; };

  // the status items: each shown or not, moved earlier or later; the profile always, the way here
  const items = (L: LayoutNow) => {
    const now = L.items;
    const all = [...now, ...BAR_ITEMS.filter((i) => !now.includes(i))];
    const set = (next: string[]) => lay((l) => { l.items = next; });
    const list = el('div', 'dk-ap-items');
    all.forEach((id, i) => {
      const r = el('div', 'dk-ap-item');
      const on = now.includes(id);
      const box = Object.assign(el('input'), { type: 'checkbox', checked: on, disabled: id === 'profile', id: `dk-ap-item-${id}` });
      box.dataset.k = `item:${id}`;
      box.addEventListener('change', () => set(box.checked ? all.filter((x) => x === id || now.includes(x)) : now.filter((x) => x !== id)));
      const name = Object.assign(el('label', '', ITEM_NAMES[id] || id), { htmlFor: box.id });
      const mv = (d: number, glyph: string, label: string) => {
        const b = Object.assign(el('button', 'dk-ap-mv', glyph), { type: 'button', title: label, ariaLabel: `${ITEM_NAMES[id]} ${label}`, disabled: !on || !now.includes(all[i + d]!) });
        b.dataset.k = `mv:${id}:${d}`;
        b.addEventListener('click', () => { const next = [...now]; [next[i], next[i + d]] = [next[i + d]!, next[i]!]; set(next); });
        return b;
      };
      r.append(box, name, mv(-1, '↑', 'earlier'), mv(1, '↓', 'later'));
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
      b.addEventListener('click', () => { setTheme(m); draw(); });
      modes.append(b);
    }
    const cards = el('div', 'dk-ap-cards');
    for (const p of PALETTES) {
      const b = Object.assign(el('button', `dk-ap-card${p.id === worn ? ' on' : ''}`), { type: 'button' });
      b.dataset.k = `theme:${p.id}`;
      const top = el('span', 'dk-ap-card-top');
      const [accent, bg] = p.custom ? [c.accent, base?.swatch?.[1] || '#222222'] : p.swatch || ['#888888', '#222222'];
      top.append(swatch(accent, bg), el('span', 'dk-ap-card-name', p.label));
      b.append(top, el('span', 'dk-ap-card-about', p.custom ? `yours, based on ${base?.label || c.base}` : p.about || ''));
      b.addEventListener('click', () => { if (p.id !== worn) setPalette(p.id); });
      cards.append(b);
    }
    return [
      head('light or dark'),
      modes,
      note('system follows the browser'),
      head('theme'),
      cards,
      head('yours'),
      note('Change anything here, or in the other sections, and the theme becomes yours: based on the one worn, kept with your settings on every host.'),
      row('accent', color('accent')),
      row('page font', select('font', [['system', 'system sans'], ['mono', 'monospaced'], ['serif', 'serif']], c.font, (v) => change((x) => { x.font = v; }))),
      row('code font', select('mono', [['system', 'system mono'], ['cascadia', 'cascadia'], ['jetbrains', 'jetbrains mono']], c.mono, (v) => change((x) => { x.mono = v; }))),
      row('corners', select('corners', CUSTOM_CORNERS.map((n): [string, string] => [n, n === '0' ? 'square' : `${n}px`]), c.corners, (v) => change((x) => { x.corners = v; }))),
      row('shadows', select('shadows', Object.keys(CUSTOM_SHADOWS).map((k): [string, string] => [k, k]), c.shadows, (v) => change((x) => { x.shadows = v; }))),
      ...(worn === 'custom' ? [row('', acts(btn(`back to ${base?.label || c.base}`, () => setPalette(c.base))), 'every setting of yours dropped, the theme worn as it comes')] : []),
    ];
  };

  const desktopSection = (): HTMLElement[] => {
    const acct = st.acct;
    const can = !!acct && !acct.boot;
    const wall = acts(
      el('span', 'dk-ap-state', acct?.wallpaper ? 'a picture of yours' : 'none'),
      btn('change…', dkWallPick),
      ...(acct?.wallpaper ? [btn('remove', () => { void dkWallClear(); }, 'danger')] : []),
    );
    return [
      head('wallpaper'),
      can ? row('picture', wall, 'kept in your home on the mesh, shown on every host') : note('log in to keep a wallpaper'),
      head('desk'),
      row('color', color('desk'), 'under the icons, unless a picture is set'),
    ];
  };

  const barSection = (): HTMLElement[] => {
    const L = shown().layout;
    const menubarOn = L.menubar !== 'off';
    return [
      head('task bar'),
      note('The open windows, the hosts and the status items along one edge of the screen. In the dock style it floats centered on that edge, as a dock.'),
      row('edge', layoutSel('bar')),
      row('style', layoutSel('barStyle')),
      check('autohide', 'hidden until the pointer reaches its edge', L.autohide === 'on', (on) => lay((l) => { l.autohide = on ? 'on' : 'off'; }), 'while a window is maximized'),
      row('labels', layoutSel('labels'), 'on the bar’s windows and the menu bar’s app'),
      row('items', items(L), 'the profile is always shown: it opens this window'),
      head('menu bar'),
      check('menubar', 'a bar of its own for the status items', menubarOn, (on) => lay((l) => { l.menubar = on ? 'top' : 'off'; }), 'the task bar keeps the windows; never on a phone'),
      ...(menubarOn ? [row('edge', select('menubarEdge', named(['top', 'bottom']), L.menubar, (v) => lay((l) => { l.menubar = v; })))] : []),
    ];
  };

  const windowsSection = (): HTMLElement[] => [
    head('title bar'),
    row('buttons', layoutSel('btns')),
    row('button style', layoutSel('btnStyle')),
    row('title', layoutSel('title')),
    row('height', layoutSel('density')),
  ];

  const draw = () => {
    const focus = (document.activeElement as HTMLElement | null)?.dataset.k;
    nav.replaceChildren(...SECTIONS.map((s) => {
      const b = Object.assign(el('button', `dk-ap-tab${s.id === section ? ' on' : ''}`), { type: 'button' });
      b.dataset.k = `tab:${s.id}`;
      b.append(dkGlyph(s.glyph()), s.label);
      b.addEventListener('click', () => { section = s.id; draw(); body.scrollTop = 0; });
      return b;
    }));
    const sections: Record<Section, () => HTMLElement[]> = { theme: themeSection, desktop: desktopSection, bar: barSection, windows: windowsSection };
    body.replaceChildren(...sections[section]());
    if (focus) pane.querySelector<HTMLElement>(`[data-k="${CSS.escape(focus)}"]`)?.focus();
  };
  live = (s) => { section = s; draw(); };
  const onPalette = () => { if (!quiet) draw(); };
  const onWall = () => draw();
  addEventListener(PALETTE_EVENT, onPalette);
  addEventListener(WALL_EVENT, onWall);
  w.onClose = () => { removeEventListener(PALETTE_EVENT, onPalette); removeEventListener(WALL_EVENT, onWall); live = null; };
  draw();
  dkFocus(w);
}

// --- the control panel: the clock and the user one button; the mesh, the update, and the way to
// the appearance, profile and users windows

export function dkControlTray(): HTMLElement {
  const wrap = el('div', 'dk-tray-wrap dk-ctl');
  const b = Object.assign(el('button', 'dk-tray dk-profile'), { type: 'button', title: `${st.acct?.user || 'profile'}${st.acct?.admin ? ', admin' : ''}`, ariaLabel: 'control panel' });
  b.setAttribute('aria-expanded', 'false');
  b.append(dk.clock!, dkUserGlyph(), el('span', 'dk-profile-name', st.acct?.user || ''));
  const pop = Object.assign(el('div', 'dk-ctl-pop dk-pop'), { hidden: true }) as Pop;
  wrap.append(b, pop);
  dkAnchor(pop, b, { fill: 270 });
  const tile = (glyph: string, label: string, sub: string, act: () => void, fresh = false) => {
    const t = Object.assign(el('button', `dk-ctl-tile${fresh ? ' fresh' : ''}`), { type: 'button' });
    t.append(dkGlyph(glyph), el('span', 'dk-ctl-label', label), el('span', 'dk-ctl-sub', sub));
    t.addEventListener('click', () => { show(false); act(); });
    return t;
  };
  const draw = () => {
    const n = phosphorusHosts().length;
    const tiles = el('div', 'dk-ctl-tiles');
    tiles.append(tile(DK_GLYPHS.mesh!, 'mesh', `${n} host${n === 1 ? '' : 's'}`, () => dk.meshTray?.show(true)));
    if (st.acct?.admin) {
      const busy = meshLockNow() ? 'running' : updates.mesh ? `v${updates.mesh} out` : 'current';
      tiles.append(tile(DK_GLYPHS.update!, 'mesh update', busy, () => { dkPopsClose('update'); openUpdateModal(); }, !!updates.mesh && !meshLockNow()));
    }
    // the appearance, one row: the theme and mode worn, the window on a press
    const ap = Object.assign(el('button', 'dk-ctl-row'), { type: 'button', title: 'light or dark, the theme, the desk, the bar and the windows' });
    const worn = PALETTES.find((p) => p.id === paletteNow());
    ap.append(dkGlyph(DK_GLYPHS.palette!, 'dk-ctl-row-ic'), el('span', 'dk-ctl-row-k', 'appearance'),
      el('span', 'dk-ctl-row-v', `${worn?.label || paletteNow()}, ${modePick()}`), dkGlyph(DK_UI.fwd!, 'dk-ctl-row-ch'));
    ap.addEventListener('click', () => { show(false); dkAppearanceWin(); });
    // the account's windows, small chips under the row
    const chips = el('div', 'dk-ctl-chips');
    const chip = (glyph: string, label: string, act: () => void) => {
      const c = Object.assign(el('button', 'dk-ctl-chip'), { type: 'button' });
      c.append(dkGlyph(glyph), el('span', '', label));
      c.addEventListener('click', () => { show(false); act(); });
      chips.append(c);
    };
    chip(DK_GLYPHS.user!, 'profile', dkProfileWin);
    if (st.acct?.admin) chip(DK_GLYPHS.users!, 'users', dkUsersWin);
    const head = el('div', 'dk-ctl-id');
    const who = el('div', 'dk-ctl-who');
    who.append(el('span', 'dk-ctl-name', st.acct?.user || 'profile'),
      el('span', 'dk-ctl-role', st.acct?.admin ? 'admin' : 'user'));
    const out = Object.assign(el('button', 'dk-ctl-out'), { type: 'button', title: 'log out', ariaLabel: 'log out' });
    out.append(dkGlyph(DK_GLYPHS.power!));
    out.addEventListener('click', () => { show(false); acctLogout(); });
    const avatar = el('span', 'dk-ctl-avatar');
    avatar.append(dkUserGlyph());
    head.append(avatar, who, out);
    pop.replaceChildren(head, tiles, ap, chips);
  };
  const show = (on: boolean) => {
    if (!on && pop.hidden) return;
    if (on) dkPopsClose('ctl');
    pop.hidden = !on;
    b.setAttribute('aria-expanded', String(on));
    if (on) draw();
  };
  b.addEventListener('click', () => show(pop.hidden as boolean));
  document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !wrap.contains(e.target as Node)) show(false); }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) show(false); });
  dk.ctl = { show, btn: b, wrap, draw: () => { if (!pop.hidden) draw(); } };
  setTimeout(checkUpdates, 3000);
  return wrap;
}
