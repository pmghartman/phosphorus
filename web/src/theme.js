// the themes, phosphorus wide: the desktop, every app and Sulfur alike, each with its dark,
// light and oled. Their tokens are the theme library's (internal/theme/themes.json), built into
// style.css; here the pick, a custom theme over any of them, and what the page's head needs to
// put them up before paint. Kept per user across the mesh with the rest of their settings.
import LIB from '../../internal/theme/themes.json';

const KEY = 'phosphorus-palette';
const CUSTOM_KEY = 'phosphorus-theme-custom';
// what the head script sets before paint: the look, its flags and layout, a custom theme's css
const APPLIED_KEY = 'phosphorus-theme-applied';
export const PALETTE_EVENT = 'phosphorus-palette';

const tokensOf = (t) => ({ ...LIB.base.dark, ...t.dark });
export const PALETTES = [
  ...LIB.themes.map((t) => ({
    id: t.id, label: t.label, about: t.about, look: t.look, round: !!t.round, sans: !!t.sans,
    swatch: [tokensOf(t)['--accent'], tokensOf(t)['--bg']],
  })),
  { id: 'custom', label: 'custom', about: 'yours: a theme to start from, with your accent, type, corners, shadows and layout', look: '', custom: true },
];
const LOOKS = LIB.themes.map((t) => t.id);
const builtIn = (id) => LIB.themes.find((t) => t.id === id);

// --- a custom theme: a built-in one to start from, any of these over it, '' the theme's own ------

export const CUSTOM_FONTS = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, "Helvetica Neue", sans-serif',
  mono: '"Geist Mono Variable", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
};
export const CUSTOM_MONOS = {
  geist: '"Geist Mono Variable", ui-monospace, monospace',
  system: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
  cascadia: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
  jetbrains: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
};
export const CUSTOM_SHADOWS = {
  none: { '--lift': 'none', '--drop': 'none', '--lift-sm': 'none', '--win-shadow': '0 0 0 1px var(--border)', '--win-shadow-off': '0 0 0 1px var(--border)' },
  soft: {
    '--lift': '0 1px 2px rgb(0 0 0 / 0.12)', '--drop': '0 6px 18px rgb(0 0 0 / 0.18)', '--lift-sm': '0 1px 1px rgb(0 0 0 / 0.1)',
    '--win-shadow': '0 0 0 1px rgb(0 0 0 / 0.08), 0 10px 30px rgb(0 0 0 / 0.2)', '--win-shadow-off': '0 0 0 1px rgb(0 0 0 / 0.06), 0 6px 16px rgb(0 0 0 / 0.12)',
  },
  deep: {
    '--lift': '0 2px 6px rgb(0 0 0 / 0.3)', '--drop': '0 14px 40px rgb(0 0 0 / 0.45)', '--lift-sm': '0 1px 3px rgb(0 0 0 / 0.3)',
    '--win-shadow': '0 0 0 1px rgb(0 0 0 / 0.3), 0 24px 64px rgb(0 0 0 / 0.5)', '--win-shadow-off': '0 0 0 1px rgb(0 0 0 / 0.2), 0 12px 32px rgb(0 0 0 / 0.3)',
  },
};
export const CUSTOM_CORNERS = ['0', '4', '8', '12'];
// the layout's choices, each key's first its fallback; items the bar's status items, in order
export const LAYOUT_CHOICES = {
  bar: ['bottom', 'top', 'left', 'right'],
  barStyle: ['panel', 'dock', 'full', 'line'],
  menubar: ['off', 'top', 'bottom'],
  btns: ['right', 'left'],
  btnStyle: ['glyphs', 'lights', 'caption'],
  title: ['left', 'center'],
  density: ['normal', 'compact', 'roomy'],
};
export const BAR_ITEMS = ['hosts', 'agent', 'bell', 'clock', 'profile'];
export const CUSTOM_DEFAULT = { base: 'phosphorus', accent: '', font: '', mono: '', corners: '', shadows: '', desk: '', layout: {} };

// a layout made whole: each key valid, the profile never hidden (it opens the settings)
function cleanLayout(l, under) {
  const o = {};
  for (const [k, vals] of Object.entries(LAYOUT_CHOICES)) o[k] = vals.includes(l?.[k]) ? l[k] : under?.[k] || vals[0];
  const items = Array.isArray(l?.items) ? l.items : under?.items || BAR_ITEMS;
  o.items = [...new Set(items.filter((i) => BAR_ITEMS.includes(i)))];
  if (!o.items.includes('profile')) o.items.push('profile');
  return o;
}
// a built-in theme's own layout, over the base's
export const themeLayout = (id) => cleanLayout({ ...LIB.base.layout, ...(builtIn(id) || builtIn('phosphorus')).layout });

