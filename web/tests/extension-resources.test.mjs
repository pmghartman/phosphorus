import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { installExtensionResources } from '../src/sulfur/extension-resources.js';

const nativeFetch = globalThis.fetch;
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate); };

test('file fetches use the native filesystem port, preserve bytes and wasm MIME, and respect cancellation', async (t) => {
  const calls = [];
  const resources = installExtensionResources(async (...args) => { calls.push(args); return new Uint8Array([0, 97, 115, 109]); });
  t.after(() => resources.dispose());
  const r = await fetch('file:///me/ext/a%20b.wasm');
  assert.equal(r.headers.get('Content-Type'), 'application/wasm');
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [0, 97, 115, 109]);
  assert.deepEqual(calls, [['workspace.readBytes', '/me/ext/a b.wasm']]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetch('file:///me/ext/a.wasm', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 1);
  await assert.rejects(fetch('file:///me/ext/a.wasm', { method: 'POST' }), /read-only/);
  assert.equal(await (await fetch('data:text/plain,network-path')).text(), 'network-path');
});

// A browser-style worker fixture runs the actual emitted bootstrap in an isolated
// global. importScripts evaluates the supplied entry; both directions use native
// structured clone, including transfer lists and messages sent before startup.
function workers(t) {
  const original = globalThis.Worker, made = [];
  class Worker extends EventTarget {
    constructor(url) {
      super(); made.push(this); this.queued = []; this.closed = false;
      this.loading = nativeFetch(url).then((r) => r.text()).then((source) => {
        const target = new EventTarget(), blobs = new Map(); let seq = 0;
        const scope = { console, Response, TextEncoder, TextDecoder, Uint8Array, AbortController, DOMException, MessageEvent, setTimeout, fetch: nativeFetch,
          crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
          Blob: class { constructor(parts) { this.text = parts.join(''); } },
          URL: { createObjectURL(blob) { const u = `blob:fixture/${++seq}`; blobs.set(u, blob.text); return u; }, revokeObjectURL(u) { blobs.delete(u); } },
          addEventListener: target.addEventListener.bind(target), dispatchEvent: target.dispatchEvent.bind(target),
          postMessage: (data, transfer) => { const copy = structuredClone(data, { transfer: transfer || [] }); queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: copy }))); },
          importScripts: (url) => vm.runInContext(blobs.get(url), context),
        };
        scope.self = scope;
        const context = vm.createContext(scope);
        vm.runInContext(source, context);
        this.scope = scope;
        for (const message of this.queued.splice(0)) scope.dispatchEvent(message);
      });
    }
    postMessage(data, options) {
      const transfer = Array.isArray(options) ? options : options?.transfer || [];
      const message = new MessageEvent('message', { data: structuredClone(data, { transfer }) });
      if (this.scope) queueMicrotask(() => this.scope.dispatchEvent(message)); else this.queued.push(message);
    }
    terminate() { this.closed = true; }
  }
  globalThis.Worker = Worker;
  t.after(() => { globalThis.Worker = original; });
  return made;
}

test('worker loads its entry and wasm through Sulfur, replaying early transfers without exposing control messages', async (t) => {
  const made = workers(t), calls = [], received = [];
  const entry = `self.addEventListener('message', async e => {
    const response = await self.fetch('file:///me/ext/engine.wasm');
    const bytes = new Uint8Array(await response.arrayBuffer());
    self.postMessage({ input: e.data[0], wasm: bytes[1], uuid: crypto.randomUUID() });
  });`;
  const resources = installExtensionResources(async (method, path) => {
    calls.push([method, path]);
    return path.endsWith('.js') ? new TextEncoder().encode(entry) : new Uint8Array([0, 97, 115, 109]);
  });
  t.after(() => resources.dispose());
  const worker = new Worker('file:///me/ext/worker.js');
  worker.addEventListener('message', (e) => received.push(e.data));
  const input = new Uint8Array([42]); worker.postMessage(input, [input.buffer]);
  assert.equal(input.byteLength, 0);
  await made[0].loading; await settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].input, 42);
  assert.equal(received[0].wasm, 97);
  assert.match(received[0].uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(calls.map((c) => c[1]), ['/me/ext/worker.js', '/me/ext/engine.wasm']);
  resources.dispose();
  assert.equal(made[0].closed, true);
  assert.equal(globalThis.fetch, nativeFetch);
});
