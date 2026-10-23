import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanguageWorkbench } from '../src/sulfur/language-workbench.js';
import { editorFixture, Element, settle } from './helpers/editor-fixture.mjs';

class Socket {
  static instances = [];
  static diagnosticProvider = null;
  static navigationCapabilities = {};
  constructor() { this.readyState = 1; this.sent = []; Socket.instances.push(this); queueMicrotask(() => this.onopen()); }
  deliver(message) { this.onmessage({ data: JSON.stringify(message) }); }
  send(data) {
    const message = JSON.parse(data); this.sent.push(message);
    if (message.op === 'status') queueMicrotask(() => this.deliver({ _sulfur: 'status', extensions: [{ id: 'javascript', enabled: true }, { id: 'csharp', enabled: true }] }));
    if (message.op === 'launch') queueMicrotask(() => this.deliver({ _sulfur: 'ready', rootUri: 'file:///project' }));
    if (message.method === 'initialize') queueMicrotask(() => this.deliver({ id: message.id, result: { capabilities: { textDocumentSync: 1, completionProvider: { resolveProvider: true, triggerCharacters: ['.'] }, diagnosticProvider: Socket.diagnosticProvider, ...Socket.navigationCapabilities } } }));
  }
  close() { this.readyState = 3; this.onclose?.(); }
  reply(method, result) { const message = this.sent.findLast((x) => x.method === method); assert.ok(message, method); this.deliver({ id: message.id, result }); }
}

async function setup(t, server = false, pull = false, csharp = false, capabilities = {}) {
  Socket.diagnosticProvider = pull ? { identifier: 'csharp' } : null;
  Socket.navigationCapabilities = capabilities;
  const opened = [], notices = [];
  const f = editorFixture(t, 'readFile();\nre');
  if (csharp) f.tab.rel = 'src/test.cs';
  globalThis.WebSocket = Socket;
  const workbench = createLanguageWorkbench({
    el: (tag, cls, text) => new Element(tag, cls, text), alive: f.alive,
    context: async () => server ? { host: 'pc', root: '/project', rootRel: 'src', documentRel: 'test.js', settings: {} } : null,
    join: (a, b) => a ? `${a}/${b}` : b,
    open: (path, context, range) => opened.push({ path, context, range }), notice: (text) => notices.push(text),
    url: () => 'http://localhost/languages', problems() {}, documents: () => [], log() {}, error: (error) => { throw error; },
  });
  workbench.attach(f.tab);
  f.cleanups.push(() => { f.tab.dispose(); workbench.reset(); });
  if (server) await workbench.get(f.tab);
  return { ...f, opened, notices, workbench, socket: Socket.instances.at(-1), box: f.view.querySelector('.ide-completion') };
}

const rows = (box) => box.children.filter((row) => row.className.startsWith('ide-completion-item'));

test('a language server list is waited for instead of words that it would replace under the caret', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t, true);
  const pending = f.workbench.suggest(f.tab); await settle();
  assert.equal(f.box.hidden, true);
  f.socket.reply('textDocument/completion', [{ label: 'require', kind: 3 }, { label: 'return', kind: 14 }]); await pending;
  assert.equal(f.box.hidden, false);
  assert.deepEqual(rows(f.box).map((row) => row.children[1].children.map((x) => x.textContent ?? x).join('')), ['require', 'return']);
});

test('words are tab-completable once a slow language server has kept the list waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t, true);
  const pending = f.workbench.suggest(f.tab); await settle();
  t.mock.timers.tick(1200);
  assert.equal(f.box.hidden, false);
  const event = f.ta.emit('keydown', { key: 'Tab' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.tab.ed.text(), 'readFile();\nreadFile');
  f.socket.reply('textDocument/completion', [{ label: 'ready' }]); await pending;
  assert.equal(f.box.hidden, true);
});

test('an incomplete list asked again keeps its items meanwhile, and stays where it opened', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t, true);
  const pending = f.workbench.suggest(f.tab); await settle();
  f.socket.reply('textDocument/completion', { isIncomplete: true, items: [{ label: 'readFile' }, { label: 'ready' }, { label: 'react' }] }); await pending;
  const top = f.box.style.top;
  f.setText('readFile();\nrea'); f.ta.emit('input', { inputType: 'insertText', data: 'a' });
  t.mock.timers.tick(10); await settle();
  assert.equal(f.box.hidden, false);
  assert.equal(rows(f.box).length, 3);
  f.socket.reply('textDocument/completion', { isIncomplete: true, items: [{ label: 'readFile' }, { label: 'ready' }] }); await settle();
  assert.equal(rows(f.box).length, 2);
  assert.equal(f.box.style.top, top);
});

test('long lists draw only the rows in view', async (t) => {
  const f = await setup(t);
  f.setText('x');
  await f.workbench.suggest(f.tab);
  assert.equal(f.box.hidden, true);
  const many = Array.from({ length: 500 }, (_, i) => `xname${i}`).join(' ');
  f.setText(`${many}\nx`);
  await f.workbench.suggest(f.tab);
  assert.equal(f.box.hidden, false);
  assert.ok(rows(f.box).length <= 16);
  for (let i = 0; i < 30; i++) f.ta.emit('keydown', { key: 'ArrowDown' });
  assert.ok(rows(f.box).some((row) => row.className.includes(' on')));
});

