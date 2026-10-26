import test from 'node:test';
import assert from 'node:assert/strict';
import { onigToJS, createGrammar, tokenizeLine, initialState, scopeClass, grammarHighlighter } from '../src/sulfur/textmate.js';

const js = (p) => { const t = onigToJS(p); return new RegExp(t.source, `dgmu${t.flags}`); };
// a text's lines tokenized in turn: each token as text@its innermost scope
function lines(g, text) {
  let state = initialState(g);
  return text.split('\n').map((line, n) => {
    const r = tokenizeLine(g, line, state, n === 0);
    state = r.state;
    return r.tokens.map((t) => `${line.slice(t.from, t.to)}@${t.scopes[t.scopes.length - 1]}`);
  });
}

test('Oniguruma patterns become JavaScript ones', () => {
  assert.ok(js('\\h+').test('0fA9'));
  assert.ok(!js('^\\h+$').test('0fg'));
  // possessive and atomic groups taken as greedy ones
  assert.equal(js('a++b').exec('aaab')[0], 'aaab');
  assert.equal(js('(?>ab|a)c').exec('abc')[0], 'abc');
  // extended mode: spaces and comments dropped, a # in a class kept
  assert.equal(js('(?x) a \\s b  # the rest\n [#] ').exec('a b#')[0], 'a b#');
  // POSIX brackets, nested classes and a leading - in one
  assert.ok(js('^[[:alpha:][:digit:]_]+$').test('ab_12'));
  assert.equal(js('[^\\s[-?:,]]+').exec('ab-c d')[0], 'ab');
  assert.equal(js('[\\w-]+').exec('a-b c')[0], 'a-b');
  // case folding inline, Oniguruma's {,n} and a lone brace as a character
  assert.ok(js('(?i)select').test('SELECT'));
  assert.equal(js('a{,2}').exec('aaa')[0], 'aa');
  assert.equal(js('\\${?x}').exec('${x}')[0], '${x}');
  // \x{..}, \p{Print} as a set, escapes JavaScript's unicode mode refuses
  assert.ok(js('\\x{1F600}').test('😀'));
  assert.ok(js('^#\\p{Print}*$').test('# a comment'));
  assert.ok(js('\\@\\#\\%\\-').test('@#%-'));
  // what JavaScript can't do is refused, not mistranslated
  for (const p of ['(?(1)a|b)', 'a\\Kb', '[a&&b]', '\\g<x>']) assert.throws(() => onigToJS(p), p);
});

test('\\G matches only where the last match ended, \\A only at the file start', () => {
  const g = createGrammar({
    scopeName: 'source.t',
    patterns: [{ begin: 'q', end: '$', name: 'string.t', patterns: [{ match: '\\Gx', name: 'keyword.first.t' }, { match: 'x', name: 'constant.other.t' }] },
      { match: '\\Astart', name: 'keyword.header.t' }],
  });
  assert.deepEqual(lines(g, 'start qxx\nstart'), [
    ['start@keyword.header.t', ' @source.t', 'q@string.t', 'x@keyword.first.t', 'x@constant.other.t'],
    ['start@source.t'],
  ]);
});

test('begin/end rules span lines, their end from the begin\'s captures', () => {
  const g = createGrammar({
    scopeName: 'source.t',
    patterns: [
      { begin: '<<(\\w+)', end: '^\\1$', name: 'string.heredoc.t', contentName: 'meta.body.t', beginCaptures: { 1: { name: 'entity.name.tag.t' } } },
      { begin: '/\\*', end: '\\*/', name: 'comment.block.t' },
      { match: '\\b(if|else)\\b', name: 'keyword.control.t' },
    ],
  });
  assert.deepEqual(lines(g, 'x <<EOT\nif\nEOT\n/* a\nb */ else'), [
    ['x @source.t', '<<@string.heredoc.t', 'EOT@entity.name.tag.t'],
    ['if@meta.body.t'],
    ['EOT@string.heredoc.t'],
    ['/* a@comment.block.t'],
    ['b */@comment.block.t', ' @source.t', 'else@keyword.control.t'],
  ]);
});

test('while rules close on the first line that fails their condition', () => {
  const g = createGrammar({
    scopeName: 'text.t',
    patterns: [{ begin: '^>', while: '^>', name: 'markup.quote.t', patterns: [{ match: '\\*\\w+\\*', name: 'markup.bold.t' }] }],
  });
  const got = lines(g, '> a *b*\n> c\nd');
  assert.deepEqual(got[0], ['> a @markup.quote.t', '*b*@markup.bold.t']);
  assert.deepEqual(got[1], ['> c@markup.quote.t']);
  assert.deepEqual(got[2], ['d@text.t']);
});

