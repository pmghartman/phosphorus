import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrowserFile, browserFileText, saveBrowserFile } from '../src/sulfur/browser-files.js';

const file = (source) => ({ name: 'Local.cs', arrayBuffer: async () => new TextEncoder().encode(source).buffer });

test('browser files preserve UTF-8 BOM and CRLF when saved after editor normalization', async () => {
  const source = '\ufeffclass Café\r\n{\r\n}\r\n';
  const local = await readBrowserFile(file(source));
  assert.equal(local.text, 'class Café\n{\n}\n');
  assert.equal(browserFileText(local, local.text), source);
  assert.equal(browserFileText(local, local.text.replace('Café', 'Cat')), source.replace('Café', 'Cat'));
});

test('browser-local saves use the chosen handle, await completion and reuse it', async () => {
  const local = await readBrowserFile(file('let x = 1;\n'));
  const writes = [];
  let picks = 0, closes = 0;
  const browser = { async showSaveFilePicker(options) {
    picks++; assert.equal(options.suggestedName, 'Local.cs');
    return { async createWritable() { return { async write(text) { writes.push(text); }, async close() { closes++; } }; } };
  } };
  await saveBrowserFile(local, 'let x = 2;\n', browser);
  await saveBrowserFile(local, 'let x = 3;\n', browser);
  assert.deepEqual(writes, ['let x = 2;\n', 'let x = 3;\n']);
  assert.equal(picks, 1); assert.equal(closes, 2);
});

test('failed writes abort and cancelled save pickers leave the document unsaved', async () => {
  const local = await readBrowserFile(file('text'));
  const cancelled = new DOMException('Cancelled', 'AbortError');
  await assert.rejects(saveBrowserFile(local, 'changed', { showSaveFilePicker: async () => { throw cancelled; } }), { name: 'AbortError' });
  assert.equal(local.handle, null);
  let aborted = false;
  local.handle = { createWritable: async () => ({ write: async () => { throw new Error('disk full'); }, abort: async () => { aborted = true; } }) };
  await assert.rejects(saveBrowserFile(local, 'changed', {}), /disk full/);
  assert.equal(aborted, true);
  await assert.rejects(readBrowserFile(file('binary\0data')), /binary/);
});
