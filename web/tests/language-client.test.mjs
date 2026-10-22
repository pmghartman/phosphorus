import test from 'node:test';
import assert from 'node:assert/strict';
import { positionAt, offsetAt, fileUri, uriPath, relativeUri, applyTextEdits, completionEdits, languageSocket, LANGUAGE_EXTENSIONS, languageId } from '../src/sulfur/language-client.js';
import { EditorHistory } from '../src/editor-history.js';
import { opDiff } from '../src/text-operations.js';

const range = (from, to) => ({ start: { line: 0, character: from }, end: { line: 0, character: to } });

test('UTF-16 positions preserve surrogate pairs and CRLF offsets', () => {
  const text = '😀a\r\nβeta';
  assert.deepEqual(positionAt(text, 7), { line: 1, character: 2 });
  assert.equal(offsetAt(text, { line: 0, character: 2 }), 2);
  assert.equal(offsetAt(text, { line: 1, character: 2 }), 7);
  assert.throws(() => offsetAt(text, { line: 0, character: 4 }));
  assert.throws(() => offsetAt(text, { line: 10, character: 0 }));
  assert.throws(() => offsetAt(text, { line: 0, character: -1 }));
});

test('file URIs round trip spaces, Unicode and reserved characters on all hosts', () => {
  for (const path of ['D:/my project/#a%.cpp', '/home/ryan/é file.py']) assert.equal(uriPath(fileUri(path)), path);
  assert.equal(relativeUri('file:///D:/Project', 'file:///d:/project/src/a.cpp'), 'src/a.cpp');
  assert.throws(() => relativeUri('file:///home/p', 'file:///home/project/a.py'));
  assert.throws(() => relativeUri('file:///home/p', 'file:///home/p/%2e%2e/secret'));
  assert.throws(() => relativeUri('file:///home/p', 'file://other/home/p/a'));
  assert.throws(() => uriPath('https://example.com/a'));
});

test('completion replaces its server range, applies imports, and retains earlier undo and remote edits', () => {
  const before = 'const x = rea';
  const history = new EditorHistory();
  history.record('const x = ', before, [10, 10], [13, 13], 'insertText');
  const result = completionEdits({ label: 'readFile', textEdit: { range: range(10, 13), newText: 'readFile' }, additionalTextEdits: [{ range: range(0, 0), newText: 'import fs;\n' }] }, before, before.length);
  assert.equal(result.text, 'import fs;\nconst x = readFile');
  assert.equal(result.caret, result.text.length);
  history.recordOperation(before, result.ops, [13, 13], [result.caret, result.caret]);
  history.remote(opDiff(result.text, '// peer\n' + result.text));
  let step = history.step('// peer\n' + result.text, [result.caret + 8, result.caret + 8]);
  assert.equal(step.text, '// peer\n' + before);
  step = history.step(step.text, step.selection);
  assert.equal(step.text, '// peer\nconst x = ');
  step = history.step(step.text, step.selection, true);
  assert.equal(step.text, '// peer\n' + before);
  step = history.step(step.text, step.selection, true);
  assert.equal(step.text, '// peer\n' + result.text);
});

test('completion list defaults, insert/replace edits and plain identifier fallback work', () => {
  assert.equal(completionEdits({ label: 'hello' }, 'he', 2).text, 'hello');
  assert.equal(completionEdits({ label: 'hello', textEditText: 'hello' }, 'he', 2, { editRange: range(0, 2) }).text, 'hello');
  assert.equal(completionEdits({ label: 'hello', textEdit: { insert: range(0, 2), replace: range(0, 4), newText: 'hello' } }, 'hexx', 2).text, 'hello');
  assert.throws(() => completionEdits({ label: 'fn', insertText: 'fn(${1:a})', insertTextFormat: 2 }, '', 0), /snippets/);
});

test('rename edits use original positions and reject overlaps before changing text', () => {
  assert.equal(applyTextEdits('foo + foo', [{ range: range(0, 3), newText: 'thing' }, { range: range(6, 9), newText: 'thing' }]), 'thing + thing');
  assert.throws(() => applyTextEdits('abcdef', [{ range: range(0, 4), newText: 'x' }, { range: range(2, 5), newText: 'y' }]), /Overlapping/);
  assert.throws(() => applyTextEdits('abc', [{ range: range(3, 1), newText: 'x' }]), /invalid/);
});

