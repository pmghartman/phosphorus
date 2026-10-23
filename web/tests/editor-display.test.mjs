import test from 'node:test';
import assert from 'node:assert/strict';
import { rebaseHighlightRanges, highlightRanges, rangesFromHighlight } from '../src/sulfur/semantic-tokens.js';
import { editorDecorations } from '../src/sulfur/editor-guides.js';

const starts = text => [0, ...Array.from(text.matchAll(/\n/g), m => m.index + 1)];
const token = (text, word, cls = 'hljs-type') => ({ from: text.indexOf(word), to: text.indexOf(word) + word.length, cls });
const words = (text, ranges) => ranges.map(r => text.slice(r.from, r.to));

test('typing and deleting within identifiers retain semantic color without whitening other symbols', () => {
  const before = 'class Player : ScriptComponent\n{ Entity entity; }';
  const ranges = ['Player', 'ScriptComponent', 'Entity'].map(w => token(before, w));
  for (const [after, expected] of [
    [before.replace('Player', 'Players'), ['Players', 'ScriptComponent', 'Entity']],
    [before.replace('Player', 'MyPlayer'), ['MyPlayer', 'ScriptComponent', 'Entity']],
    [before.replace('Player', 'Payer'), ['Payer', 'ScriptComponent', 'Entity']],
    [before.replace('Player', ''), ['ScriptComponent', 'Entity']],
    [before.replace('Player', 'Pl ayer'), ['ScriptComponent', 'Entity']],
    ['// 😀\n' + before, ['Player', 'ScriptComponent', 'Entity']],
  ]) assert.deepEqual(words(after, rebaseHighlightRanges(before, after, ranges)), expected);
});

test('new comments and strings take precedence over stale semantic classifications', () => {
  const text = '// Player';
  const lexical = [{ from: 0, to: text.length, cls: 'hljs-comment' }];
  const html = highlightRanges(text, lexical, [token(text, 'Player')]);
  assert.ok(!html.includes('hljs-type'));
  assert.equal(html.replaceAll(/<[^>]+>/g, ''), text);
  assert.equal(highlightRanges('Player', [], [token('Player', 'Player')]), '<span class="hljs-type">Player</span>');
  assert.equal(highlightRanges('abcdef', [{ from: 0, to: 6, cls: 'hljs-comment' }], [{ from: 2, to: 4, cls: 'hljs-type' }]), '<span class="hljs-comment">abcdef</span>');
});

test('Chroma ranges merge with semantic types and preserve HTML entities, Unicode and CRLF', () => {
  const text = 'class Player\r\n"😀<&\'"';
  const html = '<span class="hljs-keyword">class</span> Player\r\n<span class="hljs-string">&#34;😀&lt;&amp;&#39;&#34;</span>';
  const lexical = rangesFromHighlight(html, text);
  assert.deepEqual(words(text, lexical), ['class', '"😀<&\'"']);
  const merged = highlightRanges(text, lexical, [token(text, 'Player')]);
  assert.ok(merged.includes('hljs-keyword')); assert.ok(merged.includes('hljs-type')); assert.ok(merged.includes('hljs-string'));
  for (const invalid of ['<b>class Player</b>', '<span class="bad">class</span> Player', '<span class="hljs-type">Player', 'wrong']) assert.equal(rangesFromHighlight(invalid, text), null);
  const after = text.replace('Player', 'Players');
  assert.deepEqual(words(after, rebaseHighlightRanges(text, after, lexical)), ['class', '"😀<&\'"']);
});

test('indentation guides continue blank block lines and respect mixed tabs and CRLF', () => {
  const text = 'class C\r\n{\r\n    Run();\r\n\r\n\t\tNext();\r\n}\r\n';
  const rows = editorDecorations(text, starts(text), { tabSize: 4 });
  assert.deepEqual(rows.map(r => [r.line, r.indent]), [[2, 4], [3, 4], [4, 8]]);
  assert.ok(rows.every(r => r.markers.length === 0));
});

test('whitespace toggles distinguish boundary spaces, ordinary spaces, tabs and viewport clipping', () => {
  const text = '  a b  c \t';
  const all = editorDecorations(text, [0], { whitespace: 'all', guides: false });
  assert.deepEqual(all[0].markers, [{ column: 0, text: '··' }, { column: 3, text: '·' }, { column: 5, text: '··' }, { column: 8, text: '·' }, { column: 9, text: '→' }]);
  const boundary = editorDecorations(text, [0], { whitespace: 'boundary', guides: false });
  assert.equal(boundary[0].markers.some(m => m.column === 3), false);
  const clipped = editorDecorations(text, [0], { whitespace: 'all', guides: false, left: 6, right: 8 });
  assert.deepEqual(clipped[0].markers, [{ column: 6, text: '·' }, { column: 8, text: '·' }]);
  assert.deepEqual(editorDecorations(text, [0], { guides: false }), []);
});

test('large files produce only visible decorations, including very long blank runs', () => {
  const text = '    Run();\n'.repeat(100000);
  const rows = editorDecorations(text, starts(text), { first: 50000, last: 50040, whitespace: 'all', right: 90 });
  assert.equal(rows.length, 41); assert.equal(rows[0].line, 50000); assert.equal(rows.at(-1).line, 50040);
  const blank = '\n'.repeat(100000);
  assert.deepEqual(editorDecorations(blank, starts(blank), { first: 50000, last: 50040 }), []);
});
