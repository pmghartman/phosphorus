import test from 'node:test';
import assert from 'node:assert/strict';
import { bracketPair, enclosingPair, outdentFor, partnerOf } from '../src/sulfur/brackets.js';
import { selectionRanges, expandSelection } from '../src/sulfur/smart-select.js';
import { parser } from '../.vendor/node_modules/@lezer/javascript/dist/index.js';

test('a bracket beside the caret pairs with its partner, nesting counted', () => {
  const text = 'f(a, [b, (c)], {d: 1})';
  assert.deepEqual(bracketPair(text, 1), { open: 1, close: 21 });
  assert.deepEqual(bracketPair(text, 22), { open: 1, close: 21 });
  assert.deepEqual(bracketPair(text, 5), { open: 5, close: 12 });
  assert.equal(bracketPair(text, 3), null);
  assert.equal(partnerOf('((', 0), -1);
});

test('brackets in strings and comments are skipped', () => {
  const text = 'f("(", x) // )';
  const strings = new Set([2, 3, 4]);
  const code = (i) => !strings.has(i) && i < 10;
  assert.deepEqual(bracketPair(text, 1, code), { open: 1, close: 8 });
});

test('Go to Bracket from inside a pair finds the innermost', () => {
  const text = 'a { b ( c ) d }';
  assert.deepEqual(enclosingPair(text, 12), { open: 2, close: 14 });
  assert.deepEqual(enclosingPair(text, 8), { open: 6, close: 10 });
  assert.equal(enclosingPair(text, 1), null);
});

test('a closer typed on a blank line takes its opener\'s indentation', () => {
  const text = 'if (x) {\n  y();\n    ';
  assert.deepEqual(outdentFor(text, text.length, '}'), { from: 16, to: text.length, indent: '' });
  const nested = '  f([\n    1,\n    ';
  assert.deepEqual(outdentFor(nested, nested.length, ']'), { from: 13, to: nested.length, indent: '  ' });
  assert.equal(outdentFor('{\n  x }', 7, '}'), null);
  assert.equal(outdentFor('{\n', 2, '}'), null);
});

test('smart select grows word, string inside, string, call, line, document', () => {
  const text = 'let x = foo("hello world", 2);\nnext();';
  const tree = parser.parse(text);
  const at = text.indexOf('world') + 2;
  const seen = [];
  let [a, b] = [at, at];
  for (let r = expandSelection(text, a, b, tree); r; r = expandSelection(text, a, b, tree)) { seen.push(text.slice(...r)); [a, b] = r; }
  assert.equal(seen[0], 'world');
  assert.ok(seen.includes('hello world'));
  assert.ok(seen.includes('"hello world"'));
  assert.ok(seen.includes('"hello world", 2'));
  assert.ok(seen.includes('let x = foo("hello world", 2);'));
  assert.equal(seen.at(-1), text);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].length > seen[i - 1].length);
});

test('smart select without a tree still walks word, line and document', () => {
  const text = '  alpha beta\ngamma';
  assert.deepEqual(selectionRanges(text, 4, 4).map((r) => text.slice(...r)), ['alpha', 'alpha beta', '  alpha beta\n', text]);
});

import { toggleLineComment, toggleBlockComment, docCommentEnter, blockCommentFor } from '../src/sulfur/comments.js';

test('line comments line up at the shallowest indentation and come off again', () => {
  const text = 'a\n  if (x) {\n    y();\n  }\n';
  const on = toggleLineComment(text, 2, 25, '//');
  assert.equal(on.text, '  // if (x) {\n  //   y();\n  // }');
  const commented = text.slice(0, on.from) + on.text + text.slice(on.to);
  const off = toggleLineComment(commented, 2, 2 + on.text.length, '//');
  assert.equal(commented.slice(0, off.from) + off.text + commented.slice(off.to), text);
});

test('block comments wrap and unwrap the selection, or the line with none', () => {
  const css = 'a { color: red; }';
  const wrapped = toggleBlockComment(css, 4, 15, blockCommentFor('css'));
  assert.equal(wrapped.text, '/* color: red; */');
  const next = css.slice(0, wrapped.from) + wrapped.text + css.slice(wrapped.to);
  const back = toggleBlockComment(next, ...wrapped.select, ['/*', '*/']);
  assert.equal(next.slice(0, back.from) + back.text + next.slice(back.to), css);
  const line = toggleBlockComment('  <b>x</b>\n', 4, 4, blockCommentFor('xml'));
  assert.deepEqual([line.from, line.to, line.text], [2, 10, '<!-- <b>x</b> -->']);
});

test('Enter after /** opens a doc comment; on a * line the * carries on', () => {
  assert.deepEqual(docCommentEnter('  /**', 5, 'javascript'), { text: '\n   * \n   */', caret: 6 });
  const inside = '/**\n * one';
  assert.deepEqual(docCommentEnter(inside, inside.length, 'javascript'), { text: '\n * ', caret: 4 });
  assert.equal(docCommentEnter('x * y', 5, 'javascript'), null);
  assert.equal(docCommentEnter('/**', 3, 'python'), null);
  assert.deepEqual(docCommentEnter('/**\n */', 3, 'go'), { text: '\n * ', caret: 4 });
});

import { saveEdits } from '../src/sulfur/formatting.js';
const applyEdits = (text, edits) => [...edits].reverse().reduce((t, e) => t.slice(0, e.from) + e.text + t.slice(e.to), text);

test('saving trims trailing whitespace, settles the final newlines, keeps markdown breaks', () => {
  assert.equal(applyEdits('a  \nb\t\nc ', saveEdits('a  \nb\t\nc ', { trim: true })), 'a\nb\nc');
  assert.equal(applyEdits('x', saveEdits('x', { finalNewline: true })), 'x\n');
  assert.deepEqual(saveEdits('x\n', { finalNewline: true }), []);
  assert.equal(applyEdits('x\n\n\n', saveEdits('x\n\n\n', { trimFinal: true })), 'x\n');
  assert.equal(applyEdits('one  \ntwo   \n', saveEdits('one  \ntwo   \n', { trim: true, keepMarkdownBreaks: true })), 'one  \ntwo\n');
  assert.deepEqual(saveEdits('', { finalNewline: true }), []);
  assert.equal(applyEdits('a \n\n  \n', saveEdits('a \n\n  \n', { trim: true, trimFinal: true })), 'a\n');
});

test('Enter after /** with code after carries it onto a * line, and opens /** */ in two', () => {
  assert.deepEqual(docCommentEnter('/** see below', 3, 'javascript'), { text: '\n * ', caret: 4 });
  const one = '  /** */';
  assert.deepEqual(docCommentEnter(one, 5, 'typescript'), { text: '\n   * \n  ', caret: 6 });
});
