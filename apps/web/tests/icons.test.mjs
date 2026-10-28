import test from 'node:test';
import assert from 'node:assert/strict';

const style = new Map();
globalThis.document = { documentElement: { style: { setProperty: (k, v) => style.set(k, v) } } };
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const events = [];
globalThis.dispatchEvent = (e) => events.push(e);

const { ICON_SETS, iconGroup, setIconSet, iconSetNow } = await import('../src/lib/icons.ts');

test('the default set is the only one, and every group has glyphs', () => {
  assert.deepEqual(Object.keys(ICON_SETS), ['default']);
  for (const g of ['files', 'glyphs', 'ui']) assert.ok(Object.keys(ICON_SETS.default[g]).length > 5, g);
});

test('glyphs are path data on the 16 grid, aliases kept', () => {
  const { files, glyphs, ui } = ICON_SETS.default;
  for (const d of [...Object.values(files), ...Object.values(glyphs), ...Object.values(ui)]) assert.match(d, /^M[\d.\-\s,a-zA-Z]+$/);
  assert.equal(glyphs.doc, files.file);
  assert.equal(glyphs.files, files.folder);
});

test('a group reads the set worn, the default behind it', () => {
  const g = iconGroup('glyphs');
  assert.equal(g.terminal, ICON_SETS.default.glyphs.terminal);
  assert.equal(g.nosuch, undefined);
  assert.ok('gear' in g);
  assert.ok(Object.keys(g).includes('bell'));
  ICON_SETS.test = { id: 'test', stroke: { width: 2, cap: 'square', join: 'miter' }, files: {}, glyphs: { terminal: 'M0 0' }, ui: {} };
  setIconSet('test');
  assert.equal(iconSetNow(), 'test');
  assert.equal(g.terminal, 'M0 0');
  assert.equal(g.bell, ICON_SETS.default.glyphs.bell);
  assert.equal(style.get('--ic-w'), '2');
  assert.equal(style.get('--ic-cap'), 'square');
  assert.equal(events.at(-1).detail, 'test');
});

test('an unknown set is the default', () => {
  setIconSet('nosuch');
  assert.equal(iconSetNow(), 'default');
  assert.equal(style.get('--ic-w'), '1.3');
  assert.equal(iconGroup('ui').close, ICON_SETS.default.ui.close);
});
