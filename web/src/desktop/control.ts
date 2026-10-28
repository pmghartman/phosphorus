// --- the control panel: the mesh, the update, the theme, one button for all
import { acctLogout, dkProfileWin, dkUserGlyph, dkUsersWin } from '../account.ts';
import { DK_GLYPHS, DK_UI, dkGlyph, el } from '../dom.ts';
import { phosphorusHosts } from '../mesh.ts';
import { currentTheme, setTheme, THEME_ICON, THEMES } from '../scheme.ts';
import { dk, st } from '../state.ts';
import { BAR_ITEMS, CUSTOM_CORNERS, CUSTOM_SHADOWS, customNow, LAYOUT_CHOICES, PALETTES, paletteNow, setCustom, setPalette, themeConfig, type Palette } from '../theme.ts';
import { checkUpdates, meshLockNow, openUpdateModal, updates } from '../update.ts';
import { dkAnchor, dkPopsClose, type Pop } from './taskbar.ts';
import { dkFocus, dkSize, dkWin } from './windows.ts';

// the themes a dropdown: the current one on its button, the list opened under it in the panel,
// arrows, home and end through it, enter or a click to pick, escape closing just the list;
// open and focused as it was across the panel's redraws
const dkThemeDrop = { open: false, at: -1 };
// a theme's swatch, its accent over its ground; the custom one's from what it starts from
function dkSwatch(p: Palette): HTMLElement {
  const c = p.custom ? customNow() : null;
  const base = c ? PALETTES.find((x) => x.id === c.base) : p;
  const [accent, bg] = base?.swatch || ['#888888', '#222222'];
  const sw = el('span', 'dk-ctl-swatch');
  sw.style.background = `linear-gradient(135deg, ${c?.accent || accent} 50%, ${bg} 50%)`;
  return sw;
}

// the layout's choices by name, and the bar's status items
const DK_LAYOUT_NAMES: Record<string, string> = {
  bottom: 'bottom', top: 'top', left: 'left', right: 'right', off: 'none', panel: 'floating panel', dock: 'dock', full: 'edge to edge',
  line: 'status line', glyphs: 'glyphs', lights: 'traffic lights', caption: 'caption buttons', center: 'centered',
  normal: 'normal', compact: 'compact', roomy: 'roomy', on: 'on', both: 'icons and titles', icons: 'icons', titles: 'titles',
};
const DK_ITEM_NAMES: Record<string, string> = { hosts: 'hosts', agent: 'agent', bell: 'notifications', clock: 'clock', profile: 'profile and settings' };

