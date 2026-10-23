import test from 'node:test';
import assert from 'node:assert/strict';
import { documentSymbols, moveBookmarks, sidebarRight, runTargetName } from '../src/sulfur/navigation.js';

const range = (line, from, to) => ({ start: { line, character: from }, end: { line, character: to } });

test('layout defaults preserve the activity layout and explicit pane choices across modes', () => {
  assert.equal(sidebarRight('default', 'auto'), false);
  assert.equal(sidebarRight('visualStudio', 'auto'), true);
  for (const mode of ['default', 'visualStudio']) {
    assert.equal(sidebarRight(mode, 'left'), false);
    assert.equal(sidebarRight(mode, 'right'), true);
  }
});

test('run labels follow the active target and clear stale targets during discovery', () => {
  const tab = { ed: {}, title: 'App.cs' };
  assert.equal(runTargetName({ item: { label: 'Claymore.exe' } }, tab), 'Claymore.exe');
  assert.equal(runTargetName({ item: { executable: 'D:\\out\\Release\\Game.exe' } }, tab), 'Game.exe');
  assert.equal(runTargetName({ pending: true, item: { label: 'old.exe' } }, tab), 'Finding target…');
  assert.equal(runTargetName({ project: true }, tab), 'Select startup target…');
  assert.equal(runTargetName(null, tab), 'App.cs');
});

test('semantic document outlines retain Roslyn declaration selections, scopes and owners', () => {
  const text = '\uFEFFclass Player\r\n{\r\n  void Spawn() {}\r\n}';
  const symbols = documentSymbols(text, [{ name: 'Player', kind: 5, range: { start: { line: 0, character: 1 }, end: { line: 3, character: 1 } }, selectionRange: range(0, 7, 13), children: [{ name: 'Spawn', detail: 'void Spawn()', kind: 6, range: range(2, 2, 17), selectionRange: range(2, 7, 12) }] }], 'file:///project/App.cs');
  assert.equal(symbols.length, 2);
  assert.equal(text.slice(symbols[0].from, symbols[0].to), 'Player');
  assert.equal(text.slice(symbols[1].from, symbols[1].to), 'Spawn');
  assert.equal(symbols[1].owner, symbols[0]);
  assert.equal(symbols[1].detail, 'void Spawn()');
});

test('flat symbol responses exclude other documents and ignore malformed UTF-16 ranges', () => {
  const text = 'class Player {}';
  const symbols = documentSymbols(text, [
    { name: 'Player', kind: 5, location: { uri: 'file:///project/App.cs', range: range(0, 6, 12) } },
    { name: 'Other', kind: 5, location: { uri: 'file:///other.cs', range: range(0, 0, 5) } },
    { name: 'Invalid', kind: 5, range: range(0, 0, 99) },
  ], 'file:///project/App.cs');
  assert.deepEqual(symbols.map((s) => s.name), ['Player']);
});

test('bookmarks move with inserted lines, undo and deletion and remain on line starts', () => {
  const original = 'first\nsecond\nthird';
  const bookmarks = [{ offset: 6, line: 2 }, { offset: 13, line: 3 }];
  const edited = 'new\n' + original;
  moveBookmarks(bookmarks, original, edited);
  assert.deepEqual(bookmarks, [{ offset: 10, line: 3 }, { offset: 17, line: 4 }]);
  moveBookmarks(bookmarks, edited, original);
  assert.deepEqual(bookmarks, [{ offset: 6, line: 2 }, { offset: 13, line: 3 }]);
  moveBookmarks(bookmarks, original, 'first\nthird');
  assert.ok(bookmarks.every((b) => b.line === 2 && b.offset === 6));
  const boundary = [{ offset: 1, line: 2 }];
  moveBookmarks(boundary, '\nusing Engine;', '\n\nusing Engine;');
  assert.deepEqual(boundary, [{ offset: 2, line: 3 }]);
  moveBookmarks(boundary, '\n\nusing Engine;', '\nusing Engine;');
  assert.deepEqual(boundary, [{ offset: 1, line: 2 }]);
});
