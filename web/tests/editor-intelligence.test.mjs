import test from 'node:test';
import assert from 'node:assert/strict';
import { preferLanguageCompletion, inlineSuffix, completionPrompt, completionText, attachAgentCompletion } from '../src/sulfur/inline-completion.js';
import { semanticRanges, highlightRanges } from '../src/sulfur/semantic-tokens.js';
import { createSyntaxCache } from '../src/syntax-cache.js';
import { formatWhitespace, formattingEdits } from '../src/sulfur/formatting.js';
import { opEdits, opApply } from '../src/text-operations.js';
import { EditorHistory } from '../src/editor-history.js';
import { TreeFragment } from '../.vendor/node_modules/@lezer/common/dist/index.js';
import { parser } from '../.vendor/node_modules/@lezer/javascript/dist/index.js';

test('completion routing favors project symbols and generation at expression/statement boundaries', () => {
  const symbols = [{ label: 'transform', kind: 10 }, { label: 'Translate', kind: 2 }];
  for (const text of ['player.', 'player.tr', 'Entity::', 'using Claymore', 'trans']) assert.equal(preferLanguageCompletion(text, text.length, symbols), true, text);
  for (const text of ['var player = ', 'return ', '    ', '// create a player', 'if (ready) {\n    ']) assert.equal(preferLanguageCompletion(text, text.length, symbols), false, text);
  assert.equal(preferLanguageCompletion('player.', 7, []), false);
  assert.equal(preferLanguageCompletion('ret', 3, [{ label: 'return', kind: 14 }]), false);
});

test('inline previews only extend the prefix and prompts bound shared context', () => {
  assert.equal(inlineSuffix({ edits: [{ from: 0, to: 3, text: 'readFile()' }] }, 'rea', 3), 'dFile()');
  assert.equal(inlineSuffix({ edits: [{ from: 0, to: 3, text: 'writeFile()' }] }, 'rea', 3), '');
  assert.equal(inlineSuffix({ edits: [{ from: 0, to: 5, text: 'readFile()' }] }, 'reaxx', 3), '');
  const context = JSON.parse(completionPrompt('a.cs', 'csharp', 'x'.repeat(30000), 15000).messages[0].content);
  assert.equal(context.prefix.length, 12000); assert.equal(context.suffix.length, 4000);
  assert.equal(completionText({ content: [{ type: 'text', text: '```cs\nFoo();\n```' }] }), 'Foo();');
});

test('semantic tokens decode Roslyn type classifications, CRLF, and UTF-16 safely', () => {
  const text = 'class Cat\r\n😀 Cat';
  const ranges = semanticRanges(text, [0, 0, 5, 0, 0, 0, 6, 3, 1, 0, 1, 3, 3, 1, 0], { tokenTypes: ['keyword', 'class'] });
  assert.deepEqual(ranges.map((r) => text.slice(r.from, r.to)), ['class', 'Cat', 'Cat']);
  assert.throws(() => semanticRanges(text, [20, 0, 1, 0, 0], { tokenTypes: ['class'] }), /outside/);
  assert.throws(() => semanticRanges(text, [0, 8, 5, 0, 0], { tokenTypes: ['class'] }), /range/);
  assert.throws(() => semanticRanges(text, [0], { tokenTypes: [] }), /Invalid/);
  assert.equal(highlightRanges('a<b', [{ from: 0, to: 3, cls: 'hljs-variable' }], [{ from: 2, to: 3, cls: 'hljs-type' }]), '<span class="hljs-variable">a&lt;</span><span class="hljs-type">b</span>');
});

test('incremental syntax trees match full reparses across incomplete edits and share repeated parses', () => {
  const cache = createSyntaxCache(TreeFragment);
  for (const source of ['class Cat {}', 'class Cat { run() { return "x"; } }', 'class Cat { run() { return "x; } }', 'class Cat { run() { return "y"; } }', '']) {
    const tree = cache.parse(parser, source);
    assert.equal(tree.toString(), parser.parse(source).toString());
    assert.equal(cache.parse(parser, source), tree);
  }
  cache.clear();
  assert.equal(cache.parse(parser, 'let x=1').toString(), parser.parse('let x=1').toString());
});

const options = { insertSpaces: true, tabSize: 2, indentBlocks: true, braceStyle: 'nextLine' };
const format = (text, opts = options, language = 'csharp') => formatWhitespace(text, language, opts, language === 'javascript' ? parser.parse(text) : undefined, language === 'javascript' ? (x) => parser.parse(x) : undefined);
test('formatting controls brace placement, tab size, tab characters and same-level contents', () => {
  assert.equal(format('class Cat {\nvoid Run() {\nPlay();\n}\n}\n'), 'class Cat\n{\n  void Run()\n  {\n    Play();\n  }\n}\n');
  assert.equal(format('class Cat\n{\nvoid Run()\n{\nPlay();\n}\n}', { ...options, insertSpaces: false, braceStyle: 'sameLine' }), 'class Cat {\n\tvoid Run() {\n\t\tPlay();\n\t}\n}');
  assert.equal(format('class Cat {\nvoid Run() {\nPlay();\n}\n}', { ...options, indentBlocks: false }), 'class Cat\n{\nvoid Run()\n{\nPlay();\n}\n}');
});

