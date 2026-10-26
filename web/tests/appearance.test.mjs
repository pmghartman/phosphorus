import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const library = JSON.parse(readFileSync(new URL('../../internal/theme/themes.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/theme.js', import.meta.url), 'utf8');
const families = ['catppuccin', 'dracula', 'nord', 'tokyo-night'];
const contrast = (a, b) => {
  const luminance = (hex) => hex.slice(1).match(/../g).map((v) => parseInt(v, 16) / 255)
    .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

test('new theme families have readable dark, light and OLED surfaces and complete syntax tokens', () => {
  for (const id of families) {
    const theme = library.themes.find((t) => t.id === id);
    assert.ok(theme, id);
    assert.equal(theme.look, 'vscode');
    for (const mode of ['dark', 'light', 'oled']) {
      const page = { ...library.base.dark, ...theme.dark, ...(mode === 'dark' ? {} : library.base[mode]), ...(mode === 'dark' ? {} : theme[mode]) };
      assert.ok(contrast(page['--fg'], page['--bg']) >= 7, `${id} ${mode} text`);
      assert.ok(contrast(page['--muted'], page['--bg']) >= 4.5, `${id} ${mode} secondary text`);
      assert.ok(contrast(page['--accent'], page['--bg']) >= 4.5, `${id} ${mode} accent`);
      if (mode === 'oled') assert.equal(page['--bg'], '#000000');
      for (const token of ['--hl-kw', '--hl-str', '--hl-num', '--hl-title', '--hl-type', '--hl-cmt']) assert.ok(theme.ide.dark[token], `${id} ${token}`);
    }
  }
});

test('palette IDs keep their own colors while sharing the VS Code structural look', () => {
  const attributes = new Set(), stored = new Map();
  const root = { dataset: {}, style: { setProperty() {}, removeProperty() {} }, toggleAttribute: (name, on) => on ? attributes.add(name) : attributes.delete(name) };
  const context = { LIB: library, setIconSet() {}, document: { documentElement: root, getElementById: () => null },
    localStorage: { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) }, addEventListener() {}, dispatchEvent() {}, CustomEvent: class {} };
  vm.createContext(context);
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/\bexport /g, ''), context);
  for (const id of families) {
    context.setPalette(id);
    assert.equal(root.dataset.palette, id);
    assert.equal(vm.runInContext('lookNow()', context), 'vscode');
    assert.equal(vm.runInContext('paletteNow()', context), id);
    assert.ok(attributes.has('data-round'));
    assert.ok(attributes.has('data-sans'));
  }
  assert.equal(vm.runInContext('LOOK_IDS.filter(id => id === "vscode").length', context), 1);
});

test('OLED applies before first paint even on a light operating system', () => {
  const html = readFileSync(new URL('../sulfur.html', import.meta.url), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const root = { dataset: {}, toggleAttribute() {} };
  vm.runInNewContext(script, { document: { documentElement: root }, localStorage: { getItem: (key) => key === 'sulfur-appearance' ? 'oled' : null }, matchMedia: () => ({ matches: true }) });
  assert.equal(root.dataset.theme, 'oled');
});