test('ten optional languages include shared C support and JSX/TSX identifiers', () => {
  assert.equal(new Set(Object.values(LANGUAGE_EXTENSIONS)).size, 10);
  assert.equal(LANGUAGE_EXTENSIONS.c, 'cpp');
  assert.equal(languageId('file.tsx', 'typescript'), 'typescriptreact');
  assert.equal(languageId('file.c', 'cpp'), 'c');
});

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeSocket.instances.push(this); queueMicrotask(() => { this.readyState = 1; this.onopen(); }); }
  send(data) {
    const m = JSON.parse(data); this.sent.push(m);
    if (m.op) queueMicrotask(() => this.deliver({ _sulfur: 'ready', rootUri: 'file:///project' }));
    if (m.method === 'initialize') queueMicrotask(() => this.deliver({ id: m.id, result: { capabilities: { textDocumentSync: { change: 2 }, completionProvider: {}, definitionProvider: true } } }));
  }
  deliver(message) { this.onmessage({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const setup = async (t) => { const original = globalThis.WebSocket; globalThis.WebSocket = FakeSocket; t.after(() => { globalThis.WebSocket = original; }); const client = languageSocket('http://localhost/api/sulfur/languages', { op: 'launch' }); await client.initialize({ python: { analysis: { typeCheckingMode: 'strict' } } }); t.after(() => client.close()); return { client, ws: FakeSocket.instances.at(-1) }; };

test('initialization advertises UTF-16, disables snippets and completes the LSP handshake', async (t) => {
  const { ws } = await setup(t);
  assert.ok(ws.url.startsWith('ws://'));
  const init = ws.sent.find((x) => x.method === 'initialize');
  assert.deepEqual(init.params.capabilities.general.positionEncodings, ['utf-16']);
  assert.equal(init.params.capabilities.textDocument.completion.completionItem.snippetSupport, false);
  assert.equal(ws.sent.filter((x) => x.method === 'initialized').length, 1);
});

test('document versions increase only for changes and incremental servers receive a valid full-range replacement', async (t) => {
  const { client, ws } = await setup(t);
  assert.equal(client.sync('file:///project/a.py', 'python', '😀a\n'), 1);
  assert.equal(client.sync('file:///project/a.py', 'python', '😀a\n'), 1);
  assert.equal(client.sync('file:///project/a.py', 'python', 'b'), 2);
  const change = ws.sent.find((x) => x.method === 'textDocument/didChange');
  assert.deepEqual(change.params.contentChanges[0].range.end, { line: 1, character: 0 });
  client.closeDocument('file:///project/a.py');
  assert.equal(client.documents.size, 0);
});

test('cancelled requests send $/cancelRequest and discard late replies', async (t) => {
  const { client, ws } = await setup(t);
  const controller = new AbortController();
  const pending = client.request('textDocument/completion', {}, { signal: controller.signal });
  const id = ws.sent.at(-1).id;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(ws.sent.at(-1).method, '$/cancelRequest');
  ws.deliver({ id, result: [{ label: 'stale' }] });
});

test('disconnect rejects pending requests and server errors remain visible', async (t) => {
  const { client, ws } = await setup(t);
  const pending = client.request('textDocument/definition', {});
  ws.deliver({ _sulfur: 'error', error: 'Missing JDK 21' });
  await assert.rejects(pending, /Missing JDK/);
  const second = client.request('textDocument/references', {});
  ws.close();
  await assert.rejects(second, /disconnected/);
});

test('server configuration requests resolve nested sections and unsolicited edits cannot mutate files', async (t) => {
  const { ws } = await setup(t);
  ws.deliver({ id: 'server-1', method: 'workspace/configuration', params: { items: [{ section: 'python.analysis' }, { section: 'unknown' }] } });
  assert.deepEqual(ws.sent.at(-1).result, [{ typeCheckingMode: 'strict' }, null]);
  ws.deliver({ id: 'server-2', method: 'workspace/applyEdit', params: { edit: {} } });
  assert.equal(ws.sent.at(-1).result.applied, false);
});