test('null semantic responses retain colors while explicit empty tokens clear them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t, true, false, true, { semanticTokensProvider: { full: true, legend: { tokenTypes: ['class'], tokenModifiers: [] } } });
  t.mock.timers.tick(1000); await settle();
  f.socket.reply('textDocument/semanticTokens/full', { data: [0, 0, 8, 0, 0] }); await settle();
  assert.equal(f.semantics.at(-1).ranges.length, 1);
  const before = f.semantics.length;
  f.setText('readFile();\nrea'); f.workbench.changed(f.tab); t.mock.timers.tick(1000); await settle();
  f.socket.reply('textDocument/semanticTokens/full', null); await settle();
  assert.equal(f.semantics.length, before);
  f.setText('readFile();\nread'); f.workbench.changed(f.tab); t.mock.timers.tick(1000); await settle();
  f.socket.reply('textDocument/semanticTokens/full', { data: [] }); await settle();
  assert.deepEqual(f.semantics.at(-1).ranges, []);
});

test('C# completion retries an empty startup response so DLL symbols can replace the word fallback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t, true, false, true);
  f.setText('ClaymoreEngine.');
  const pending = f.workbench.suggest(f.tab); await settle();
  f.socket.reply('textDocument/completion', []); await pending;
  t.mock.timers.tick(300); await settle();
  assert.equal(f.socket.sent.filter(x => x.method === 'textDocument/completion').length, 2);
  f.socket.reply('textDocument/completion', [{ label:'Entity',kind:7 }]); await settle();
  assert.equal(f.box.hidden, false);
  assert.equal(f.box.children[0].children[0].className, 'ide-completion-kind k-class');
});

test('pull-only language servers retain warning severity and diagnostic codes and refresh after edits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t, true, true);
  t.mock.timers.tick(1000); await settle();
  f.socket.reply('textDocument/diagnostic', { kind: 'full', resultId: 'a', items: [{ range: { start: {line:0,character:0}, end: {line:0,character:4} }, severity: 2, code: 'CS0649', message: 'Never assigned' }] }); await settle();
  assert.equal(f.diagnostics.at(-1)[0].severity, 2); assert.equal(f.diagnostics.at(-1)[0].code, 'CS0649');
  f.setText('readFile();\nrea'); f.workbench.changed(f.tab);
  // the report stays (the editor moves it with the edit) until the next replaces it
  assert.equal(f.diagnostics.at(-1)[0].code, 'CS0649');
  t.mock.timers.tick(1000); await settle();
  const req = f.socket.sent.findLast(x => x.method === 'textDocument/diagnostic');
  assert.equal(req.params.previousResultId, 'a');
  f.socket.reply('textDocument/diagnostic', {kind: 'full', resultId:'b', items:[]}); await settle();
  assert.deepEqual(f.diagnostics.at(-1), []);
});

test('late semantic replies do not reopen suggestions after Escape', async (t) => {
  const f = await setup(t, true);
  const pending = f.workbench.suggest(f.tab); await settle();
  f.ta.emit('keydown', { key: 'Escape' });
  f.socket.reply('textDocument/completion', [{ label: 'ready' }]); await pending;
  assert.equal(f.box.hidden, true); assert.equal(f.edits.length, 0);
});

test('semantic completion resolution refuses collaborator edits after the caret', async (t) => {
  const f = await setup(t, true);
  const pending = f.workbench.suggest(f.tab); await settle();
  f.socket.reply('textDocument/completion', [{ label: 'ready', insertText: 'ready' }]); await pending;
  f.ta.emit('keydown', { key: 'Tab' }); await settle();
  f.setText('readFile();\nre\n// peer', 14);
  f.socket.reply('completionItem/resolve', { label: 'ready', insertText: 'ready' }); await settle();
  assert.equal(f.edits.length, 0);
});

test('Shift+Tab, IME Enter and ordinary Tab preserve the editor key behavior', async (t) => {
  const f = await setup(t);
  await f.workbench.suggest(f.tab);
  assert.equal(f.ta.emit('keydown', { key: 'Enter', isComposing: true }).defaultPrevented, false);
  assert.equal(f.ta.emit('keydown', { key: 'Tab', shiftKey: true }).defaultPrevented, false);
  assert.equal(f.box.hidden, true);
  assert.equal(f.ta.emit('keydown', { key: 'Tab' }).defaultPrevented, false);
  assert.equal(f.edits.length, 0);
});

test('fallback completion replaces an identifier suffix instead of duplicating it', async (t) => {
  const f = await setup(t);
  f.setText('readFile();\nrexx', 14);
  await f.workbench.suggest(f.tab);
  f.ta.emit('keydown', { key: 'Tab' });
  assert.equal(f.tab.ed.text(), 'readFile();\nreadFile');
});

