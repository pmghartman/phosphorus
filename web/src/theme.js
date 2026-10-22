// the color themes, phosphorus wide: the desktop, every app and Sulfur alike,
// each with its dark and light; set before paint by the page's head, kept per browser

export const PALETTES = [
  { id: 'phosphorus', label: 'phosphorus', about: 'the mesh’s own purple, square and monospaced' },
  { id: 'vscode', label: 'vs code', about: 'dark modern and light modern' },
  { id: 'medieval', label: 'medieval', about: 'parchment, oak and gilt' },
];
const KEY = 'phosphorus-palette';
export const PALETTE_EVENT = 'phosphorus-palette';

// the page's palette, its default the page's own (the desktop phosphorus, Sulfur alone vs code)
export const paletteNow = () => document.documentElement.dataset.palette || 'phosphorus';

export function setPalette(id) {
  if (!PALETTES.some((p) => p.id === id)) return;
  document.documentElement.dataset.palette = id;
  try { localStorage.setItem(KEY, id); } catch {}
  dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: id }));
}

// another tab's pick taken here too
addEventListener('storage', (e) => {
  if (e.key !== KEY || !PALETTES.some((p) => p.id === e.newValue)) return;
  document.documentElement.dataset.palette = e.newValue;
  dispatchEvent(new CustomEvent(PALETTE_EVENT, { detail: e.newValue }));
});