// the custom theme, made here: every setting its own value, worn once saved, then kept with the
// user's settings on every host; a reset sets them all to one of the built-in themes'
function dkThemeWin() {
  const w = dkWin('app:theme', 'theme', 'custom', 'app dk-app-theme');
  if (!w) return;
  const pane = el('div', 'dk-theme-pane');
  const body = el('div', 'dk-theme-body');
  const foot = el('div', 'dk-theme-foot');
  pane.append(body, foot);
  w.body.appendChild(pane);
  dkSize(w, 480, 640);
  let c = customNow();
  let dirty = false;
  let resets = false;
  const touch = () => { dirty = true; paintFoot(); };
  const row = (label: string, input: HTMLElement, note?: string) => {
    const r = el('label', 'dk-theme-row');
    r.append(el('span', 'dk-theme-k', label), input);
    if (note) r.append(el('span', 'dk-theme-note', note));
    return r;
  };
  const select = (choices: [string, string][], now: string, set: (v: string) => void) => {
    const s = el('select', 'dk-theme-in');
    for (const [v, label] of choices) s.append(Object.assign(el('option', '', label), { value: v, selected: now === v }));
    s.addEventListener('change', () => { set(s.value); touch(); });
    return s;
  };
  type Key = 'font' | 'mono' | 'corners' | 'shadows';
  const pick = (key: Key, choices: [string, string][]) => select(choices, c[key], (v) => { c[key] = v; });
  const color = (key: 'accent' | 'desk') => {
    const box = el('span', 'dk-theme-color');
    const inp = Object.assign(el('input', 'dk-theme-in'), { type: 'color', value: c[key] });
    const hexNote = el('span', 'dk-theme-note', c[key]);
    inp.addEventListener('input', () => { c[key] = inp.value; hexNote.textContent = inp.value; touch(); });
    box.append(inp, hexNote);
    return box;
  };
  const lay = (key: string) => select(LAYOUT_CHOICES[key]!.map((v): [string, string] => [v, DK_LAYOUT_NAMES[v]!]), c.layout[key] as string, (v) => { c.layout = { ...c.layout, [key]: v }; });
  // the status items: each shown or not, moved up or down; the profile always, the way to settings
  const items = () => {
    const now = c.layout.items;
    const all = [...now, ...BAR_ITEMS.filter((i) => !now.includes(i))];
    const set = (next: string[]) => { c.layout = { ...c.layout, items: next }; touch(); draw(); };
    const list = el('div', 'dk-theme-items');
    all.forEach((id, i) => {
      const r = el('div', 'dk-theme-item');
      const shown = now.includes(id);
      const on = Object.assign(el('input'), { type: 'checkbox', checked: shown, disabled: id === 'profile', id: `dk-theme-item-${id}` });
      on.addEventListener('change', () => set(on.checked ? all.filter((x) => x === id || now.includes(x)) : now.filter((x) => x !== id)));
      const name = Object.assign(el('label', '', DK_ITEM_NAMES[id]), { htmlFor: on.id });
      const mv = (d: number, glyph: string, label: string) => {
        const b = Object.assign(el('button', 'dk-theme-mv', glyph), { type: 'button', title: label, ariaLabel: `${DK_ITEM_NAMES[id]} ${label}`, disabled: !shown || !now.includes(all[i + d]!) });
        b.addEventListener('click', () => { const next = [...now]; [next[i], next[i + d]] = [next[i + d]!, next[i]!]; set(next); });
        return b;
      };
      r.append(on, name, mv(-1, '↑', 'earlier'), mv(1, '↓', 'later'));
      list.append(r);
    });
    const r = el('div', 'dk-theme-row');
    r.append(el('span', 'dk-theme-k', 'bar items'), list);
    return r;
  };
  // the bottom: a reset to a built-in theme's config, and the save that wears it
  const paintFoot = () => {
    const worn = paletteNow() === 'custom';
    const reset = Object.assign(el('button', 'dk-theme-reset', 'reset…'), { type: 'button' });
    reset.setAttribute('aria-expanded', String(resets));
    reset.addEventListener('click', () => { resets = !resets; paintFoot(); });
    const save = Object.assign(el('button', 'dk-theme-save', dirty || !worn ? 'save and apply' : 'saved'), { type: 'button', disabled: !dirty && worn });
    save.addEventListener('click', () => { c = setCustom(c); dirty = false; resets = false; draw(); });
    const acts = el('div', 'dk-theme-acts');
    acts.append(reset, save);
    const kids: HTMLElement[] = [];
    if (resets) {
      const list = el('div', 'dk-theme-resets');
      list.append(el('span', 'dk-theme-note', 'reset every setting to the config of'));
      for (const p of PALETTES.filter((x) => !x.custom)) {
        const b = Object.assign(el('button', '', p.label), { type: 'button', title: p.about });
        b.addEventListener('click', () => { c = themeConfig(p.id); dirty = true; resets = false; draw(); });
        list.append(b);
      }
      kids.push(list);
    }
    foot.replaceChildren(...kids, acts);
  };
  const draw = () => {
    body.replaceChildren(
      el('p', 'dk-note', 'Your theme, kept with your settings on every host. Changes are worn when you save and apply.'),
      row('accent', color('accent')),
      row('page font', pick('font', [['system', 'system sans'], ['mono', 'monospaced'], ['serif', 'serif']])),
      row('code font', pick('mono', [['system', 'system mono'], ['cascadia', 'cascadia'], ['jetbrains', 'jetbrains mono']])),
      row('corners', pick('corners', CUSTOM_CORNERS.map((n): [string, string] => [n, n === '0' ? 'square' : `${n}px`]))),
      row('shadows', pick('shadows', Object.keys(CUSTOM_SHADOWS).map((k): [string, string] => [k, k]))),
      row('desk', color('desk'), 'under the icons, unless a picture is set'),
      el('div', 'dk-theme-head', 'layout'),
      row('task bar', lay('bar')),
      row('bar style', lay('barStyle')),
      row('auto-hide bar', lay('autohide'), 'tucked away until the pointer reaches its edge'),
      row('menu bar', lay('menubar'), 'the status items along an edge of their own'),
      row('app labels', lay('labels'), 'on the bar’s windows and the menu bar’s app'),
      items(),
      row('window buttons', lay('btns')),
      row('button style', lay('btnStyle')),
      row('title', lay('title')),
      row('title bar', lay('density')),
    );
    paintFoot();
  };
  draw();
  dkFocus(w);
}
function dkPaletteDrop(redraw: () => void): HTMLElement {
  const hadFocus = !!document.activeElement?.closest?.('.dk-ctl-drop');
  const now = paletteNow();
  const cur = PALETTES.find((p) => p.id === now) || PALETTES[0]!;
  const wrap = el('div', 'dk-ctl-drop');
  const btn = Object.assign(el('button', 'dk-ctl-drop-btn'), { type: 'button', title: cur.about });
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.append(el('span', 'dk-ctl-drop-k', 'theme'), dkSwatch(cur), el('span', 'dk-ctl-drop-label', cur.label), dkGlyph(DK_UI.down!, 'dk-ctl-drop-ch'));
  const list = Object.assign(el('ul', 'dk-ctl-drop-list'), { hidden: true });
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'theme');
  const opts = PALETTES.map((p) => {
    const li = Object.assign(el('li', `dk-ctl-drop-opt${p.id === cur.id ? ' on' : ''}`), { tabIndex: -1 });
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(p.id === cur.id));
    const text = el('span', 'dk-ctl-drop-text');
    text.append(el('span', 'dk-ctl-drop-name', p.label), el('span', 'dk-ctl-drop-about', p.about));
    li.append(dkSwatch(p), text);
    li.addEventListener('click', () => { dkThemeDrop.open = false; if (p.id !== paletteNow()) setPalette(p.id); redraw(); });
    list.append(li);
    return li;
  });
  // the custom theme's editor, last in the list
  const edit = Object.assign(el('li', 'dk-ctl-drop-opt dk-ctl-drop-act'), { tabIndex: -1 });
  edit.setAttribute('role', 'option');
  const editText = el('span', 'dk-ctl-drop-text');
  editText.append(el('span', 'dk-ctl-drop-name', 'customize…'), el('span', 'dk-ctl-drop-about', 'start from any theme, then your own accent, type, corners, shadows and layout'));
  edit.append(dkGlyph(DK_GLYPHS.gear!, 'dk-ctl-drop-ic'), editText);
  edit.addEventListener('click', () => { dkThemeDrop.open = false; dk.ctl?.show(false); dkThemeWin(); });
  list.append(edit);
  opts.push(edit);
  for (const [i, li] of opts.entries()) li.addEventListener('focus', () => { dkThemeDrop.at = i; });
  const open = (on: boolean, focus = true) => {
    dkThemeDrop.open = on;
    dkThemeDrop.at = -1;
    list.hidden = !on;
    wrap.classList.toggle('open', on);
    btn.setAttribute('aria-expanded', String(on));
    if (on && focus) opts[Math.max(0, PALETTES.indexOf(cur))]!.focus();
    if (!on && focus) btn.focus();
  };
  btn.addEventListener('click', () => open(list.hidden, false));
  btn.addEventListener('keydown', (e) => {
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    open(true);
  });
  list.addEventListener('keydown', (e) => {
    const i = opts.indexOf(document.activeElement as HTMLLIElement);
    const to = ({ ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: opts.length - 1 } as Record<string, number>)[e.key];
    if (to !== undefined) { e.preventDefault(); opts[(to + opts.length) % opts.length]!.focus(); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts[i]?.click(); (document.querySelector('.dk-ctl-drop-btn') as HTMLElement | null)?.focus(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open(false); }
  });
  wrap.append(btn, list);
  const at = dkThemeDrop.at;
  if (dkThemeDrop.open) open(true, false);
  // the focus put back once the panel holds the new one
  if (hadFocus) queueMicrotask(() => (dkThemeDrop.open && at >= 0 ? opts[at]! : btn).focus());
  return wrap;
}

