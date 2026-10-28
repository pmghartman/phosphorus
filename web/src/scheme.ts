// --- light or dark: the browser's own ('system') unless a mode is picked; index.html sets the
// pick before paint, the page's terminals and bars follow a switch
import { appCall } from './apps.ts';
import { svgEl } from './dom.ts';
import { PALETTE_EVENT } from './theme.ts';

const KEY = 'phosphorus-theme';
export const MODES = ['system', 'dark', 'light', 'oled'];
export const systemLight = matchMedia('(prefers-color-scheme: light)');
const systemMode = () => (systemLight.matches ? 'light' : 'dark');

// the mode worn: dark, light or oled
export const currentTheme = (): string => document.documentElement.dataset.theme || 'dark';
// the mode picked: system while none is
export function modePick(): string {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

// system a screen, dark a filled moon, light a sun, oled a hollow thin moon
const SUN = 'M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3 3l1.3 1.3M11.7 11.7L13 13M3 13l1.3-1.3M11.7 4.3L13 3';
const MOON = 'M13.5 10A6 6 0 0 1 6 2.5a6 6 0 1 0 7.5 7.5z';
const SCREEN = 'M1.5 2.5h13v8.5h-13zM5.5 13.5h5M8 11v2.5';
export function modeIcon(mode: string): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: `theme-icon ${mode}`, 'aria-hidden': 'true' });
  if (mode === 'light') svg.append(svgEl('circle', { cx: 8, cy: 8, r: 3 }), svgEl('path', { d: SUN }));
  else svg.appendChild(svgEl('path', { d: mode === 'system' ? SCREEN : MOON }));
  return svg;
}

export function applyTheme(theme: string): void {
  if (theme === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // Safari's bars tinted the page's own background
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.body || document.documentElement).getPropertyValue('--bg').trim() || '#141414');
  appCall('terminal', false, (m) => m.termsRetheme());
}

// a mode picked and worn; system drops the pick, the browser's own worn from then on
export function setTheme(mode: string): void {
  if (!MODES.includes(mode)) return;
  // a cross-fade for the switch only, never for ordinary hovers
  document.documentElement.classList.add('theme-fade');
  setTimeout(() => document.documentElement.classList.remove('theme-fade'), 350);
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {}
  applyTheme(mode === 'system' ? systemMode() : mode);
}

systemLight.addEventListener('change', () => { if (modePick() === 'system') applyTheme(systemMode()); });
// a new color theme: the bar's color and the terminals' with it
addEventListener(PALETTE_EVENT, () => applyTheme(currentTheme()));
applyTheme(currentTheme());
