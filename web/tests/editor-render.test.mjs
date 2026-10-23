import test from 'node:test';
import assert from 'node:assert/strict';
import { TreeFragment } from '../.vendor/node_modules/@lezer/common/dist/index.js';
import { highlightTree, tagHighlighter, tags as t } from '../.vendor/node_modules/@lezer/highlight/dist/index.js';
import { parser as cpp } from '../.vendor/node_modules/@lezer/cpp/dist/index.js';
import { createSyntaxCache } from '../src/syntax-cache.js';
import { commonEnds, opDiff } from '../src/text-operations.js';
import { highlightRanges, rebaseHighlightRanges, classAt } from '../src/sulfur/semantic-tokens.js';
import { rebaseLexical, settleLexical } from '../src/sulfur/stable-highlight.js';
import { quickLex, lexStateAt } from '../src/sulfur/quick-lex.js';
import { rebaseDiagnostics } from '../src/sulfur/diagnostics.js';

// the editor's own highlighter lives in lezer.js, which needs a bundler's bare imports
const highlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.modifier, t.definitionKeyword], class: 'hljs-keyword' },
  { tag: [t.string], class: 'hljs-string' }, { tag: [t.number, t.integer, t.float], class: 'hljs-number' },
  { tag: [t.typeName, t.standard(t.typeName)], class: 'hljs-type' }, { tag: [t.lineComment, t.blockComment], class: 'hljs-comment' },
  { tag: [t.function(t.variableName)], class: 'hljs-title' }, { tag: [t.propertyName], class: 'hljs-attr' },
]);
const colors = (tree, from, to) => { const out = []; highlightTree(tree, highlighter, (a, b, cls) => out.push({ from: a, to: b, cls }), from, to); return out; };
const errors = (tree, from, to) => { const out = []; tree.iterate({ from, to, enter: (n) => { if (n.type.isError) out.push(n.from); } }); return out; };
const words = (text, ranges, from = 0) => ranges.filter((r) => r.from >= from).map((r) => `${text.slice(r.from, r.to)}:${r.cls.slice(5)}`).join(' ');

test('common ends match a character-by-character diff across block boundaries and surrogates', () => {
  const slow = (a, b) => {
    let head = 0; while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0; while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    return { head, tail };
  };
  const big = 'x'.repeat(5000) + '😀' + 'y'.repeat(3000);
  for (const [a, b] of [['', ''], ['abc', 'abc'], ['abc', 'abd'], ['aaaa', 'aa'], [big, big.slice(0, 4000) + 'Q' + big.slice(4000)], [big, big.replace('😀', '😁')], [big, big + big], ['ab'.repeat(2000), 'ab'.repeat(1999)]]) {
    assert.deepEqual(commonEnds(a, b), slow(a, b));
  }
  assert.deepEqual(opDiff('hello world', 'hello brave world'), [6, 'brave ', 5]);
});

test('a window of highlighted html is the same text and classes as the whole', () => {
  const text = 'int a = 1; // one\nfloat b = 2.5;\nreturn a;\n';
  const lexical = colors(cpp.parse(text), 0, text.length);
  const semantic = [{ from: text.indexOf('b'), to: text.indexOf('b') + 1, cls: 'hljs-variable' }];
  const whole = highlightRanges(text, lexical, semantic);
  const from = text.indexOf('float'), to = text.indexOf('\n', from);
  const part = highlightRanges(text, lexical, semantic, from, to);
  assert.equal(part.replace(/<[^>]+>/g, ''), text.slice(from, to));
  assert.ok(whole.includes(part.slice(0, part.indexOf('2.5'))));
  assert.equal(classAt(lexical, text.indexOf('one')), 'hljs-comment');
  assert.equal(classAt(lexical, text.indexOf(' = 1')), '');
});

