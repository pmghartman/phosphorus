import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { extensionHostHTML } from '../src/sulfur/extension-host.js';

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(setImmediate); };

function frame(code, vscode = {}) {
  const messages = [], listeners = new Map();
  const port = {
    postMessage(message) {
      messages.push(message);
      if (message.t === 'call') queueMicrotask(() => port.onmessage({ data: { t: 'ret', id: message.id, v: true } }));
    },
  };
  const sandbox = {
    console: Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, () => {}])),
    addEventListener: (name, fn) => listeners.set(name, fn),
    structuredClone, AbortController, TextEncoder, TextDecoder, URL, Blob, fetch,
  };
  // Execute precisely the script sent to the opaque frame: none of the parent's
  // module bindings are in scope, including the imported VS Code factory.
  const html = extensionHostHTML();
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  vm.runInNewContext(script, sandbox);
  listeners.get('message')({ data: { t: 'init', code, context: { id: 'test.extension', extensionPath: 'me/.sulfur/extensions/test.extension', workspace: 'me/project', user: 'me', vscode } }, ports: [port] });
  return { port, messages };
}

test('serialized sandbox activates a CommonJS extension and executes its native command', async () => {
  const f = frame(`const vscode = require('vscode');
    exports.activate = context => {
      context.subscriptions.push(vscode.commands.registerCommand('test.run', () => vscode.workspace.getConfiguration('test').get('answer')));
    };`, { root: 'vscode', defaults: { 'test.answer': 42 } });
  await settle();
  assert.equal(f.messages.some((m) => m.t === 'ready'), true, JSON.stringify(f.messages));
  assert.equal(f.messages.some((m) => m.t === 'fail'), false);
  assert.equal(f.messages.some((m) => m.t === 'call' && m.m === 'commands.register'), true);
  await f.port.onmessage({ data: { t: 'cmd', id: 99, cmd: 'test.run' } });
  await settle();
  assert.equal(f.messages.find((m) => m.t === 'ret' && m.id === 99)?.v, 42);
  await f.port.onmessage({ data: { t: 'deactivate' } });
  assert.equal(f.messages.some((m) => m.t === 'call' && m.m === 'commands.unregister'), true);
});

test('sandbox reports unsupported module imports as activation errors with useful detail', async () => {
  const f = frame(`require('node:fs'); exports.activate = () => {};`);
  await settle();
  assert.match(f.messages.find((m) => m.t === 'fail')?.e || '', /require\('node:fs'\)/);
  assert.equal(f.messages.some((m) => m.t === 'ready'), false);
});

test('sandbox dependency injection survives renamed factory and host bindings', async () => {
  // A parent bundler may rename both bindings; the emitted program still binds
  // its dependency as a parameter, rather than referring to a parent variable.
  const G$ = (api) => ({ vscode: {}, context: {}, deactivate() {} });
  const H$ = function (factory) { globalThis.received = factory({}).context; };
  const html = extensionHostHTML(H$, G$);
  const sandbox = {};
  vm.runInNewContext(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')), sandbox);
  assert.equal(typeof sandbox.received, 'object');
});
