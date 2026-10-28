// --- themes -----------------------------------------------------------------

// the browser's scheme unless one is picked, picking the browser's own drops
// the override, applied before paint by index.html
import { appCall } from './apps.ts';
import { PALETTE_EVENT } from './theme.ts';
import { dkAnchor, dkPopsClose, type Pop } from './desktop/taskbar.ts';

export const THEMES = ['dark', 'light', 'oled'];
const themeToggles = document.querySelectorAll<HTMLButtonElement>('.theme-toggle');
export const themeMenus = [...document.querySelectorAll<HTMLElement>('.theme-menu')];
export const systemLight = matchMedia('(prefers-color-scheme: light)');

export const currentTheme = () => document.documentElement.dataset.theme || 'dark';
export const openMenu = () => themeMenus.find((m) => !m.hidden);
export function closeMenus(): void { for (const m of themeMenus) m.hidden = true; }

export function applyTheme(theme: string): void {
  if (theme === 'dark') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  for (const b of themeToggles) {
    b.title = `theme: ${theme}`;
  }
  for (const li of document.querySelectorAll<HTMLElement>('.theme-menu li')) li.classList.toggle('current', li.dataset.theme === theme);
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

// each pick led by its button's own icon
export const THEME_ICON: Record<string, string> = { dark: 'moon', light: 'sun', oled: 'moon-thin' };

for (const menu of themeMenus) {
  const list = menu.querySelector('ul')!;
  const toggle = menu.parentElement!.querySelector('.theme-toggle')!;
  for (const theme of THEMES) {
    const li = document.createElement('li');
    li.append(toggle.querySelector(`.${THEME_ICON[theme]}`)!.cloneNode(true), theme);
    li.dataset.theme = theme;
    li.tabIndex = 0;
    li.addEventListener('click', () => { setTheme(theme); closeMenus(); });
    list.appendChild(li);
  }
  menu.addEventListener('click', (e) => e.stopPropagation());
}
for (const b of themeToggles) {
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = b.parentElement!.querySelector('.theme-menu') as Pop;
    const open = menu.hidden;
    dkPopsClose('theme');
    closeMenus();
    menu.hidden = !open;
    if (open && b.closest('.dk-bar')) { menu.classList.add('dk-pop'); dkAnchor(menu, b); }
  });
}
systemLight.addEventListener('change', (e) => { if (!themePick()) applyTheme(e.matches ? 'light' : 'dark'); });
// a new color theme: the bar's color and the terminals' with it
addEventListener(PALETTE_EVENT, () => applyTheme(currentTheme()));
applyTheme(currentTheme());