// the clock and the user one button, the panel the mesh, update, theme and account
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
    const theme = el('div', 'dk-ctl-theme');
    for (const t of THEMES) {
      const tb = Object.assign(el('button', `dk-ctl-seg${currentTheme() === t ? ' on' : ''}`), { type: 'button', title: t });
      const icon = document.querySelector(`.theme-toggle .${THEME_ICON[t]}`)?.cloneNode(true);
      tb.append(...(icon ? [icon] : []), t);
      tb.addEventListener('click', () => { setTheme(t); draw(); });
      theme.append(tb);
    }
    // the theme, every app's, its whole look
    const palette = dkPaletteDrop(draw);
    // the account's own actions, small chips under the panel's big tiles
    const chips = el('div', 'dk-ctl-chips');
    const chip = (glyph: string, label: string, act: () => void) => {
      const c = Object.assign(el('button', 'dk-ctl-chip'), { type: 'button' });
      c.append(dkGlyph(glyph), el('span', '', label));
      c.addEventListener('click', () => { show(false); act(); });
      chips.append(c);
    };
    chip(DK_GLYPHS.gear!, 'settings', dkProfileWin);
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
    pop.replaceChildren(head, tiles, theme, palette, chips);
  };
  const show = (on: boolean) => {
    if (!on && pop.hidden) return;
    if (on) dkPopsClose('ctl');
    else dkThemeDrop.open = false;
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

