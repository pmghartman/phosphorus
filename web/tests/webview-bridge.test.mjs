import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webviewBridge, applyWebviewStorage } from '../src/sulfur/webview-bridge.js';

function fixture(local = {}, session = {}) {
  const sent = [], listeners = new Map();
  const parent = { postMessage: (data) => sent.push(data) };
  const sandbox = { parent, DOMException, document: { addEventListener() {} }, addEventListener: (event, fn) => listeners.set(event, fn) };
  sandbox.window = sandbox;
  for (const key of ['localStorage', 'sessionStorage']) Object.defineProperty(sandbox, key, { configurable: true, get() { throw new DOMException('Opaque origin', 'SecurityError'); } });
  vm.runInNewContext(`(${webviewBridge.toString()})(null,'vscode-dark',${JSON.stringify(local)},${JSON.stringify(session)})`, sandbox);
  return { sandbox, sent, listeners, parent };
}

test('sandbox storage preserves browser string semantics, enumeration, removals and separate session data', () => {
  const f = fixture({ saved: 'yes' }, { transient: 'session' });
  const storage = f.sandbox.localStorage;
  assert.equal(storage.getItem('saved'), 'yes');
  assert.equal(storage.getItem('missing'), null);
  storage.setItem('count', 42);
  storage.property = 'value';
  assert.equal(storage.getItem('count'), '42');
  assert.equal(storage.property, 'value');
  assert.deepEqual(Object.keys(storage), ['saved', 'count', 'property']);
  assert.equal(storage.length, 3);
  assert.equal(storage.key(9), null);
  assert.equal(f.sandbox.sessionStorage.getItem('transient'), 'session');
  assert.equal(storage.getItem('transient'), null);
  delete storage.property;
  storage.removeItem('saved');
  assert.equal(storage.length, 1);
  assert.equal(f.sent[0].phosphorusWebviewStorage.scope, 'local');
  storage.clear();
  assert.equal(storage.length, 0);
});

test('only parent storage updates synchronize other views, without posting them back', () => {
  const f = fixture();
  const data = { sulfurWebviewStorageSync: { scope: 'local', action: 'set', key: 'shared', value: 'updated' } };
  f.listeners.get('message')({ source: {}, data });
  assert.equal(f.sandbox.localStorage.getItem('shared'), null);
  f.listeners.get('message')({ source: f.parent, data });
  assert.equal(f.sandbox.localStorage.getItem('shared'), 'updated');
  assert.equal(f.sent.length, 0);
});

test('storage quotas and parent-side validation reject oversized or malformed updates', () => {
  const f = fixture();
  assert.throws(() => f.sandbox.localStorage.setItem('too-big', 'x'.repeat(1 << 20)), { name: 'QuotaExceededError' });
  const entries = {};
  for (const update of [null, { scope: 'other', action: 'clear' }, { scope: 'local', action: 'set', key: {}, value: 'bad' }, { scope: 'local', action: 'set', key: 'x', value: {} }, { scope: 'local', action: 'set', key: 'x', value: 'x'.repeat(1 << 20) }]) assert.equal(applyWebviewStorage(entries, update), false);
  assert.equal(applyWebviewStorage(entries, { scope: 'local', action: 'set', key: '__proto__', value: 'a stored string' }), true);
  assert.equal(Object.getPrototypeOf(entries), Object.prototype);
  assert.equal(entries.__proto__, 'a stored string');
});

test('acquireVsCodeApi state and messages preserve the native webview protocol', () => {
  const f = fixture();
  const api = f.sandbox.acquireVsCodeApi();
  assert.equal(api.getState(), undefined);
  assert.equal(api.setState('kept'), 'kept');
  assert.equal(api.getState(), 'kept');
  api.postMessage({ type: 'ready' });
  assert.equal(f.sent[0].phosphorusWebviewState, 'kept');
  assert.equal(f.sent[1].phosphorusWebview.type, 'ready');
});
