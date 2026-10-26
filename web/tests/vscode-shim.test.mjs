import test from 'node:test';
import assert from 'node:assert/strict';
import { vscodeShim } from '../src/sulfur/vscode-shim.js';

// a shim over a recording api: each call the workbench would get, answered by answers[m]
function harness(answers = {}, context = {}) {
  const calls = [];
  const views = new Map();
  const call = async (m, ...a) => { calls.push([m, ...a]); const f = answers[m]; return typeof f === 'function' ? f(...a) : f; };
  const registered = new Map();
  const api = {
    commands: { register: (id, fn) => { registered.set(id, fn); return { dispose: () => registered.delete(id) }; }, execute: (id, ...a) => call('commands.execute', id, a) },
    window: {
      createOutputChannel: (n) => ({ append: (t) => call('output.append', n, t), appendLine: (t) => call('output.append', n, `${t}\n`), clear() {}, show() {} }),
      createStatusBarItem: (o) => ({ update: (p) => call('statusBar.set', o, p), hide() {}, dispose() {} }),
      setStatusBarMessage() {},
    },
    workspace: { openFile: (p) => call('workspace.open', p), onDidSaveFile: () => ({ dispose() {} }) },
    terminal: { run: (c, o) => call('terminal.run', c, o) },
  };
  const ctx = { id: 'pub.ext', extensionPath: 'me/.sulfur/extensions/pub.ext', workspace: 'me/project', user: 'me', vscode: { root: 'vscode', id: 'pub.ext', defaults: { 'ext.size': 10, 'ext.view.mode': 'grid' }, state: { global: { seen: 1 } }, packageJSON: { name: 'ext' } }, ...context };
  const shim = vscodeShim(api, { call, views, context: ctx });
  return { shim, vscode: shim.vscode, calls, views, registered };
}

test('uris are paths of the home, joined and printed as VS Code prints them', () => {
  const { vscode, shim } = harness();
  const u = vscode.Uri.file('/me/project/a b.db');
  assert.equal(u.toString(), 'file:///me/project/a%20b.db');
  assert.equal(vscode.Uri.joinPath(u, '..', 'c', './d.txt').path, '/me/project/c/d.txt');
  assert.equal(vscode.Uri.parse('https://example.com/x?y=1').authority, 'example.com');
  assert.equal(shim.context.extensionUri.path, '/me/.sulfur/extensions/pub.ext/vscode');
  assert.equal(shim.context.asAbsolutePath('media/x.css'), '/me/.sulfur/extensions/pub.ext/vscode/media/x.css');
  assert.equal(shim.context.extension.packageJSON.name, 'ext');
});

test('configuration answers the extension\'s own defaults, by key and by section', async () => {
  const { vscode } = harness();
  const c = vscode.workspace.getConfiguration('ext');
  assert.equal(c.get('size'), 10);
  assert.equal(c.get('missing', 'fallback'), 'fallback');
  assert.deepEqual(vscode.workspace.getConfiguration().get('ext.view'), { mode: 'grid' });
  let fired = false;
  vscode.workspace.onDidChangeConfiguration((e) => { fired = e.affectsConfiguration('ext'); });
  await c.update('size', 12);
  assert.equal(vscode.workspace.getConfiguration('ext').get('size'), 12);
  assert.ok(fired);
});

test('messages map their items back, files read as bytes, the state persisted', async () => {
  const { vscode, shim, calls } = harness({ 'window.message': 'Open File', 'workspace.readBytes': () => new Uint8Array([1, 2, 3]), 'workspace.stat': () => ({ type: 1, size: 3 }) });
  const item = { title: 'Open File' };
  assert.equal(await vscode.window.showInformationMessage('Exported', { modal: false }, item), item);
  assert.deepEqual([...await vscode.workspace.fs.readFile(vscode.Uri.file('/me/project/a.db'))], [1, 2, 3]);
  assert.equal((await vscode.workspace.fs.stat(vscode.Uri.file('/me/project/a.db'))).size, 3);
  assert.deepEqual(calls.find((c) => c[0] === 'workspace.readBytes'), ['workspace.readBytes', '/me/project/a.db']);
  assert.equal(shim.context.globalState.get('seen'), 1);
  await shim.context.globalState.update('more', 2);
  assert.deepEqual(calls.at(-1), ['state.set', 'global', { seen: 1, more: 2 }]);
  await vscode.commands.executeCommand('vscode.open', vscode.Uri.file('/me/project/out.csv'));
  assert.deepEqual(calls.at(-1), ['workspace.open', '/me/project/out.csv']);
});

