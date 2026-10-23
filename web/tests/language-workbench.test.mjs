import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanguageWorkbench } from '../src/sulfur/language-workbench.js';
import { editorFixture, Element, settle } from './helpers/editor-fixture.mjs';

class Socket {
  static instances = [];
  static diagnosticProvider = null;
  constructor() { this.readyState = 1; this.sent = []; Socket.instances.push(this); queueMicrotask(() => this.onopen()); }
  deliver(message) { this.onmessage({ data: JSON.stringify(message) }); }
  send(data) {
    const message = JSON.parse(data); this.sent.push(message);
    if (message.op === 'status') queueMicrotask(() => this.deliver({ _sulfur: 'status', extensions: [{ id: 'javascript', enabled: true }, { id: 'csharp', enabled: true }] }));
    if (message.op === 'launch') queueMicrotask(() => this.deliver({ _sulfur: 'ready', rootUri: 'file:///project' }));
    if (message.method === 'initialize') queueMicrotask(() => this.deliver({ id: message.id, result: { capabilities: { textDocumentSync: 1, completionProvider: { resolveProvider: true, triggerCharacters: ['.'] }, diagnosticProvider: Socket.diagnosticProvider } } }));
  }
  close() { this.readyState = 3; this.onclose?.(); }
  reply(method, result) { const message = this.sent.findLast((x) => x.method === method); assert.ok(message, method); this.deliver({ id: message.id, result }); }
}

async function setup(t, server = false, pull = false, csharp = false) {
  Socket.diagnosticProvider = pull ? { identifier: 'csharp' } : null;
  const f = editorFixture(t, 'readFile();\nre');
  if (csharp) f.tab.rel = 'src/test.cs';
  globalThis.WebSocket = Socket;
  const workbench = createLanguageWorkbench({
    el: (tag, cls, text) => new Element(tag, cls, text), alive: f.alive,
    context: async () => server ? { host: 'pc', root: '/project', rootRel: 'src', documentRel: 'test.js', settings: {} } : null,
    join: (a, b) => a ? `${a}/${b}` : b,
    url: () => 'http://localhost/languages', problems() {}, documents: () => [], log() {}, error: (error) => { throw error; },
  });
  workbench.attach(f.tab);
  f.cleanups.push(() => { f.tab.dispose(); workbench.reset(); });
  if (server) await workbench.get(f.tab);
  return { ...f, workbench, socket: Socket.instances.at(-1), box: f.view.querySelector('.ide-completion') };
}

test('word suggestions are immediately tab-completable while the semantic provider is pending', async (t) => {
  const f = await setup(t, true);
  const pending = f.workbench.suggest(f.tab);
  assert.equal(f.box.hidden, false);
  const event = f.ta.emit('keydown', { key: 'Tab' });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.tab.ed.text(), 'readFile();\nreadFile');
  await pending;
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
  assert.equal(f.diagnostics.at(-1), null);
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
