import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebviewResources } from '../src/sulfur/webview-resources.js';
import { navigateWebview, deliverWebviewDocument } from '../src/sulfur/webview-resources.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const bytes = (s) => new TextEncoder().encode(s);
const decode = (url) => new TextDecoder().decode(Buffer.from(url.split(',')[1].split('#')[0], 'base64'));

test('webview document handshake rejects stale navigations and sends HTML only once', () => {
  const sent = [], removed = [];
  const view = { frame: { removeAttribute: (name) => removed.push(name), contentWindow: { postMessage: (m) => sent.push(m) } } };
  navigateWebview(view, '<p>old</p>');
  const old = view.documentToken;
  navigateWebview(view, '<p>new</p>');
  assert.equal(deliverWebviewDocument(view, old), false);
  assert.equal(deliverWebviewDocument(view, view.documentToken), true);
  assert.equal(deliverWebviewDocument(view, view.documentToken), false);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].html, '<p>new</p>');
  assert.match(view.frame.src, /^\/sulfur\/webview.html#/);
  assert.deepEqual(removed, ['srcdoc', 'srcdoc']);
});

test('static webview loader accepts only its parent in an opaque sandbox', async () => {
  const html = await readFile(new URL('../static/sulfur/webview.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  const make = (origin) => {
    const listeners = new Map(), written = [], sent = [];
    const parent = { postMessage: (m) => sent.push(m) };
    const sandbox = { origin, parent, location: { hash: '#test-token' }, addEventListener: (n, f) => listeners.set(n, f), removeEventListener: (n) => listeners.delete(n), document: { open() {}, write: (s) => written.push(s), close() {} } };
    sandbox.window = sandbox;
    vm.runInNewContext(script, sandbox);
    return { listeners, written, sent, parent };
  };
  assert.equal(make('https://phosphorus.example').listeners.size, 0, 'must not inject into a privileged document');
  const frame = make('null');
  assert.equal(frame.sent[0].sulfurWebviewReady, 'test-token');
  const receive = frame.listeners.get('message');
  receive({ source: {}, data: { sulfurWebviewToken: 'test-token', html: 'attacker' } });
  receive({ source: frame.parent, data: { sulfurWebviewToken: 'old-token', html: 'stale' } });
  assert.equal(frame.written.length, 0);
  receive({ source: frame.parent, data: { sulfurWebviewToken: 'test-token', html: '<p>expected</p>' } });
  assert.deepEqual(frame.written, ['<p>expected</p>']);
  assert.equal(frame.listeners.size, 0);
});

test('webview assets load concurrently within the bound and repeated URLs share one read', async () => {
  let active = 0, maximum = 0; const calls = [];
  const resources = createWebviewResources(async (path) => {
    calls.push(path); maximum = Math.max(maximum, ++active);
    await new Promise(setImmediate); active--; return bytes(path);
  }, { concurrency: 2 });
  const html = await resources.html('<script src="sulfur-res:/me/a.js"></script><img src="sulfur-res:/me/b.png"><img src="sulfur-res:/me/c.png"><img src="sulfur-res:/me/b.png">');
  assert.equal(maximum, 2);
  assert.equal(calls.length, 3);
  assert.equal(html.includes('sulfur-res:'), false);
  assert.match(html, /data:text\/javascript;base64/);
  await resources.html('<img src="sulfur-res:/me/b.png">');
  assert.equal(calls.length, 3);
  resources.dispose();
});

test('nested stylesheets and fonts resolve relative paths, percent escapes and SVG fragments', async () => {
  const files = {
    '/me/css/main.css': '@import "nested/other.css"; .icon{background:url(../icons/a%20b.svg#check)}',
    '/me/css/nested/other.css': '@font-face{src:url("../../fonts/font.woff2")}',
    '/me/icons/a b.svg': '<svg/>', '/me/fonts/font.woff2': 'font',
  };
  const resources = createWebviewResources(async (p) => { assert.ok(p in files, p); return bytes(files[p]); });
  const css = decode(await resources.url('/me/css/main.css'));
  assert.match(css, /data:image\/svg\+xml;base64,[\w+/=]+#check/);
  const imported = /@import "([^"]+)"/.exec(css)[1];
  assert.match(decode(imported), /data:font\/woff2;base64/);
  resources.dispose();
});

test('concurrent cyclic imports report the cycle instead of deadlocking cached promises', async () => {
  const errors = [];
  const resources = createWebviewResources(async (p) => bytes(p.endsWith('a.css') ? '@import "b.css";' : '@import "a.css";'), { onError: (e) => errors.push(e.message) });
  const result = await resources.html('<link href="sulfur-res:/me/a.css"><link href="sulfur-res:/me/b.css">');
  assert.match(result, /data:text\/css/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Cyclic stylesheet/);
  resources.dispose();
});

test('failed loads may retry and disposal cancels active and queued reads', async () => {
  let attempts = 0;
  const resources = createWebviewResources(async () => { if (++attempts === 1) throw Error('unavailable'); return bytes('ok'); });
  await assert.rejects(resources.url('/me/a.js'), /unavailable/);
  assert.equal(decode(await resources.url('/me/a.js')), 'ok');
  resources.dispose();
  let reads = 0;
  const pending = createWebviewResources((p, signal) => new Promise((resolve, reject) => {
    reads++; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }), { concurrency: 1 });
  const jobs = ['/a.js', '/b.js', '/c.js'].map((p) => pending.url(p));
  pending.dispose();
  const result = await Promise.allSettled(jobs);
  assert.equal(reads, 1);
  assert.ok(result.every((r) => r.status === 'rejected'));
});
