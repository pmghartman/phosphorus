import { vscodeShim } from './vscode-shim.js';
import { installExtensionResources } from './extension-resources.js';

// the extension host's page: runs in the sandbox, turns the port into the api
export function extensionHostMain(createVSCode, installResources) {
  let port = null;
  let mod = null;
  // a converted VS Code extension's web build: its vscode API (vscode-shim.js)
  let shim = null;
  let resources = null;
  let seq = 0;
  let sbSeq = 0;
  let wvSeq = 0;
  const pending = new Map();
  const cmds = new Map();
  const subs = new Map();
  const providers = new Map();
  const views = new Map();
  const call = (m, ...a) => new Promise((res, rej) => {
    if (!port) { rej(new Error('the extension host is not connected')); return; }
    seq += 1;
    pending.set(seq, { res, rej });
    port.postMessage({ t: 'call', id: seq, m, a });
  });
  const disposable = (fn) => ({ dispose: fn });
  const on = (name) => (fn) => {
    if (!subs.has(name)) { subs.set(name, new Set()); call('events.subscribe', name).catch(() => {}); }
    subs.get(name).add(fn);
    return disposable(() => subs.get(name).delete(fn));
  };
  const message = (kind) => (text, ...actions) => call('window.message', kind, String(text), actions.map(String));
  const api = {
    commands: {
      register(id, fn) {
        cmds.set(id, fn);
        call('commands.register', id).catch((e) => console.error(e.message));
        return disposable(() => { cmds.delete(id); call('commands.unregister', id).catch(() => {}); });
      },
      execute: (id, ...args) => call('commands.execute', id, args),
    },
    window: {
      showInformationMessage: message('info'),
      showWarningMessage: message('warning'),
      showErrorMessage: message('error'),
      showQuickPick: (items, opts = {}) => call('window.quickPick', items, opts),
      showInputBox: (opts = {}) => call('window.inputBox', opts),
      setStatusBarMessage: (text) => call('window.flash', String(text)),
      createStatusBarItem(opts = {}) {
        sbSeq += 1;
        const id = `s${sbSeq}`;
        let props = { text: '', tooltip: '', command: '', align: 'left', priority: 0, ...opts };
        return {
          update(p) { props = { ...props, ...p }; return call('statusBar.set', id, props); },
          show() { return call('statusBar.set', id, props); },
          hide() { return call('statusBar.remove', id); },
          dispose() { return call('statusBar.remove', id); },
        };
      },
      createOutputChannel(name) {
        const n = String(name);
        return {
          append: (t) => call('output.append', n, String(t)),
          appendLine: (t) => call('output.append', n, `${t}\n`),
          clear: () => call('output.clear', n),
          show: () => call('output.show', n),
        };
      },
      createWebviewPanel(opts = {}) {
        wvSeq += 1;
        const id = `w${wvSeq}`;
        const fns = new Set();
        views.set(id, fns);
        call('webview.create', id, String(opts.title || 'Webview'), String(opts.html || ''));
        return {
          post: (msg) => call('webview.post', id, msg),
          setHtml: (h) => call('webview.html', id, String(h)),
          onMessage: (fn) => { fns.add(fn); return disposable(() => fns.delete(fn)); },
          dispose: () => { views.delete(id); return call('webview.dispose', id); },
        };
      },
      onDidChangeActiveEditor: on('activeEditor'),
    },
    workspace: {
      root: () => call('workspace.root'),
      readFile: (p) => call('workspace.read', String(p)),
      writeFile: (p, text) => call('workspace.write', String(p), String(text)),
      list: (p = '') => call('workspace.list', String(p)),
      openFile: (p, opts = {}) => call('workspace.open', String(p), opts),
      onDidSaveFile: on('save'),
      onDidOpenFile: on('open'),
    },
    editor: {
      active: () => call('editor.active'),
      insert: (text) => call('editor.insert', String(text)),
      replaceSelection: (text) => call('editor.insert', String(text)),
      select: (from, to) => call('editor.select', from, to ?? from),
    },
    terminal: {
      hosts: () => call('terminal.hosts'),
      run: (command, opts = {}) => call('terminal.run', String(command), opts),
    },
    runners: {
      register(ext, command) {
        call('runners.register', String(ext), String(command));
        return disposable(() => call('runners.unregister', String(ext)).catch(() => {}));
      },
    },
    agents: {
      registerProvider(opts, handler) {
        const id = String(opts.id);
        providers.set(id, handler);
        call('agents.register', id, String(opts.label || id));
        return disposable(() => { providers.delete(id); call('agents.unregister', id).catch(() => {}); });
      },
    },
    onDidRunFile: on('run'),
  };
  const clone = (v) => { try { return structuredClone(v); } catch { return undefined; } };
  const reply = (id, p) => p.then(
    (v) => port.postMessage({ t: 'ret', id, v: clone(v) }),
    (e) => port.postMessage({ t: 'err', id, e: String((e && e.message) || e) }),
  );
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const was = console[level].bind(console);
    console[level] = (...args) => {
      was(...args);
      const text = args.map((x) => (x instanceof Error ? x.stack || x.message : typeof x === 'object' ? (() => { try { return JSON.stringify(x); } catch { return String(x); } })() : String(x))).join(' ');
      if (port) port.postMessage({ t: 'log', level, text });
    };
  }
  addEventListener('error', (e) => console.error(e.error || e.message));
  addEventListener('unhandledrejection', (e) => console.error(e.reason));
  addEventListener('message', (e) => {
    const d = e.data;
    if (port || !d || d.t !== 'init' || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = async (ev) => {
      const m = ev.data;
      if (m.t === 'ret' || m.t === 'err') {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.t === 'ret') p.res(m.v); else p.rej(new Error(m.e));
      } else if (m.t === 'cmd') {
        reply(m.id, Promise.resolve().then(() => {
          const fn = cmds.get(m.cmd);
          if (!fn) throw new Error(`command '${m.cmd}' isn't registered`);
          return fn(...(m.args || []));
        }));
      } else if (m.t === 'provider') {
        reply(m.id, Promise.resolve().then(() => {
          const fn = providers.get(m.pid);
          if (!fn) throw new Error(`agent '${m.pid}' isn't registered`);
          return fn({ ...m.req, progress: (text) => call('agents.progress', m.rid, String(text)).catch(() => {}) });
        }));
      } else if (m.t === 'event') {
        for (const fn of subs.get(m.name) || []) { try { fn(m.data); } catch (err) { console.error(err); } }
      } else if (m.t === 'webview') {
        for (const fn of views.get(m.wid) || []) { try { fn(m.msg); } catch (err) { console.error(err); } }
      } else if (m.t === 'customEditor') {
        reply(m.id, Promise.resolve().then(() => { if (!shim) throw new Error('not a VS Code extension'); return shim.resolveCustomEditor(m); }));
      } else if (m.t === 'webviewClosed') {
        if (shim) shim.closed(m.wid); else views.delete(m.wid);
      } else if (m.t === 'viewState') {
        shim?.viewState(m.wid, m.state);
      } else if (m.t === 'treeEvent') {
        shim?.treeEvent(m.viewId, m.event);
      } else if (m.t === 'extensionsChanged') {
        shim?.updateExtensions(m.extensions);
      } else if (m.t === 'themeChanged') {
        shim?.themeChanged(m.kind);
      } else if (m.t === 'deactivate') {
        try { await (mod && mod.deactivate && mod.deactivate()); } catch (err) { console.error(err); }
        resources?.dispose();
        port.postMessage({ t: 'bye' });
      }
    };
    if (d.context && d.context.vscode) {
      // CommonJS, as VS Code's web extension host runs it: require('vscode') the shim, nothing else
      Promise.resolve().then(async () => {
        resources = installResources(call);
        shim = createVSCode(api, { call, views, context: d.context });
        const module = { exports: {} };
        const require = (name) => {
          if (name === 'vscode') return shim.vscode;
          throw new Error(`require('${name}'): a VS Code web extension gets only 'vscode' in Sulfur`);
        };
        new Function('module', 'exports', 'require', `${d.code}\n//# sourceURL=${encodeURIComponent(d.context.id)}-web.js`)(module, module.exports, require);
        const ex = module.exports || {};
        mod = { deactivate: async () => { try { if (typeof ex.deactivate === 'function') await ex.deactivate(); } finally { shim.deactivate(); } } };
        if (typeof ex.activate === 'function') await ex.activate(shim.context);
        port.postMessage({ t: 'ready' });
      }).catch((err) => port.postMessage({ t: 'fail', e: String((err && err.stack) || err) }));
      return;
    }
    const url = URL.createObjectURL(new Blob([d.code], { type: 'text/javascript' }));
    import(url).then(async (m) => {
      mod = m;
      if (typeof m.activate !== 'function') throw new Error('the main module exports no activate(api, context)');
      await m.activate(api, d.context);
      port.postMessage({ t: 'ready' });
    }).catch((err) => port.postMessage({ t: 'fail', e: String((err && err.stack) || err) }));
  });
}

// Both functions travel as values: no name in the parent bundle is required in the frame.
export function extensionHostHTML(hostMain = extensionHostMain, createVSCode = vscodeShim, installResources = installExtensionResources) {
  return `<!doctype html><meta charset="utf-8"><title>extension host</title><script>(${hostMain.toString()})(${createVSCode.toString()},${installResources.toString()})<\/script>`;
}
