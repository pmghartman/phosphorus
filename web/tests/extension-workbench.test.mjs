import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createWebviewResources, navigateWebview, deliverWebviewDocument } from '../src/sulfur/webview-resources.js';
import { webviewBridge } from '../src/sulfur/webview-bridge.js';
import { installExtensionResources } from '../src/sulfur/extension-resources.js';

const source = readFileSync(new URL('../src/sulfur/workbench.js', import.meta.url), 'utf8');
const functionSource = (name) => {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  return `${source.slice(start - 6, start) === 'async ' ? 'async ' : ''}${source.slice(start, source.indexOf('\n}', start) + 2)}`;
};
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
function harness() {
  const sent = [], reads = [], errors = [];
  const frame = { contentWindow: { postMessage: (value) => sent.push(value) }, setAttribute() {}, removeAttribute() {} };
  const extension = { id: 'pub.viewer', dir: 'me/extensions/pub.viewer', views: new Map(), manifest: {}, pending: new Map() };
  const view = { frame, compat: true, options: {}, state: null };
  extension.views.set('v1', view);
  const I = { w: { node: {} }, exts: new Map([[extension.id, extension]]), st: { root: 'me/project' } };
  const sandbox = { I, console, crypto, TextDecoder, TextEncoder, Uint8Array, Response, createWebviewResources, navigateWebview, deliverWebviewDocument, webviewBridge, installExtensionResources,
    getComputedStyle: () => ({ colorScheme: 'dark', getPropertyValue: (key) => key.includes('font') || key.includes('mono') || key.includes('ui') ? 'monospace' : '#123456' }),
    setting: () => '', extState: () => ({}), extChannel: () => 'channel', log: (message) => errors.push(message),
    cleanPath: (path) => String(path).replace(/^\//, ''), under: (path, root) => path === root || path.startsWith(`${root}/`),
    extPath: (path) => ({ path: String(path).replace(/^\//, ''), loc: {} }), isHomeLoc: () => true, HOME: 'home',
    filesApi: (host, op, { path }) => path,
    fetch: async (path) => { reads.push(path); return new Response('body { color: red; }'); },
  };
  const constant = (name) => { const start = source.indexOf(`const ${name} = {`); return source.slice(start, source.indexOf('\n};', start) + 3); };
  vm.createContext(sandbox);
  vm.runInContext(`${constant('VSCODE_VARS')}\n${['webviewTheme', 'vscodeWebviewDoc', 'onWebviewMessage'].map(functionSource).join('\n')}\n${constant('EXT_CALLS')}\nglobalThis.extensionCalls = EXT_CALLS;`, sandbox);
  return { extension, view, frame, sent, reads, errors, sandbox, calls: sandbox.extensionCalls };
}

test('webview messages wait for its current document and stale readiness cannot flush them', async () => {
  const h = harness();
  await h.calls['webview.html'](h.extension, 'v1', '<h1>Demo</h1>');
  assert.equal(h.calls['webview.post'](h.extension, 'v1', { ready: 'application' }), true);
  assert.equal(h.sent.length, 0);
  h.sandbox.onWebviewMessage({ source: h.frame.contentWindow, data: { sulfurWebviewLoaded: h.view.revision - 1 } });
  assert.equal(h.sent.length, 0);
  h.sandbox.onWebviewMessage({ source: {}, data: { sulfurWebviewLoaded: h.view.revision } });
  assert.equal(h.sent.length, 0);
  h.sandbox.onWebviewMessage({ source: h.frame.contentWindow, data: { sulfurWebviewLoaded: h.view.revision } });
  assert.ok(h.sent[0].sulfurWebviewTheme);
  assert.equal(h.sent[1].ready, 'application');
  assert.equal(h.calls['webview.post'](h.extension, 'missing', 'lost'), false);
  h.view.resources.dispose();
});

test('local resource roots apply equally to HTML and dynamic resource fetches', async () => {
  const h = harness();
  h.view.options.localResourceRoots = [{ path: '/me/extensions/pub.viewer/media' }];
  await h.calls['webview.html'](h.extension, 'v1', '<link rel="stylesheet" href="sulfur-res:/me/project/private.css">');
  assert.equal(h.reads.length, 0);
  assert.match(h.errors[0], /outside this webview/);
  h.sandbox.onWebviewMessage({ source: h.frame.contentWindow, data: { sulfurWebviewResource: { id: 1, path: '/me/project/private.css', revision: h.view.revision } } });
  await settle();
  assert.match(h.sent[0].sulfurWebviewResourceResult.error, /outside this webview/);
  const allowed = await h.view.resources.url('sulfur-res:/me/extensions/pub.viewer/media/style.css');
  assert.match(allowed, /^data:text\/css/);
  assert.deepEqual(h.reads, ['me/extensions/pub.viewer/media/style.css']);
  h.view.resources.dispose();
});

test('newer HTML wins if an earlier document finishes loading assets late', async () => {
  const h = harness();
  let finish;
  h.sandbox.fetch = async () => { await new Promise((resolve) => { finish = resolve; }); return new Response('body{}'); };
  const earlier = h.calls['webview.html'](h.extension, 'v1', '<link href="sulfur-res:/me/project/a.css">Old');
  await settle();
  await h.calls['webview.html'](h.extension, 'v1', '<p>New</p>');
  const token = h.view.documentToken;
  finish(); await earlier;
  assert.equal(h.view.documentToken, token);
  assert.match(h.view.pendingHTML, /<p>New<\/p>/);
  assert.doesNotMatch(h.view.pendingHTML, /Old/);
  h.view.resources.dispose();
});