test('half-typed code recolors only the line being typed until it parses as well as before', () => {
  const after = '  for (int i = 0; i < 10; i++) { a += i; }\n  return a;\n}\nstruct S { int x; };\nclass K { public: int z; void f(); };\n';
  const base = `int main() {\n  int a = 1;\n  \n${after}`;
  const at = base.indexOf('  \n') + 2;
  const cache = createSyntaxCache(TreeFragment);
  let text = base, tree = cache.parse(cpp, text);
  let state = settleLexical(null, colors(tree, 0, text.length), errors(tree, 0, text.length), 0, text.length, text);
  const later = (t) => t.indexOf(after);
  const expected = words(text, state.ranges, later(text));
  for (const typed of ['template <typename T> T f(T a) { if (a', 'std::vector<int> v = {1, 2', 'if (a > 2 && foo(a, ']) {
    text = base; state = settleLexical(null, colors(cache.parse(cpp, text), 0, text.length), errors(cache.parse(cpp, text), 0, text.length), 0, text.length, text);
    for (let n = 1; n <= typed.length; n++) {
      const next = base.slice(0, at) + typed.slice(0, n) + base.slice(at);
      state = rebaseLexical(state, text, next); text = next; tree = cache.parse(cpp, text);
      state = settleLexical(state, colors(tree, 0, text.length), errors(tree, 0, text.length), 0, text.length, text);
      assert.equal(words(text, state.ranges, later(text)), expected, `${typed.slice(0, n)}`);
    }
  }
  // complete again: the fresh parse taken whole and the state settled
  const done = base.slice(0, at) + 'int b = a;' + base.slice(at);
  state = rebaseLexical(state, text, done); tree = cache.parse(cpp, done);
  state = settleLexical(state, colors(tree, 0, done.length), errors(tree, 0, done.length), 0, done.length, done);
  assert.equal(state.dirty, null);
});

test('a block comment opened by an edit recolors what follows at once, as VS Code does', () => {
  const base = 'int a = 1;\n\nint b = 2;\nint c = 3;\n';
  const cache = createSyntaxCache(TreeFragment);
  let tree = cache.parse(cpp, base);
  let state = settleLexical(null, colors(tree, 0, base.length), errors(tree, 0, base.length), 0, base.length, base);
  const text = base.replace('\n\n', '\n/*\n');
  state = rebaseLexical(state, base, text); tree = cache.parse(cpp, text);
  state = settleLexical(state, colors(tree, 0, text.length), errors(tree, 0, text.length), 0, text.length, text);
  assert.equal(classAt(state.ranges, text.indexOf('int c')), 'hljs-comment');
});

test('stale semantic colors extended by typing yield to the keyword typing completes', () => {
  const before = 'publi void Run() {}';
  const semantic = [{ from: 0, to: 5, cls: 'hljs-variable' }];
  const after = 'public void Run() {}';
  const moved = rebaseHighlightRanges(before, after, semantic);
  assert.deepEqual(moved, [{ from: 0, to: 6, cls: 'hljs-variable', stale: true }]);
  const lexical = quickLex(after, 0, after.length, { lang: 'csharp' });
  assert.ok(highlightRanges(after, lexical, moved).startsWith('<span class="hljs-keyword">public</span>'));
  assert.ok(highlightRanges(after, lexical, [{ from: 0, to: 6, cls: 'hljs-variable' }]).startsWith('<span class="hljs-variable">public</span>'));
});

test('C# lines are colored as Chroma colors them before the server replies', () => {
  const text = '#region X\npublic static int Count = 0x1F; // n\nvar s = @"a ""b"" c" + $"{x}" + \'c\';\n/* open\n';
  const got = words(text, quickLex(text, 0, text.length, { lang: 'csharp', comment: '//' }));
  assert.equal(got, '#region X:meta public:keyword static:keyword int:type 0x1F:number // n:comment var:type @"a ""b"" c":string $"{x}":string \'c\':string /* open\n:comment');
  // a line starting inside a block comment the server colored before the edit
  const next = 'still comment */ int x;';
  assert.equal(lexStateAt([{ from: 0, to: 40, cls: 'hljs-comment' }], 0, 20), 'comment');
  assert.equal(words(next, quickLex(next, 0, next.length, { lang: 'csharp', state: 'comment' })), 'still comment */:comment int:type');
});

test('diagnostics move with edits and stretch over text typed inside them', () => {
  const items = [{ from: 2, to: 5, what: 'a' }, { from: 10, to: 12, what: 'b' }, { from: 20, to: 22, what: 'c' }];
  // 'XYZ' typed at 8: before the second and third, after the first
  assert.deepEqual(rebaseDiagnostics(items, { head: 8, tail: 22, before: 30 }, 3).map((d) => [d.from, d.to]), [[2, 5], [13, 15], [23, 25]]);
  // 3..11 replaced with 'Q': the first ends where the edit ends, the second starts at it
  assert.deepEqual(rebaseDiagnostics(items, { head: 3, tail: 19, before: 30 }, -7).map((d) => [d.from, d.to]), [[2, 4], [3, 5], [13, 15]]);
});