test('a custom editor resolves into the workbench\'s webview, its own files as resources', async () => {
  const { vscode, shim, calls, views } = harness();
  const got = [];
  vscode.window.registerCustomEditorProvider('demo.view', {
    openCustomDocument: (uri) => ({ uri, dispose() { got.push('disposed'); } }),
    resolveCustomEditor(doc, panel) {
      const main = panel.webview.asWebviewUri(vscode.Uri.joinPath(shim.context.extensionUri, 'dist', 'main.js'));
      panel.webview.html = `<html><head><meta http-equiv="Content-Security-Policy" content="script-src ${panel.webview.cspSource}"></head><body><script src="${main}"></script>${doc.uri.path}</body></html>`;
      panel.webview.onDidReceiveMessage((m) => got.push(m));
    },
  });
  assert.deepEqual(calls.find((c) => c[0] === 'customEditor.register'), ['customEditor.register', 'demo.view']);
  await shim.resolveCustomEditor({ viewType: 'demo.view', path: '/me/project/a.db', wid: 'ce1', title: 'a.db' });
  const html = calls.find((c) => c[0] === 'webview.html');
  assert.equal(html[1], 'ce1');
  assert.match(html[2], /src="sulfur-res:\/me\/\.sulfur\/extensions\/pub\.ext\/vscode\/dist\/main\.js"/);
  assert.match(html[2], /script-src data: blob:/);
  assert.match(html[2], /\/me\/project\/a\.db/);
  // the webview's word, through the frame's views, to its listener
  for (const fn of views.get('ce1')) fn({ type: 'ready' });
  assert.deepEqual(got, [{ type: 'ready' }]);
  shim.closed('ce1');
  assert.deepEqual(got, [{ type: 'ready' }, 'disposed']);
  assert.ok(!views.has('ce1'));
  await assert.rejects(shim.resolveCustomEditor({ viewType: 'other', path: '/x', wid: 'ce2' }), /no custom editor/);
});

test('webview panels, commands and terminals reach Sulfur\'s; what\'s missing is said once', async () => {
  const { vscode, calls, registered } = harness();
  const panel = vscode.window.createWebviewPanel('demo.panel', 'Demo', vscode.ViewColumn.One, { enableScripts: true });
  assert.deepEqual(calls.find((c) => c[0] === 'webview.create').slice(1, 5), ['vw1', 'Demo', '', { compat: true, viewType: 'demo.panel' }]);
  assert.equal(await panel.webview.postMessage({ a: 1 }), true);
  let ran = 0;
  vscode.commands.registerCommand('demo.go', function () { ran = this.n; }, { n: 7 });
  await registered.get('demo.go')();
  assert.equal(ran, 7);
  vscode.window.createTerminal({ name: 'build' }).sendText('make');
  assert.deepEqual(calls.at(-1), ['terminal.run', 'make', { name: 'build' }]);
  const warned = [];
  const was = console.warn;
  console.warn = (m) => warned.push(m);
  try {
    assert.equal(vscode.notebooks, undefined);
    assert.equal(vscode.notebooks, undefined);
    assert.equal(vscode.window.createQuickPick, undefined);
    vscode.languages.registerHoverProvider('x', {}).dispose();
  } finally { console.warn = was; }
  assert.deepEqual(warned.map((w) => w.split(' ')[0]), ['vscode.notebooks', 'vscode.window.createQuickPick', 'vscode.languages.registerHoverProvider']);
  assert.equal(vscode.l10n.t('Exported {0} rows to {file}', 3), 'Exported 3 rows to {file}');
  assert.equal(vscode.l10n.t('to {file}', { file: 'a.csv' }), 'to a.csv');
});
