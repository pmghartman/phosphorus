// --- themes -----------------------------------------------------------------

// the browser's scheme unless one is picked, picking the browser's own drops
// the override, applied before paint by index.html
import { appCall } from './apps.ts';
import { PALETTE_EVENT } from './theme.ts';
import { svgEl } from './dom.ts';

export const THEMES = ['dark', 'light', 'oled'];
export const systemLight = matchMedia('(prefers-color-scheme: light)');

export const currentTheme = () => document.documentElement.dataset.theme || 'dark';

// dark a filled moon, light a sun, oled a hollow thin moon
const SUN = 'M8 1v1.8M8 13.2V15M1 8h1.8M13.2 8H15M3 3l1.3 1.3M11.7 11.7L13 13M3 13l1.3-1.3M11.7 4.3L13 3';
const MOON = 'M13.5 10A6 6 0 0 1 6 2.5a6 6 0 1 0 7.5 7.5z';
export function themeIcon(theme: string): SVGSVGElement {
  const svg = svgEl('svg', { viewBox: '0 0 16 16', class: `theme-icon ${theme}`, 'aria-hidden': 'true' });
  if (theme === 'light') { svg.append(svgEl('circle', { cx: 8, cy: 8, r: 3 }), svgEl('path', { d: SUN })); }
  else svg.appendChild(svgEl('path', { d: MOON }));
  return svg;
}

export function applyTheme(theme: string): void {
  if (theme === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  // Safari's bars tinted the page's own background
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.body || document.documentElement).getPropertyValue('--bg').trim() || '#141414');
  appCall('terminal', false, (m) => m.termsRetheme());
}

function themePick(): string | null {
  try { return localStorage.getItem('phosphorus-theme'); } catch { return null; }
}

export function setTheme(theme: string): void {
  // a cross-fade for the switch only, never for ordinary hovers
  document.documentElement.classList.add('theme-fade');
  setTimeout(() => document.documentElement.classList.remove('theme-fade'), 350);
  try {
    if (theme === (systemLight.matches ? 'light' : 'dark')) localStorage.removeItem('phosphorus-theme');
    else localStorage.setItem('phosphorus-theme', theme);
  } catch {}
  applyTheme(theme);
}

systemLight.addEventListener('change', (e) => { if (!themePick()) applyTheme(e.matches ? 'light' : 'dark'); });
// a new color theme: the bar's color and the terminals' with it
addEventListener(PALETTE_EVENT, () => applyTheme(currentTheme()));
applyTheme(currentTheme());
