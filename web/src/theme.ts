// the themes, phosphorus wide: the desktop and every app, each with its dark,
// light and oled. Their tokens are the theme library's (packages/theme/themes.json), built into
// style.css; here the pick, a custom theme over any of them, and what the page's head needs to
// put them up before paint. Kept per user across the mesh with the rest of their settings.
import type { LibraryData, Theme } from '@phosphorus/theme';
import RAW from '../../packages/theme/themes.json';
import { setIconSet } from './icons.ts';

const LIB = RAW as unknown as LibraryData;

const KEY = 'phosphorus-palette';
const CUSTOM_KEY = 'phosphorus-theme-custom';
// what the head script sets before paint: the look, its flags and layout, a custom theme's css
const APPLIED_KEY = 'phosphorus-theme-applied';
export const PALETTE_EVENT = 'phosphorus-palette';

// one entry of the picker: a built-in theme, or the custom one
export interface Palette { id: string; label: string; about?: string; look: string; round?: boolean; sans?: boolean; swatch?: [string, string]; custom?: boolean }
// the layout worn, every key set
export interface LayoutNow { bar: string; barStyle: string; menubar: string; btns: string; btnStyle: string; title: string; density: string; autohide: string; labels: string; items: string[]; [k: string]: string | string[] }
// the custom theme's config, every value concrete
export interface CustomConfig { base: string; accent: string; font: string; mono: string; corners: string; shadows: string; desk: string; layout: LayoutNow }

const tokensOf = (t: Theme) => ({ ...LIB.base.dark, ...t.dark });
export const PALETTES: Palette[] = [
  ...LIB.themes.map((t): Palette => ({
    id: t.id, label: t.label, about: t.about, look: t.look, round: !!t.round, sans: !!t.sans,
    swatch: [tokensOf(t)['--accent']!, tokensOf(t)['--bg']!],
  })),
  { id: 'custom', label: 'custom', about: 'yours: a theme to start from, with your accent, type, corners, shadows and layout', look: '', custom: true },
];
const LOOKS = [...new Set(LIB.themes.map((t) => t.look))];
const builtIn = (id: string | undefined) => LIB.themes.find((t) => t.id === id);

// --- a custom theme: a built-in one to start from, any of these over it, '' the theme's own ------

