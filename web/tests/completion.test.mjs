import test from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, rankCompletions, wordCompletions, expandSnippet, wordBefore, kindOf, inCommentOrString, sameCompletionWord } from '../src/sulfur/completion.js';
import { reindent } from '../src/sulfur/format.js';
import { htmlLines, patchHighlight } from '../src/highlight-patch.js';
import { opApply, opEdits } from '../src/text-operations.js';

test('fuzzy matching starts at a word boundary and follows camel case, as VS Code', () => {
  assert.deepEqual(fuzzyScore('wl', 'WriteLine').matches, [0, 5]);
  assert.ok(fuzzyScore('hp', 'HealthPoints'));
  assert.ok(fuzzyScore('point', 'HealthPoints'));
  assert.equal(fuzzyScore('ine', 'WriteLine'), null);
  assert.equal(fuzzyScore('xyz', 'WriteLine'), null);
  assert.ok(fuzzyScore('Heal', 'HealthPoints').score > fuzzyScore('Heal', 'TakeHealth').score);
});

test('ranking puts the closest match first and keeps the provider order for ties', () => {
  const items = [{ label: 'TakeDamage' }, { label: 'takeDamage' }, { label: 'toDate', sortText: 'b' }, { label: 'tally', sortText: 'a' }];
  assert.equal(rankCompletions(items, 'takeD')[0].item.label, 'takeDamage');
  assert.deepEqual(rankCompletions(items, 't').map((x) => x.item.label), ['tally', 'toDate', 'takeDamage', 'TakeDamage']);
});

test('word suggestions come from every open document and leave out the word being typed', () => {
  const current = 'int playerHealth = 1;\nplay';
  const words = wordCompletions(['var playerName;'], current, current.length).map((x) => x.label);
  assert.ok(words.includes('playerHealth') && words.includes('playerName'));
  assert.ok(!words.includes('play'));
  assert.equal(wordBefore(current, current.length), 'play');
});

test('cached completions allow continued typing but refuse moved carets and collaborator edits anywhere else', () => {
  const was = 'const value = re;\nother();';
  const caret = was.indexOf(';'), from = caret - 2;
  assert.equal(sameCompletionWord(was, caret, from, was.replace('re;', 'read;'), caret + 2), true);
  assert.equal(sameCompletionWord(was, caret, from, was.replace('other', 'peer'), caret), false);
  assert.equal(sameCompletionWord(was, caret, from, '// peer\n' + was, caret + 8), false);
  assert.equal(sameCompletionWord(was, caret, from, was, caret - 1), false);
  assert.equal(sameCompletionWord(was, caret, from, was.replace('re;', 're();'), caret + 2), false);
});

test('snippets expand to their text with the first tab stop selected', () => {
  assert.deepEqual(expandSnippet('for (${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}'), { text: 'for (i = 0; i < n; i++) {\n\t\n}', selection: [5, 6] });
  assert.deepEqual(expandSnippet('log($0)'), { text: 'log()', selection: [4, 4] });
  assert.deepEqual(expandSnippet('${1|public,private|} \\$x $y'), { text: 'public $x ', selection: [0, 6] });
  assert.deepEqual(expandSnippet('done'), { text: 'done', selection: [4, 4] });
  assert.deepEqual(expandSnippet('${1:name} = $1 + ${1};'), { text: 'name = name + name;', selection: [0, 4] });
  assert.equal(kindOf({ kind: 2 }).kind, 'method');
});

const format = (text, from, to, o) => opApply(text, opEdits(text, reindent(text, from, to, o)));

test('format reindents brace languages by nesting and leaves strings and comments alone', () => {
  const messy = 'const messy = {a:1,\n      b: [1,2,\n  3],\n        c: function() { return "{"; }\n};\n';
  assert.equal(format(messy, 0, messy.length, { ext: 'js', unit: '  ' }), 'const messy = {a:1,\n  b: [1,2,\n    3],\n  c: function() { return "{"; }\n};\n');
  const cs = 'class A\n{\nvoid F()\n{\n/* {\n  keep */\nif (x) {   \ny();\n}\n}\n}';
  assert.equal(format(cs, 0, 0, { ext: 'cs', unit: '    ' }), 'class A\n{\n    void F()\n    {\n        /* {\n  keep */\n        if (x) {\n            y();\n        }\n    }\n}');
});

test('format of a selection touches only its lines, from the nesting before it', () => {
  const text = 'fn main() {\n    let a = 1;\nlet b = 2;  \n}\n';
  const from = text.indexOf('let b');
  assert.equal(format(text, from, from + 3, { ext: 'rs', unit: '    ' }), 'fn main() {\n    let a = 1;\n    let b = 2;\n}\n');
  assert.equal(format('x = 1  \n  y = 2\n', 0, 0, { ext: 'py', unit: '    ' }), 'x = 1\n  y = 2\n');
  assert.equal(format('{"a":[1,2]}', 0, 0, { ext: 'json', unit: '  ' }), '{\n  "a": [\n    1,\n    2\n  ]\n}');
});

test('an old highlight is kept for the lines an edit left alone', () => {
  const html = '<span class="c">/* a\nb */</span>\n<span class="k">int</span> x;';
  assert.deepEqual(htmlLines(html), ['<span class="c">/* a</span>', '<span class="c">b */</span>', '<span class="k">int</span> x;']);
  const old = { text: '/* a\nb */\nint x;', html };
  assert.equal(patchHighlight(old, '/* a\nb */\nint xy;'), '<span class="c">/* a</span>\n<span class="c">b */</span>\nint xy;');
  assert.equal(patchHighlight(old, 'new <\n/* a\nb */\nint x;'), 'new &lt;\n<span class="c">/* a</span>\n<span class="c">b */</span>\n<span class="k">int</span> x;');
});

test('suggestions stay quiet in line comments and strings, read from the line itself', () => {
  const at = (s, ext) => inCommentOrString(s, s.length, ext);
  assert.equal(at('x = 1; // a He', 'cs'), true);
  assert.equal(at('var s = "He', 'cs'), true);
  assert.equal(at('var s = "a//b"; He', 'cs'), false);
  assert.equal(at('#region He', 'cs'), false);
  assert.equal(at('x = 1  # He', 'py'), true);
  assert.equal(at("print('it''s', He", 'py'), false);
  assert.equal(at('a\nint He', 'cs'), false);
});