test('captures nest, carry patterns of their own and name scopes from the text', () => {
  const g = createGrammar({
    scopeName: 'source.t',
    patterns: [{ include: '#call' }],
    repository: {
      call: {
        match: '(\\w+)\\(([^)]*)\\)',
        name: 'meta.call.$1.t',
        captures: { 1: { name: 'entity.name.function.t' }, 2: { name: 'meta.args.t', patterns: [{ include: '#number' }, { include: '$self' }] } },
      },
      number: { match: '\\d+', name: 'constant.numeric.t' },
    },
  });
  const r = tokenizeLine(g, 'f(1, g(2))', initialState(g), true);
  const at = (text) => r.tokens.find((t) => 'f(1, g(2))'.slice(t.from, t.to) === text);
  assert.deepEqual(at('f').scopes, ['source.t', 'meta.call.f.t', 'entity.name.function.t']);
  assert.deepEqual(at('1').scopes, ['source.t', 'meta.call.f.t', 'meta.args.t', 'constant.numeric.t']);
});

test('includes reach a repository, the grammar itself and other grammars by scope', () => {
  const css = { scopeName: 'source.css.t', patterns: [{ match: '#[0-9a-f]{3}\\b', name: 'constant.other.color.t' }] };
  const g = createGrammar({
    scopeName: 'text.html.t',
    patterns: [{ begin: '<style>', end: '</style>', name: 'meta.embedded.t', patterns: [{ include: 'source.css.t' }] }, { include: 'source.missing' }],
  }, (scope) => (scope === 'source.css.t' ? css : null));
  assert.deepEqual(lines(g, '<style>#fff</style>')[0], ['<style>@meta.embedded.t', '#fff@constant.other.color.t', '</style>@meta.embedded.t']);
});

test('a rule that matches nothing never hangs the line', () => {
  const g = createGrammar({ scopeName: 'source.t', patterns: [{ match: '(?=x)', name: 'keyword.t' }, { begin: '(?=y)', end: '(?=y)', name: 'string.t' }, { match: 'z', name: 'keyword.z.t' }] });
  for (const line of ['xyz', 'yyy', '']) assert.ok(Array.isArray(tokenizeLine(g, line).tokens));
});

test('scopes are drawn under the classes the themes color', () => {
  assert.equal(scopeClass(['source.lua', 'comment.line.double-dash.lua', 'punctuation.definition.comment.lua']), 'hljs-comment');
  assert.equal(scopeClass(['source.x', 'string.quoted.double.x', 'constant.character.escape.x']), 'hljs-symbol');
  assert.equal(scopeClass(['source.x', 'keyword.control.x']), 'hljs-keyword');
  assert.equal(scopeClass(['source.x', 'meta.function.x', 'keyword.operator.x']), '');
  assert.equal(scopeClass(['source.x', 'meta.function.x', 'entity.name.function.x']), 'hljs-title');
  assert.equal(scopeClass(['source.x', 'storage.type.x']), 'hljs-keyword');
  assert.equal(scopeClass(['source.x', 'meta.thing.x']), '');
});

test('a highlighter keeps a line\'s tokens while its state holds, recomputes those after an edit', () => {
  const g = createGrammar({ scopeName: 'source.t', patterns: [{ begin: '"', end: '"', name: 'string.t' }, { match: '\\d+', name: 'constant.numeric.t' }] });
  const h = grammarHighlighter(g);
  const text = 'a 1\n"b\nc" 2';
  assert.deepEqual(h(text), [{ from: 2, to: 3, cls: 'hljs-number' }, { from: 4, to: 6, cls: 'hljs-string' }, { from: 7, to: 9, cls: 'hljs-string' }, { from: 10, to: 11, cls: 'hljs-number' }]);
  // the quote closed early: the line after it is code again
  assert.deepEqual(h('a 1\n"b"\nc 2').map((r) => r.cls), ['hljs-number', 'hljs-string', 'hljs-number']);
});

test('a rule entered on one line and closed at the next one\'s start leaves that line tokenized', () => {
  // the shape of VS Code's Lua comment: a lookahead begin, its comment to the newline, (?!\G) to close
  const g = createGrammar({
    scopeName: 'source.t',
    patterns: [
      { begin: '(^[ \\t]+)?(?=--)', end: '(?!\\G)', patterns: [{ begin: '--', end: '\\n', name: 'comment.line.t' }] },
      { begin: '"', end: '"', name: 'string.quoted.t' },
    ],
  });
  assert.deepEqual(lines(g, '  -- hi\nx "s"'), [['  @source.t', '-- hi@comment.line.t'], ['x @source.t', '"s"@string.quoted.t']]);
});