export const CUSTOM_FONTS: Record<string, string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", system-ui, "Helvetica Neue", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
};
export const CUSTOM_MONOS: Record<string, string> = {
  system: 'ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  cascadia: '"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace',
  jetbrains: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace',
};
export const CUSTOM_SHADOWS: Record<string, Record<string, string>> = {
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
export const LAYOUT_CHOICES: Record<string, string[]> = {
  bar: ['bottom', 'top', 'left', 'right'],
  barStyle: ['panel', 'dock', 'full', 'line'],
  menubar: ['off', 'top', 'bottom'],
  btns: ['right', 'left'],
  btnStyle: ['glyphs', 'lights', 'caption'],
  title: ['left', 'center'],
  density: ['normal', 'compact', 'roomy'],
  autohide: ['off', 'on'],
  // what the bar's windows and the menu bar's app show: an icon, a title, both
  labels: ['both', 'icons', 'titles'],
};
export const BAR_ITEMS = ['hosts', 'agent', 'bell', 'clock', 'profile'];
// a built-in theme's own whole config, every value concrete: what the custom theme starts as and
// what a reset sets it to
export function themeConfig(id: string): CustomConfig {
  const t = builtIn(id) || builtIn('phosphorus')!;
  const tok = tokensOf(t);
  const px = parseFloat(String(tok['--r-pop'] || ''));
  const corners = Number.isFinite(px) ? CUSTOM_CORNERS.reduce((a, b) => (Math.abs(Number(b) - px) < Math.abs(Number(a) - px) ? b : a)) : t.round ? '8' : '0';
  return {
    base: t.id,
    accent: hex(tok['--accent']) || '#9f81cf',
    font: t.sans ? 'system' : 'mono',
    mono: t.id === 'win11' ? 'cascadia' : 'system',
    corners: String(corners),
    shadows: tok['--lift'] === 'none' ? 'none' : 'soft',
    desk: hex(tok['--desk']) || hex(tok['--bg']) || '#141414',
    layout: themeLayout(t.id),
  };
}

// a layout made whole: each key valid, the profile never hidden (it opens the settings)
function cleanLayout(l: unknown, under?: LayoutNow): LayoutNow {
  const o = {} as LayoutNow;
  const src = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
  for (const [k, vals] of Object.entries(LAYOUT_CHOICES)) o[k] = vals.includes(src[k] as string) ? (src[k] as string) : (under?.[k] as string) || vals[0]!;
  const items = Array.isArray(src.items) ? (src.items as string[]) : under?.items || BAR_ITEMS;
  o.items = [...new Set(items.filter((i) => BAR_ITEMS.includes(i)))];
  if (!o.items.includes('profile')) o.items.push('profile');
  return o;
}
// a built-in theme's own layout, over the base's
export const themeLayout = (id: string): LayoutNow => cleanLayout({ ...LIB.base.layout, ...(builtIn(id) || builtIn('phosphorus')!).layout });

const hex = (v: unknown) => (/^#[0-9a-f]{6}$/i.test((v as string) || '') ? (v as string).toLowerCase() : '');
// a stored custom theme made whole and safe: unknown keys and values dropped, anything missing (or
// left blank by an older save) the theme it was last reset to, a bad one the default's
function cleanCustom(c: unknown): CustomConfig {
  const src = (c && typeof c === 'object' ? c : {}) as Partial<Record<keyof CustomConfig, unknown>>;
  const own = themeConfig(builtIn(src.base as string) ? (src.base as string) : 'phosphorus');
  return {
    base: own.base,
    accent: hex(src.accent) || own.accent,
    desk: hex(src.desk) || own.desk,
    font: CUSTOM_FONTS[src.font as string] ? (src.font as string) : own.font,
    mono: CUSTOM_MONOS[src.mono as string] ? (src.mono as string) : own.mono,
    corners: CUSTOM_CORNERS.includes(String(src.corners)) ? String(src.corners) : own.corners,
    shadows: CUSTOM_SHADOWS[src.shadows as string] ? (src.shadows as string) : own.shadows,
    layout: cleanLayout(src.layout, own.layout),
  };
}

export function customNow(): CustomConfig {
  try { return cleanCustom(JSON.parse(localStorage.getItem(CUSTOM_KEY) || 'null')); } catch { return cleanCustom(null); }
}

// the custom theme's overrides as rules over the library's (theirs at a single class's weight):
// only what differs from the theme it was last reset to, so the rest keeps its light and dark
function customCss(c: CustomConfig): string {
  const own = themeConfig(c.base);
  const page: Record<string, string> = {};
  if (c.accent !== own.accent) {
    Object.assign(page, { '--accent': c.accent, '--mesh-self': c.accent, '--glyph-purple': c.accent });
  }
  if (c.font !== own.font) { page['--font'] = CUSTOM_FONTS[c.font]!; }
  if (c.mono !== own.mono) page['--mono'] = CUSTOM_MONOS[c.mono]!;
  if (c.corners !== own.corners) {
    const n = Number(c.corners);
    Object.assign(page, { '--r-ctl': `${Math.round(n * 0.6)}px`, '--r-pop': `${n}px`, '--r-card': `${n}px`, '--r-win': `${n ? n + 2 : 0}px` });
  }
  if (c.shadows !== own.shadows) Object.assign(page, CUSTOM_SHADOWS[c.shadows]);
  if (c.desk !== own.desk) page['--desk'] = c.desk;
  const rule = (sel: string, t: Record<string, string>) => (Object.keys(t).length ? `${sel} { ${Object.entries(t).map(([k, v]) => `${k}: ${v};`).join(' ')} }\n` : '');
  return rule(':root[data-custom]', page);
}

// --- the pick ----------------------------------------------------------------------------------

const valid = (id: string | null | undefined) => id === 'custom' || !!builtIn(id!);
const stored = (): string => { try { const v = localStorage.getItem(KEY); return valid(v) ? v! : 'phosphorus'; } catch { return 'phosphorus'; } };

// the theme picked, custom included; lookNow the built-in one whose structure the page wears
export const paletteNow = (): string => document.documentElement.dataset.themeId || stored();
export const lookNow = (): string => builtIn(document.documentElement.dataset.palette)?.look || 'phosphorus';
export const LOOK_IDS = LOOKS;
let layout = themeLayout('phosphorus');
// the layout worn: the theme's, a custom one's choices over it
export const layoutNow = (): LayoutNow => layout;

function apply(id: string) {
  const r = document.documentElement;
  const c = id === 'custom' ? customNow() : null;
  const t = builtIn(c ? c.base : id) || builtIn('phosphorus')!;
  const round = c ? c.corners !== '0' : !!t.round;
  const sans = c ? c.font !== 'mono' : !!t.sans;
  const css = c ? customCss(c) : '';
  layout = cleanLayout(c?.layout, themeLayout(t.id));
  // each as data-l-*: barStyle as data-l-bar-style
  const attrs = Object.fromEntries(Object.keys(LAYOUT_CHOICES).map((k) => [k, layout[k] as string]));
  for (const [k, v] of Object.entries(attrs)) r.dataset[`l${k[0]!.toUpperCase()}${k.slice(1)}`] = v;
  r.dataset.palette = t.id;
  setIconSet(t.icons);
  r.dataset.themeId = id;
  // the phosphorus and cli looks draw the mark as ascii art
  if (t.id === 'phosphorus' || t.id === 'cli') r.style.setProperty('--mark', 'url(/phosphorus-ascii.svg?v=1)');
  else r.style.removeProperty('--mark');
  r.toggleAttribute('data-round', round);
  r.toggleAttribute('data-sans', sans);
  r.toggleAttribute('data-custom', !!c);
  r.toggleAttribute('data-custom-desk', !!c && c.desk !== themeConfig(c.base).desk);
  let tag = document.getElementById('phosphorus-custom');
  if (css && !tag) { tag = Object.assign(document.createElement('style'), { id: 'phosphorus-custom' }); document.head.append(tag); }
  if (tag) tag.textContent = css;
  try { localStorage.setItem(APPLIED_KEY, JSON.stringify({ id, look: t.id, round, sans, desk: !!c && c.desk !== themeConfig(c.base).desk, css, layout: attrs })); } catch {}
}

export function setPalette(id: string): void {
  if (!valid(id)) return;
  try { localStorage.setItem(KEY, id); } catch {}
  apply(id);
  dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: id }));
}

// the custom theme changed, worn at once
export function setCustom(c: unknown): CustomConfig {
  const o = cleanCustom(c);
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(o)); } catch {}
  setPalette('custom');
  return o;
}

// the stored pick put up again: another tab's, or the user's settings arriving from the mesh
export function themeFromStorage(): void {
  const id = stored();
  apply(id);
  dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: id }));
}

addEventListener('storage', (e) => { const { key } = e as StorageEvent; if (key === KEY || key === CUSTOM_KEY) themeFromStorage(); });
apply(stored());