test('IntelliSense previews extend code inline and user scrolling dismisses them without redraw scroll cancellation', async (t) => {
  const f = await setup(t);
  await f.workbench.suggest(f.tab);
  assert.equal(f.previews.at(-1).insert, 'adFile');
  assert.equal(f.workbench.preferLanguage(f.tab), true);
  f.scroller.emit('scroll');
  assert.equal(f.box.hidden, false);
  f.scroller.emit('wheel');
  assert.equal(f.box.hidden, true);
  assert.equal(f.previews.at(-1), null);
});

test('automatic routing favors project members over weak keyword completions', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await setup(t, true);
  f.setText('ret'); f.ta.emit('input', { inputType: 'insertText', data: 't' });
  t.mock.timers.tick(10); await settle();
  f.socket.reply('textDocument/completion', [{ label: 'return', kind: 14 }]); await settle();
  assert.equal(f.workbench.preferLanguage(f.tab), false);
  f.setText('player.'); f.ta.emit('input', { inputType: 'insertText', data: '.' });
  t.mock.timers.tick(10); await settle();
  f.socket.reply('textDocument/completion', [{ label: 'Transform', kind: 10 }]); await settle();
  assert.equal(f.workbench.preferLanguage(f.tab), true);
});

test('symbol outlines discard stale edits and use a document-only request', async (t) => {
  const f = await setup(t, true, false, false, { documentSymbolProvider: true });
  const pending = f.workbench.documentOutline(f.tab); await settle();
  const req = f.socket.sent.findLast(x => x.method === 'textDocument/documentSymbol');
  assert.deepEqual(req.params, { textDocument: { uri: 'file:///project/test.js' } });
  f.setText('different');
  f.socket.reply('textDocument/documentSymbol', [{ name: 'readFile', kind: 12, location: { uri: 'file:///project/test.js', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } } } }]);
  assert.equal(await pending, null);
});

test('type and implementation navigation use the server method and route validated project paths', async (t) => {
  const f = await setup(t, true, false, false, { implementationProvider: true, typeDefinitionProvider: true });
  const range = { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } };
  for (const method of ['implementation', 'typeDefinition']) {
    const pending = f.workbench.navigate(f.tab, method); await settle();
    f.socket.reply('textDocument/' + method, [{ targetUri: 'file:///project/lib/base.js', targetSelectionRange: range }]);
    assert.equal(await pending, true);
    assert.equal(f.opened.at(-1).path, 'src/lib/base.js');
    assert.deepEqual(f.opened.at(-1).range, range);
  }
  assert.equal(await f.workbench.navigate(f.tab, 'declaration'), false);
});

test('call hierarchy preserves opaque item data, cancels requests and rejects old sessions', async (t) => {
  const f = await setup(t, true, false, false, { callHierarchyProvider: true });
  f.tab.ed.setSemanticTokens = () => {};
  const item = { name: 'readFile', kind: 12, uri: 'file:///project/test.js', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } }, data: { id: 'opaque-token' } };
  const prepare = f.workbench.callHierarchy(f.tab); await settle();
  f.socket.reply('textDocument/prepareCallHierarchy', [item]);
  const handle = await prepare;
  const incoming = f.workbench.hierarchyCalls(handle, handle.items[0], 'incoming'); await settle();
  assert.deepEqual(f.socket.sent.findLast(x => x.method === 'callHierarchy/incomingCalls').params.item.data, item.data);
  f.socket.reply('callHierarchy/incomingCalls', [{ from: item, fromRanges: [item.range] }]);
  assert.deepEqual((await incoming)[0].fromRanges, [item.range]);
  const controller = new AbortController();
  const outgoing = f.workbench.hierarchyCalls(handle, handle.items[0], 'outgoing', controller.signal); await settle();
  controller.abort();
  await assert.rejects(outgoing, { name: 'AbortError' });
  assert.ok(f.socket.sent.some(x => x.method === '$/cancelRequest'));
  f.workbench.reset();
  await assert.rejects(f.workbench.hierarchyCalls(handle, item, 'incoming'), /session changed/);
});

test('workspace symbol resolution stays in its session and refuses paths outside the project', async (t) => {
  const f = await setup(t, true, false, false, { workspaceSymbolProvider: { resolveProvider: true } });
  const pending = f.workbench.workspaceSymbols(f.tab, 'Player'); await settle();
  f.socket.reply('workspace/symbol', [{ name: 'Player', kind: 5, location: { uri: 'file:///project/types.js' }, data: 27 }]);
  const [hit] = await pending;
  const open = f.workbench.openWorkspaceSymbol(hit); await settle();
  const range = { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } };
  f.socket.reply('workspaceSymbol/resolve', { ...hit.item, location: { uri: 'file:///project/types.js', range } });
  await open;
  assert.equal(f.opened.at(-1).path, 'src/types.js');
  await assert.rejects(f.workbench.openLocation(hit.doc, 'file:///private/secrets.js', range), /outside/);
});
