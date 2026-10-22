import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorHistory } from '../src/editor-history.js';
import { opDiff } from '../src/text-operations.js';

test('animated agent replacements undo as one edit without losing earlier typing', () => {
  const history = new EditorHistory();
  history.record('hello', 'hello!', [5, 5], [6, 6], 'insertText', 0);
  history.record('hello!', '!', [6, 6], [1, 1], 'agent:1', 1);
  history.record('!', 'world!', [1, 1], [6, 6], 'agent:1', 20);
  let step = history.step('world!', [6, 6]);
  assert.equal(step.text, 'hello!');
  step = history.step(step.text, step.selection);
  assert.equal(step.text, 'hello');
  step = history.step(step.text, step.selection, true);
  assert.equal(step.text, 'hello!');
  step = history.step(step.text, step.selection, true);
  assert.equal(step.text, 'world!');
});

test('undo and redo preserve incoming collaborator text at shifted positions', () => {
  const history = new EditorHistory();
  history.record('cat', 'cats', [3, 3], [4, 4]);
  history.remote(opDiff('cats', 'two cats'));
  let step = history.step('two cats', [8, 8]);
  assert.equal(step.text, 'two cat');
  history.remote(opDiff('two cat', 'two cat!'));
  step = history.step('two cat!', [8, 8], true);
  assert.equal(step.text, 'two cats!');
});

test('separate agent replacements remain separate undo steps', () => {
  const history = new EditorHistory();
  history.record('a', 'ab', [1, 1], [2, 2], 'agent:remote:1');
  history.record('ab', 'abc', [2, 2], [3, 3], 'agent:remote:2');
  assert.equal(history.step('abc', [3, 3]).text, 'ab');
  assert.equal(history.step('ab', [2, 2]).text, 'a');
});

test('incoming changes rebase every undo level', () => {
  const history = new EditorHistory();
  history.record('a', 'ab', [1, 1], [2, 2]);
  history.record('ab', 'abc', [2, 2], [3, 3]);
  history.remote(['#', 3, '!']);
  let step = history.step('#abc!', [5, 5]);
  assert.equal(step.text, '#ab!');
  step = history.step(step.text, step.selection);
  assert.equal(step.text, '#a!');
});

test('a remote deletion of a local edit leaves earlier undo entries usable', () => {
  const history = new EditorHistory();
  history.record('a', 'ab', [1, 1], [2, 2]);
  history.record('ab', 'abc', [2, 2], [3, 3]);
  history.remote(opDiff('abc', 'ab'));
  assert.equal(history.step('ab', [2, 2]).text, 'a');
});

test('typing groups stop at caret moves, pauses and new local edits clear redo', () => {
  const history = new EditorHistory();
  history.record('', 'a', [0, 0], [1, 1], 'insertText', 0);
  history.record('a', 'ab', [1, 1], [2, 2], 'insertText', 50);
  history.record('ab', 'Xab', [0, 0], [1, 1], 'insertText', 100);
  assert.equal(history.step('Xab', [1, 1]).text, 'ab');
  assert.equal(history.step('ab', [2, 2]).text, '');
  history.record('', 'new', [0, 0], [3, 3]);
  assert.equal(history.step('new', [3, 3], true), null);
});
