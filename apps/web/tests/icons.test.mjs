import assert from 'node:assert/strict';
import test from 'node:test';

const { default: DEFAULT } = await import('../src/lib/icons/default.ts');
const { iconGroup } = await import('../src/lib/icons.ts');

test('every group has glyphs', () => {
  for (const g of ['files', 'glyphs', 'ui']) assert.ok(Object.keys(iconGroup(g)).length > 5, g);
});

test('glyphs are path data on the 16 grid, aliases kept', () => {
  const files = iconGroup('files');
  const glyphs = iconGroup('glyphs');
  const ui = iconGroup('ui');
  for (const d of [...Object.values(files), ...Object.values(glyphs), ...Object.values(ui)])
    assert.match(d, /^M[\d.\-\s,a-zA-Z]+$/);
  assert.equal(glyphs.doc, files.file);
  assert.equal(glyphs.files, files.folder);
});

test('a group reads the default set', () => {
  const g = iconGroup('glyphs');
  assert.equal(g.terminal, DEFAULT.glyphs.terminal);
  assert.equal(g.nosuch, undefined);
  assert.ok('gear' in g);
  assert.ok(Object.keys(g).includes('bell'));
});