test('formatting preserves literals, interpolations, comments, CRLF, ASI and indentation-sensitive languages', () => {
  const source = 'class C {\r\nvar x = $"{Foo("}")}"; // { comment\r\nvar raw = """\r\n   { raw }\r\n   """;\r\n}\r\n';
  const formatted = format(source);
  assert.ok(formatted.includes('$"{Foo("}")}"')); assert.ok(formatted.includes('// { comment'));
  assert.ok(formatted.includes('"""\r\n   { raw }\r\n   """'));
  assert.equal(formatted.replace(/\r\n/g, '').includes('\n'), false);
  const js = 'function f() { return {a: /{}/, b: `hello ${x}`}; }';
  const result = format(js, options, 'javascript');
  assert.ok(result.includes('return {')); assert.ok(result.includes('/{}/')); assert.ok(result.includes('`hello ${x}`'));
  assert.equal(parser.parse(result).toString().replaceAll(/\s/g, ''), parser.parse(js).toString().replaceAll(/\s/g, ''));
  for (const source of ['function f(){ return /* comment */ {x: 1}; }', 'function f(){ return /* comment */\n{x: 1}; }']) {
    for (const braceStyle of ['nextLine', 'sameLine']) assert.equal(parser.parse(format(source, { ...options, braceStyle }, 'javascript')).toString(), parser.parse(source).toString());
  }
  for (const language of ['python', 'go', 'yaml']) assert.equal(format('if a:\n   work()\n', options, language), 'if a:\n   work()\n');
});

test('formatting is one undo step and retains collaborator edits within unchanged code', () => {
  const before = 'class C {\nvoid Run() {\nPlay();\n}\n}';
  const after = format(before);
  const edits = formattingEdits(before, after), ops = opEdits(before, edits);
  assert.equal(opApply(before, ops), after);
  const history = new EditorHistory(); history.recordOperation(before, ops, [0, 0], [0, 0]);
  const at = after.indexOf('Play');
  const remote = opEdits(after, [{ from: at, to: at + 4, text: 'Pause' }]);
  history.remote(remote);
  const next = opApply(after, remote);
  assert.equal(history.step(next, [0, 0]).text, before.replace('Play', 'Pause'));
});

test('formatting retains server-formatted continuation alignment', () => {
  const text = 'class C\n{\n  var value = one\n    ?? two;\n}';
  assert.equal(format(text, { ...options, braceStyle: 'preserve', preserveContinuation: true }), text);
  assert.equal(formatWhitespace('{\n"values": [\n1,\n2\n]\n}', 'json', { ...options, braceStyle: 'preserve' }), '{\n  "values": [\n    1,\n    2\n  ]\n}');
});

test('agent requests abort on edits, caret movement, disable and disposal; only Tab accepts current code', async () => {
  const originalDocument = globalThis.document;
  const doc = new EventTarget(), ta = new EventTarget();
  doc.hidden = false; doc.activeElement = ta;
  Object.assign(ta, { readOnly: false, selectionStart: 4, selectionEnd: 4 });
  globalThis.document = doc;
  let text = 'var ', value = null, pending, enabled = true, calls = 0;
  const tab = { view: { querySelector: () => ta }, ed: { ready: () => true, text: () => text, editMany(edits) { text = opApply(text, opEdits(text, edits)); return true; } } };
  const preview = { current: () => value, clear: () => { value = null; }, show(t, caret, suffix, source) { value = { text: t, caret, suffix, source }; return true; } };
  const agent = attachAgentCompletion(tab, { alive: () => true, enabled: () => enabled, delay: () => 1, preferLanguage: () => false, beforeShow() {}, listVisible: () => false, error(e) { throw e; }, suggest(t, source, caret, signal) { calls++; return new Promise((resolve) => { pending = { resolve, signal }; }); } }, preview);
  try {
    let task = agent.complete();
    text = 'var x'; ta.selectionStart = ta.selectionEnd = 5; agent.changed();
    assert.equal(pending.signal.aborted, true); pending.resolve('stale'); await task; assert.equal(value, null);
    task = agent.complete(); ta.selectionStart = ta.selectionEnd = 0; doc.dispatchEvent(new Event('selectionchange'));
    assert.equal(pending.signal.aborted, true); pending.resolve('stale'); await task; assert.equal(value, null);
    ta.selectionStart = ta.selectionEnd = text.length;
    task = agent.complete(); enabled = false; agent.cancel(); pending.resolve('stale'); await task; assert.equal(value, null);
    enabled = true; task = agent.complete(); pending.resolve(' = 42;'); await task; assert.equal(value.suffix, ' = 42;');
    const key = Object.assign(new Event('keydown', { cancelable: true }), { key: 'Tab' }); ta.dispatchEvent(key);
    assert.equal(key.defaultPrevented, true); assert.equal(text, 'var x = 42;'); assert.equal(value, null);
    ta.selectionStart = ta.selectionEnd = text.length;
    task = agent.complete(); agent.dispose(); assert.equal(pending.signal.aborted, true); pending.resolve('stale'); await task;
    const count = calls; await agent.complete(); assert.equal(calls, count);
  } finally { agent.dispose(); globalThis.document = originalDocument; }
});
