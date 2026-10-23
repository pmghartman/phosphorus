import test from 'node:test';
import assert from 'node:assert/strict';
import { completionPrompt, completionText, streamCompletion, createInlineCompletions } from '../src/sulfur/inline-completion.js';
import { editorFixture, settle } from './helpers/editor-fixture.mjs';

test('the fixed Chimp harness bounds context and output without tools or conversation history', () => {
  const p = completionPrompt({ path: 'a.js', language: 'javascript', text: 'x'.repeat(30000), caret: 15000, related: Array(8).fill({ path: 'b.js', text: 'y'.repeat(9000) }), symbols: Array(50).fill({ label: 'run', detail: 'z'.repeat(900) }) });
  assert.equal(p.model, 'chimp'); assert.equal(p.max_tokens, 512); assert.equal(p.stream, true);
  assert.equal(p.tools, undefined); assert.equal(p.messages.length, 1);
  const context = JSON.parse(p.messages[0].content);
  assert.equal(context.prefix.length, 6000); assert.equal(context.suffix.length, 2000);
  assert.equal(context.related.length, 2); assert.equal(context.related[0].text.length, 1500);
  assert.equal(context.symbols.length, 12); assert.equal(context.symbols[0].detail.length, 160);
});

test('ghost code strips complete fences and duplicate delimiters and refuses reasoning', () => {
  assert.equal(completionText('```js\nrun()\n```'), 'run()');
  assert.equal(completionText('```js\nrun()', '', false), '');
  assert.equal(completionText('<think>plan</think>run()'), '');
  assert.equal(completionText('run())', ')', false), 'run()');
  assert.equal(completionText('get', 'the'), 'get', 'a shared word character is not a duplicate delimiter');
  assert.equal(completionText('abc\0def'), '');
  assert.equal(completionText('x'.repeat(9000)).length, 6000);
});

test('Messages streaming handles split UTF-8, CRLF, reasoning events and an unterminated final frame', async () => {
  const wire = [
    { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'private' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'return "😀";' } },
    { type: 'message_stop' },
  ].map((event) => `data: ${JSON.stringify(event)}`).join('\r\n\r\n');
  const bytes = new TextEncoder().encode(wire);
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
  const seen = [];
  assert.equal(await streamCompletion(response, (value) => seen.push(value)), 'return "😀";');
  assert.ok(seen.includes('return "😀";'));
  await assert.rejects(streamCompletion(new Response('data: {"type":"error","error":{"message":"overloaded"}}\n\n', { headers: { 'content-type': 'text/event-stream' } }), () => {}), /overloaded/);
});

function setup(t, options = {}) {
  const f = editorFixture(t);
  const requests = [], notices = [], logs = [];
  let suggesting = !!options.suggesting;
  let isEnabled = true;
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    requests.push({ url, init, resolve });
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const engine = createInlineCompletions({
    setting: (key) => key.endsWith('.enabled') ? isEnabled : 400, alive: f.alive,
    available: () => options.available !== false, url: () => options.url || '/api/model/v1/messages', scope: () => 'mesh:user:workspace', related: () => [], symbols: () => [],
    suggesting: () => suggesting, dismissSuggest: () => { suggesting = false; }, notice: (text) => notices.push(text), log: (text) => logs.push(text),
  });
  engine.attach(f.tab);
  f.cleanups.push(() => { f.tab.dispose(); engine.reset(); });
  return { ...f, engine, requests, notices, logs, disable() { isEnabled = false; }, reply(text, index = requests.length - 1) { requests[index].resolve(Response.json({ content: [{ type: 'text', text }] })); } };
}

test('Tab accepts a multiline AI suggestion as one collaborative undo operation', async (t) => {
  const f = setup(t);
  const pending = f.engine.trigger(f.tab, true);
  f.reply('function () {\n  return 42;\n}'); await pending;
  assert.ok(f.previews.at(-1).insert.includes('return 42'));
  const enter = f.ta.emit('keydown', { key: 'Shift' });
  assert.equal(enter.defaultPrevented, false);
  const accepted = f.ta.emit('keydown', { key: 'Tab' });
  assert.equal(accepted.defaultPrevented, true); assert.equal(f.edits.length, 1);
  assert.equal(f.history.step(f.tab.ed.text(), f.tab.ed.selection()).text, 'const answer = ');
});