const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v.toLowerCase() : '');
// a stored custom theme made safe: unknown keys and values dropped, a bad base the default
function cleanCustom(c) {
  const o = { ...CUSTOM_DEFAULT, layout: {} };
  if (!c || typeof c !== 'object') return o;
  if (builtIn(c.base)) o.base = c.base;
  o.accent = hex(c.accent);
  o.desk = hex(c.desk);
  if (CUSTOM_FONTS[c.font]) o.font = c.font;
  if (CUSTOM_MONOS[c.mono]) o.mono = c.mono;
  if (CUSTOM_CORNERS.includes(String(c.corners))) o.corners = String(c.corners);
  if (CUSTOM_SHADOWS[c.shadows]) o.shadows = c.shadows;
  // only what differs from the base theme's, '' or absent its own
  if (c.layout && typeof c.layout === 'object') {
    for (const [k, vals] of Object.entries(LAYOUT_CHOICES)) if (vals.includes(c.layout[k])) o.layout[k] = c.layout[k];
    if (Array.isArray(c.layout.items)) o.layout.items = cleanLayout({ items: c.layout.items }).items;
  }
  return o;
}

export function customNow() {
  try { return cleanCustom(JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null')); } catch { return cleanCustom(null); }
}

// the custom theme's overrides as rules over the library's (theirs at a single class's weight)
function customCss(c) {
  const page = {};
  const ide = {};
  if (c.accent) {
    Object.assign(page, { '--accent': c.accent, '--mesh-self': c.accent, '--glyph-purple': c.accent });
    Object.assign(ide, { '--ide-accent': c.accent, '--ide-button': c.accent, '--ide-badge': c.accent, '--ide-hl': c.accent, '--ide-link': c.accent, '--ide-caret': c.accent });
  }
  if (c.font) { page['--font'] = CUSTOM_FONTS[c.font]; ide['--ide-ui'] = CUSTOM_FONTS[c.font]; }
  if (c.mono) page['--mono'] = CUSTOM_MONOS[c.mono];
  if (c.corners) {
    const n = Number(c.corners);
    Object.assign(page, { '--r-ctl': `${Math.round(n * 0.6)}px`, '--r-pop': `${n}px`, '--r-card': `${n}px`, '--r-win': `${n ? n + 2 : 0}px` });
  }
  if (c.shadows) Object.assign(page, CUSTOM_SHADOWS[c.shadows]);
  if (c.desk) page['--desk'] = c.desk;
  const rule = (sel, t) => (Object.keys(t).length ? `${sel} { ${Object.entries(t).map(([k, v]) => `${k}: ${v};`).join(' ')} }\n` : '');
  return rule(':root[data-custom]', page) + rule(':root[data-custom] .ide-win', ide);
}

// --- the pick ----------------------------------------------------------------------------------

const valid = (id) => id === 'custom' || !!builtIn(id);
const stored = () => { try { const v = localStorage.getItem(KEY); return valid(v) ? v : 'phosphorus'; } catch { return 'phosphorus'; } };

// the theme picked, custom included; lookNow the built-in one whose structure the page wears
export const paletteNow = () => document.documentElement.dataset.themeId || stored();
export const lookNow = () => document.documentElement.dataset.palette || 'phosphorus';
export const LOOK_IDS = LOOKS;
let layout = themeLayout('phosphorus');
// the layout worn: the theme's, a custom one's choices over it
export const layoutNow = () => layout;

function apply(id) {
  const r = document.documentElement;
  const c = id === 'custom' ? customNow() : null;
  const t = builtIn(c ? c.base : id) || builtIn('phosphorus');
  const round = c?.corners ? c.corners !== '0' : !!t.round;
  const sans = c?.font ? c.font !== 'mono' : !!t.sans;
  const css = c ? customCss(c) : '';
  layout = cleanLayout(c?.layout, themeLayout(t.id));
  // each as data-l-*: barStyle as data-l-bar-style
  const attrs = Object.fromEntries(Object.keys(LAYOUT_CHOICES).map((k) => [k, layout[k]]));
  for (const [k, v] of Object.entries(attrs)) r.dataset[`l${k[0].toUpperCase()}${k.slice(1)}`] = v;
  r.dataset.palette = t.id;
  r.dataset.themeId = id;
  r.toggleAttribute('data-round', round);
  r.toggleAttribute('data-sans', sans);
  r.toggleAttribute('data-custom', !!c);
  r.toggleAttribute('data-custom-desk', !!c?.desk);
  let tag = document.getElementById('phosphorus-custom');
  if (css && !tag) { tag = Object.assign(document.createElement('style'), { id: 'phosphorus-custom' }); document.head.append(tag); }
  if (tag) tag.textContent = css;
  try { localStorage.setItem(APPLIED_KEY, JSON.stringify({ id, look: t.id, round, sans, desk: !!c?.desk, css, layout: attrs })); } catch {}
}

export function setPalette(id) {
  if (!valid(id)) return;
  try { localStorage.setItem(KEY, id); } catch {}
  apply(id);
  dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: id }));
}

// the custom theme changed, worn at once
export function setCustom(c) {
  const o = cleanCustom(c);
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(o)); } catch {}
  setPalette('custom');
  return o;
}

// the stored pick put up again: another tab's, or the user's settings arriving from the mesh
export function themeFromStorage() {
  const id = stored();
  apply(id);
  dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: id }));
}

addEventListener('storage', (e) => { if (e.key === KEY || e.key === CUSTOM_KEY) themeFromStorage(); });
apply(stored());
