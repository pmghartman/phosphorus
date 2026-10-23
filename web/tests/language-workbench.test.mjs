import test from 'node:test';
import assert from 'node:assert/strict';
import { createLanguageWorkbench } from '../src/sulfur/language-workbench.js';
import { editorFixture, Element, settle } from './helpers/editor-fixture.mjs';

class Socket {
  static instances = [];
  constructor() { this.readyState = 1; this.sent = []; Socket.instances.push(this); queueMicrotask(() => this.onopen()); }
  deliver(message) { this.onmessage({ data: JSON.stringify(message) }); }
  send(data) {
    const message = JSON.parse(data); this.sent.push(message);
    if (message.op === 'status') queueMicrotask(() => this.deliver({ _sulfur: 'status', extensions: [{ id: 'javascript', enabled: true }] }));
    if (message.op === 'launch') queueMicrotask(() => this.deliver({ _sulfur: 'ready', rootUri: 'file:///project' }));
    if (message.method === 'initialize') queueMicrotask(() => this.deliver({ id: message.id, result: { capabilities: { textDocumentSync: 1, completionProvider: { resolveProvider: true, triggerCharacters: ['.'] } } } }));
  }
  close() { this.readyState = 3; this.onclose?.(); }
  reply(method, result) { const message = this.sent.findLast((x) => x.method === method); assert.ok(message, method); this.deliver({ id: message.id, result }); }
}

async function setup(t, server = false) {
  const f = editorFixture(t, 'readFile();\nre');
  globalThis.WebSocket = Socket;
  const workbench = createLanguageWorkbench({
    el: (tag, cls, text) => new Element(tag, cls, text), alive: f.alive,
    context: async () => server ? { host: 'pc', root: '/project', documentRel: 'test.js', settings: {} } : null,
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