test('AI ghost text never consumes Enter, Shift+Tab or composing keys', async (t) => {
  const f = setup(t);
  const pending = f.engine.trigger(f.tab, true); f.reply('42;'); await pending;
  for (const props of [{ key: 'Enter', isComposing: true }, { key: 'Tab', isComposing: true }, { key: 'Tab', shiftKey: true }, { key: 'Enter' }]) {
    await f.engine.trigger(f.tab, true);
    assert.equal(f.ta.emit('keydown', props).defaultPrevented, false);
    assert.equal(f.edits.length, 0);
  }
});

test('a streamed partial is usable immediately and acceptance cancels further inference', async (t) => {
  const f = setup(t);
  let stream;
  const pending = f.engine.trigger(f.tab, true);
  const body = new ReadableStream({ start(controller) { stream = controller; } });
  f.requests[0].init.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')));
  f.requests[0].resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
  stream.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"42;"}}\n\n'));
  await settle();
  assert.equal(f.previews.at(-1).insert, '42;');
  assert.equal(f.ta.emit('keydown', { key: 'Tab' }).defaultPrevented, true);
  await pending;
  assert.equal(f.requests[0].init.signal.aborted, true);
  assert.equal(f.tab.ed.text(), 'const answer = 42;');
});

test('multiline insertion preserves Windows line endings', async (t) => {
  const f = setup(t);
  f.setText('function x() {\r\n  return ');
  const pending = f.engine.trigger(f.tab, true); f.reply('42;\n}\n'); await pending;
  assert.equal(f.previews.at(-1).insert, '42;\r\n}\r\n');
});

test('typing and collaborator edits cancel a pending result and a late response cannot change the document', async (t) => {
  const f = setup(t);
  const pending = f.engine.trigger(f.tab, true);
  f.setText('const answer = other'); f.engine.changed(f.tab);
  assert.equal(f.requests[0].init.signal.aborted, true);
  f.reply('stale()'); await pending;
  assert.equal(f.previews.filter(Boolean).length, 0);
  assert.equal(f.ta.emit('keydown', { key: 'Tab' }).defaultPrevented, false);
  assert.equal(f.edits.length, 0);
});

test('IntelliSense takes priority, manual AI invocation dismisses its list, and Escape dismisses ghost text', async (t) => {
  const f = setup(t, { suggesting: true });
  await f.engine.trigger(f.tab);
  assert.equal(f.requests.length, 0);
  const pending = f.engine.trigger(f.tab, true);
  f.reply('42;'); await pending;
  assert.equal(f.ta.emit('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(f.previews.at(-1), null); assert.equal(f.edits.length, 0);
});

test('exact-context cache reuses a result and resets discard cached source', async (t) => {
  const f = setup(t);
  const pending = f.engine.trigger(f.tab, true); f.reply('42;'); await pending;
  f.engine.dismiss(); await f.engine.trigger(f.tab, true);
  assert.equal(f.requests.length, 1); assert.equal(f.previews.at(-1).insert, '42;');
  f.engine.reset();
  const again = f.engine.trigger(f.tab, true); assert.equal(f.requests.length, 2);
  f.reply('43;'); await again;
});

test('debounce sends one request after typing settles and blur stops inference', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = setup(t);
  f.ta.emit('input', { inputType: 'insertText', data: 'x' });
  t.mock.timers.tick(300);
  f.ta.emit('input', { inputType: 'insertText', data: 'y' });
  t.mock.timers.tick(399); assert.equal(f.requests.length, 0);
  t.mock.timers.tick(1); assert.equal(f.requests.length, 1);
  f.ta.emit('blur'); await settle();
  assert.equal(f.requests[0].init.signal.aborted, true);
});

test('offline and disabled completion make no requests; unmodified Tab and IME keys remain available', async (t) => {
  const f = setup(t, { available: false });
  await f.engine.trigger(f.tab, true); assert.equal(f.requests.length, 0); assert.equal(f.notices.length, 1);
  f.disable(); await f.engine.trigger(f.tab, true); assert.equal(f.requests.length, 0);
  for (const props of [{ key: 'Tab' }, { key: 'Tab', shiftKey: true }, { key: 'Enter', isComposing: true }]) assert.equal(f.ta.emit('keydown', props).defaultPrevented, false);
});

test('desktop completion uses the linked-mesh proxy URL and errors back off automatic requests', async (t) => {
  const f = setup(t, { url: '/api/mesh/api/model/v1/messages' });
  const pending = f.engine.trigger(f.tab, true);
  assert.equal(f.requests[0].url, '/api/mesh/api/model/v1/messages');
  f.requests[0].resolve(Response.json({ error: { message: 'No model ready' } }, { status: 529 })); await pending;
  assert.equal(f.notices.at(-1), 'No model ready');
  await f.engine.trigger(f.tab); assert.equal(f.requests.length, 1);
});
