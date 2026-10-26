// VS Code's extension API for a converted extension's web build (internal/sulfur/vsx_web.go):
// the `vscode` module its code requires, made of Sulfur's extension api (the frame's port to
// the workbench, workbench.js's extHostMain). Uris are paths of the home ('/user/...'), as
// the api takes them; webviews and custom editors are Sulfur's webview tabs. What VS Code has
// and this doesn't comes back undefined, said once in the extension's output channel.
//
// One self-contained function: the extension host frame gets it as source text, so it
// reaches nothing outside itself.

export function vscodeShim(api, host) {
  const { call, views, context } = host;
  const said = new Set();
  const missing = (what) => { if (!said.has(what)) { said.add(what); console.warn(`${what} isn't in Sulfur's VS Code API; this extension may not work fully`); } };
  // a namespace whose unknown members are said once, then undefined
  const ns = (name, o) => new Proxy(o, {
    get(t, k) {
      if (k in t || typeof k === 'symbol' || k === 'then' || k === 'toJSON') return t[k];
      missing(`vscode.${name}${name ? '.' : ''}${String(k)}`);
      return undefined;
    },
  });

  // --- small classes ---------------------------------------------------------------------
  class Disposable {
    constructor(fn) { this._fn = fn; }
    static from(...ds) { return new Disposable(() => { for (const d of ds) d?.dispose?.(); }); }
    dispose() { const f = this._fn; this._fn = null; if (f) f(); }
  }
  class EventEmitter {
    constructor() {
      this._fns = new Set();
      this.event = (fn, thisArg, disposables) => {
        const f = thisArg ? fn.bind(thisArg) : fn;
        this._fns.add(f);
        const d = new Disposable(() => this._fns.delete(f));
        if (Array.isArray(disposables)) disposables.push(d);
        return d;
      };
    }
    fire(e) { for (const f of [...this._fns]) { try { f(e); } catch (err) { console.error(err); } } }
    dispose() { this._fns.clear(); }
  }
  const noEvent = () => new Disposable(() => {});
  const normal = (p) => {
    const out = [];
    for (const part of String(p).replace(/\\/g, '/').split('/')) {
      if (part === '..') out.pop(); else if (part && part !== '.') out.push(part);
    }
    return `/${out.join('/')}`;
  };
  class Uri {
    constructor(scheme, authority, path, query, fragment) {
      this.scheme = scheme || 'file'; this.authority = authority || ''; this.path = path || '/'; this.query = query || ''; this.fragment = fragment || '';
    }
    static file(p) { return new Uri('file', '', normal(p)); }
    static parse(s) {
      const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(String(s));
      if (!m) return Uri.file(s);
      let p = m[3] || '/';
      try { p = decodeURIComponent(p); } catch {}
      return new Uri(m[1].toLowerCase(), m[2] || '', p, m[4] || '', m[5] || '');
    }
    static joinPath(base, ...parts) { return base.with({ path: normal([base.path, ...parts].join('/')) }); }
    static from(c) { return new Uri(c.scheme, c.authority, c.path, c.query, c.fragment); }
    static isUri(v) { return v instanceof Uri; }
    get fsPath() { return this.path; }
    with(c = {}) { return new Uri(c.scheme ?? this.scheme, c.authority ?? this.authority, c.path ?? this.path, c.query ?? this.query, c.fragment ?? this.fragment); }
    toString(skipEncoding = false) {
      const path = skipEncoding ? this.path : this.path.split('/').map(encodeURIComponent).join('/');
      const slashes = this.authority || this.scheme === 'file' || this.scheme === 'http' || this.scheme === 'https' ? `//${this.authority}` : '';
      return `${this.scheme}:${slashes}${path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
    }
    toJSON() { return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment }; }
  }
  const pathOf = (u) => (u instanceof Uri ? u.path : typeof u === 'string' ? (u.includes(':') ? Uri.parse(u).path : u) : u && typeof u.path === 'string' ? u.path : String(u));
  // what crosses the port: uris as their paths
  const plain = (v) => (v instanceof Uri ? v.path : Array.isArray(v) ? v.map(plain) : v);
  class Position {
    constructor(line, character) { this.line = line; this.character = character; }
    translate(dl = 0, dc = 0) { return new Position(this.line + (typeof dl === 'object' ? dl.lineDelta || 0 : dl), this.character + (typeof dl === 'object' ? dl.characterDelta || 0 : dc)); }
    with(line = this.line, character = this.character) { return new Position(line, character); }
    isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
    isEqual(o) { return this.line === o.line && this.character === o.character; }
  }
  class Range {
    constructor(a, b, c, d) {
      if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; }
    }
    get isEmpty() { return this.start.isEqual(this.end); }
  }
  class Selection extends Range {
    constructor(a, b, c, d) { super(a, b, c, d); this.anchor = this.start; this.active = this.end; }
  }
  class ThemeColor { constructor(id) { this.id = id; } }
  class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
  ThemeIcon.File = new ThemeIcon('file'); ThemeIcon.Folder = new ThemeIcon('folder');
  class MarkdownString {
    constructor(value = '', supportThemeIcons = false) { this.value = value; this.supportThemeIcons = supportThemeIcons; }
    appendText(t) { this.value += String(t).replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&'); return this; }
    appendMarkdown(t) { this.value += t; return this; }
    appendCodeblock(code, lang = '') { this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`; return this; }
  }
  class TreeItem { constructor(label, collapsibleState = 0) { this.label = label; this.collapsibleState = collapsibleState; } }
  class CancellationTokenSource {
    constructor() { const e = new EventEmitter(); this.token = { isCancellationRequested: false, onCancellationRequested: e.event }; this._e = e; }
    cancel() { this.token.isCancellationRequested = true; this._e.fire(); }
    dispose() { this._e.dispose(); }
  }
  const token = new CancellationTokenSource().token;
  class RelativePattern { constructor(base, pattern) { this.base = typeof base === 'string' ? base : pathOf(base.uri || base); this.baseUri = Uri.file(this.base); this.pattern = pattern; } }
  class FileSystemError extends Error {
    constructor(m) { super(String(m instanceof Uri ? m.path : m || 'file system error')); this.code = 'Unknown'; }
    static FileNotFound(m) { const e = new FileSystemError(m); e.code = 'FileNotFound'; return e; }
    static FileExists(m) { const e = new FileSystemError(m); e.code = 'FileExists'; return e; }
    static NoPermissions(m) { const e = new FileSystemError(m); e.code = 'NoPermissions'; return e; }
    static Unavailable(m) { const e = new FileSystemError(m); e.code = 'Unavailable'; return e; }
  }
  class Diagnostic { constructor(range, message, severity = 0) { this.range = range; this.message = message; this.severity = severity; } }
  class SnippetString { constructor(value = '') { this.value = value; } }
  class TextEdit {
    constructor(range, newText) { this.range = range; this.newText = newText; }
    static replace(r, t) { return new TextEdit(r, t); }
    static insert(p, t) { return new TextEdit(new Range(p, p), t); }
    static delete(r) { return new TextEdit(r, ''); }
  }
  class WorkspaceEdit { constructor() { this._edits = []; } replace(uri, range, text) { this._edits.push({ uri, range, text }); } insert(uri, p, text) { this.replace(uri, new Range(p, p), text); } delete(uri, range) { this.replace(uri, range, ''); } }

  // --- text documents -------------------------------------------------------------------------
  function textDocument(uri, text, languageId = '') {
    const lines = text.split(/\r?\n/);
    const offsetAt = (p) => { let o = 0; for (let i = 0; i < p.line && i < lines.length; i++) o += lines[i].length + 1; return o + p.character; };
    return {
      uri, fileName: uri.path, languageId: languageId || (uri.path.split('.').pop() || '').toLowerCase(), version: 1, isDirty: false, isClosed: false, isUntitled: false, eol: 1, lineCount: lines.length,
      getText: (r) => (r ? text.slice(offsetAt(r.start), offsetAt(r.end)) : text),
      lineAt: (n) => { const i = typeof n === 'number' ? n : n.line; const t = lines[i] ?? ''; return { lineNumber: i, text: t, range: new Range(i, 0, i, t.length), isEmptyOrWhitespace: !t.trim(), firstNonWhitespaceCharacterIndex: t.length - t.trimStart().length }; },
      offsetAt,
      positionAt: (o) => { let n = 0; for (let i = 0; i < lines.length; i++) { if (o <= n + lines[i].length) return new Position(i, o - n); n += lines[i].length + 1; } return new Position(lines.length - 1, lines[lines.length - 1].length); },
      save: async () => { await call('workspace.write', uri.path, text); return true; },
    };
  }
  async function openTextDocument(arg) {
    if (arg && typeof arg === 'object' && !(arg instanceof Uri) && !arg.path) return textDocument(Uri.parse('untitled:Untitled-1'), String(arg.content || ''), arg.language);
    const uri = arg instanceof Uri ? arg : Uri.file(pathOf(arg));
    return textDocument(uri, await call('workspace.read', uri.path));
  }

  // --- webviews and custom editors ---------------------------------------------------------------
  // a webview's own files load as data: urls the workbench makes of these
  const cspSource = "data: blob: 'self'";
  const asWebviewUri = (u) => (u instanceof Uri ? u : Uri.parse(String(u))).with({ scheme: 'sulfur-res', authority: '' });
  const panels = new Map();
  let wvSeq = 0;
  function makePanel(id, viewType, title, options = {}) {
    const msgs = new EventEmitter(), disposed = new EventEmitter(), state = new EventEmitter();
    const fns = new Set([(m) => msgs.fire(m)]);
    views.set(id, fns);
    let html = '';
    let opts = { ...options };
    const webview = {
      get html() { return html; },
      set html(h) { html = String(h); call('webview.html', id, html).catch((e) => console.error(e.message)); },
      get options() { return opts; },
      set options(o) { opts = { ...o }; },
      cspSource,
      asWebviewUri,
      postMessage: (m) => call('webview.post', id, m).then(() => true, () => false),
      onDidReceiveMessage: msgs.event,
    };
    let panelTitle = title;
    const panel = {
      viewType, webview, options: opts, viewColumn: 1, active: true, visible: true,
      get title() { return panelTitle; },
      set title(t) { panelTitle = String(t); call('webview.title', id, panelTitle).catch(() => {}); },
      iconPath: undefined,
      reveal: () => { call('webview.reveal', id).catch(() => {}); },
      dispose: () => { if (!panels.has(id)) return; panels.delete(id); views.delete(id); call('webview.dispose', id).catch(() => {}); disposed.fire(); },
      onDidDispose: disposed.event,
      onDidChangeViewState: state.event,
      _closed: () => { if (!panels.has(id)) return; panels.delete(id); views.delete(id); disposed.fire(); },
    };
    panels.set(id, panel);
    return panel;
  }
  function createWebviewPanel(viewType, title, showOptions, options = {}) {
    wvSeq += 1;
    const id = `vw${wvSeq}`;
    call('webview.create', id, String(title || viewType), '', { compat: true, viewType }).catch((e) => console.error(e.message));
    return makePanel(id, viewType, String(title || viewType), options);
  }
  const customEditors = new Map();
  const webviewViews = new Map();

  // --- configuration: the extension's own defaults, changes kept for the session ---------------------
  const defaults = context.vscode?.defaults || {};
  const changed = {};
  const configEvents = new EventEmitter();
  function getConfiguration(section = '') {
    const full = (k) => (section ? (k ? `${section}.${k}` : section) : k);
    const value = (k) => {
      const key = full(k);
      if (key in changed) return changed[key];
      if (key in defaults) return defaults[key];
      // a section asked for as an object: its keys gathered
      const prefix = `${key}.`;
      const out = {};
      let any = false;
      for (const [d, v] of Object.entries({ ...defaults, ...changed })) if (d.startsWith(prefix)) { out[d.slice(prefix.length)] = v; any = true; }
      return any ? out : undefined;
    };
    const cfg = {
      get: (k, def) => { const v = value(k); return v === undefined ? def : v; },
      has: (k) => value(k) !== undefined,
      inspect: (k) => ({ key: full(k), defaultValue: defaults[full(k)], globalValue: changed[full(k)] }),
      update: async (k, v) => { changed[full(k)] = v; configEvents.fire({ affectsConfiguration: (s) => full(k) === s || full(k).startsWith(`${s}.`) }); },
    };
    return new Proxy(cfg, { get: (t, k) => (k in t ? t[k] : typeof k === 'string' ? value(k) : undefined) });
  }

  // --- state ----------------------------------------------------------------------------------------
  function memento(scope) {
    const data = { ...(context.vscode?.state?.[scope] || {}) };
    return {
      keys: () => Object.keys(data),
      get: (k, def) => (k in data ? data[k] : def),
      update: async (k, v) => { if (v === undefined) delete data[k]; else data[k] = v; await call('state.set', scope, data); },
      setKeysForSync() {},
    };
  }

  const root = normal(`/${context.extensionPath}/${context.vscode?.root || ''}`);
  const extensionUri = Uri.file(root);
  const workspaceUri = Uri.file(`/${context.workspace || ''}`);
  const dark = context.vscode?.dark !== false;
  const packageJSON = context.vscode?.packageJSON || {};
  const extensionId = context.vscode?.id || context.id;

  // --- window -------------------------------------------------------------------------------------------
  const show = (kind) => async (message, ...rest) => {
    if (rest[0] && typeof rest[0] === 'object' && !('title' in rest[0])) rest = rest.slice(1);
    const items = rest.filter((x) => x !== undefined);
    const labels = items.map((x) => (typeof x === 'string' ? x : String(x.title)));
    const picked = await call('window.message', kind, String(message), labels);
    const i = labels.indexOf(picked);
    return i < 0 ? undefined : items[i];
  };
  const statusBarItem = (a, b, c) => {
    const [alignment, priority] = typeof a === 'string' ? [b, c] : [a, b];
    const it = api.window.createStatusBarItem({ align: alignment === 2 ? 'right' : 'left', priority: priority || 0 });
    const props = { text: '', tooltip: '', command: '' };
    let shown = false;
    const sync = () => { if (shown) it.update({ text: props.text.replace(/\$\([\w-]+\)\s*/g, ''), tooltip: typeof props.tooltip === 'string' ? props.tooltip : props.tooltip?.value || '', command: typeof props.command === 'string' ? props.command : props.command?.command || '' }); };
    return new Proxy({ show: () => { shown = true; sync(); }, hide: () => { shown = false; it.hide(); }, dispose: () => { shown = false; it.dispose(); } }, {
      get: (t, k) => (k in t ? t[k] : props[k]),
      set: (t, k, v) => { props[k] = v ?? ''; sync(); return true; },
    });
  };
  const outputChannel = (name) => {
    const ch = api.window.createOutputChannel(String(name));
    const line = (lvl) => (m, ...a) => ch.appendLine(`[${lvl}] ${[m, ...a].map((x) => (x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ')}`);
    return { name: String(name), logLevel: 2, onDidChangeLogLevel: noEvent, append: (t) => ch.append(String(t)), appendLine: (t) => ch.appendLine(String(t)), replace: (t) => { ch.clear(); ch.append(String(t)); }, clear: () => ch.clear(), show: () => ch.show(), hide() {}, dispose() {}, trace: line('trace'), debug: line('debug'), info: line('info'), warn: line('warn'), error: line('error') };
  };
  const window = ns('window', {
    showInformationMessage: show('info'),
    showWarningMessage: show('warning'),
    showErrorMessage: show('error'),
    showQuickPick: async (items, opts = {}) => {
      const list = await items;
      const plainItems = list.map((x) => (typeof x === 'string' ? x : { label: String(x.label).replace(/\$\([\w-]+\)\s*/g, ''), description: x.description, detail: x.detail }));
      const got = await call('window.quickPick', plainItems, { placeholder: opts.placeHolder, title: opts.title, matchOnDescription: opts.matchOnDescription });
      if (got === undefined || got === null) return undefined;
      const i = plainItems.findIndex((x) => (typeof x === 'string' ? x === got : x.label === got.label && x.description === got.description));
      return i < 0 ? undefined : opts.canPickMany ? [list[i]] : list[i];
    },
    showInputBox: async (opts = {}) => { const v = await call('window.inputBox', { prompt: opts.prompt, value: opts.value, placeholder: opts.placeHolder, title: opts.title }); return v === null ? undefined : v; },
    showSaveDialog: async (opts = {}) => { const p = await call('window.saveDialog', opts.defaultUri ? pathOf(opts.defaultUri) : '', opts.title || opts.saveLabel || 'Save As'); return p ? Uri.file(p) : undefined; },
    showOpenDialog: async (opts = {}) => { const p = await call('window.openDialog', opts.defaultUri ? pathOf(opts.defaultUri) : '', opts.title || opts.openLabel || 'Open'); return p ? [Uri.file(p)] : undefined; },
    showWorkspaceFolderPick: async () => ({ uri: workspaceUri, name: workspaceUri.path.split('/').pop(), index: 0 }),
    setStatusBarMessage: (t) => { api.window.setStatusBarMessage(String(t)); return new Disposable(() => {}); },
    withProgress: async (opts, task) => task({ report() {} }, token),
    createOutputChannel: outputChannel,
    createStatusBarItem: statusBarItem,
    createWebviewPanel,
    registerCustomEditorProvider(viewType, provider, options = {}) {
      customEditors.set(viewType, { provider, options });
      call('customEditor.register', viewType).catch((e) => console.error(e.message));
      return new Disposable(() => customEditors.delete(viewType));
    },
    registerWebviewViewProvider(viewId, provider, options = {}) {
      // a sidebar webview opened as a tab, from the palette
      webviewViews.set(viewId, { provider, options });
      const cmd = `${viewId}.sulfur.open`;
      api.commands.register(cmd, () => openWebviewView(viewId));
      return new Disposable(() => webviewViews.delete(viewId));
    },
    registerWebviewPanelSerializer: () => new Disposable(() => {}),
    registerTreeDataProvider: (id) => { missing(`vscode.window.registerTreeDataProvider (${id})`); return new Disposable(() => {}); },
    createTreeView: (id) => { missing(`vscode.window.createTreeView (${id})`); return { onDidChangeSelection: noEvent, onDidChangeVisibility: noEvent, onDidCollapseElement: noEvent, onDidExpandElement: noEvent, reveal: async () => {}, dispose() {}, visible: false, selection: [] }; },
    createTerminal: (o = {}) => {
      const name = typeof o === 'string' ? o : o.name || 'Terminal';
      return { name, processId: Promise.resolve(undefined), sendText: (t, nl = true) => api.terminal.run(nl ? String(t) : String(t), { name }), show() {}, hide() {}, dispose() {} };
    },
    showTextDocument: async (d) => { const u = d?.uri || d; await api.workspace.openFile(pathOf(u)); return undefined; },
    activeTextEditor: undefined,
    visibleTextEditors: [],
    terminals: [],
    activeColorTheme: { kind: dark ? 2 : 1 },
    state: { focused: true, active: true },
    tabGroups: { all: [], activeTabGroup: { tabs: [], viewColumn: 1 }, onDidChangeTabs: noEvent, onDidChangeTabGroups: noEvent },
    onDidChangeActiveTextEditor: noEvent,
    onDidChangeVisibleTextEditors: noEvent,
    onDidChangeTextEditorSelection: noEvent,
    onDidChangeWindowState: noEvent,
    onDidChangeActiveColorTheme: noEvent,
    onDidOpenTerminal: noEvent,
    onDidCloseTerminal: noEvent,
  });

  async function openWebviewView(viewId) {
    const v = webviewViews.get(viewId);
    if (!v) return;
    const panel = createWebviewPanel(viewId, viewId.split('.').pop(), 1, v.options.webviewOptions || {});
    const view = { viewType: viewId, webview: panel.webview, title: panel.title, description: '', badge: undefined, visible: true, show() { panel.reveal(); }, onDidDispose: panel.onDidDispose, onDidChangeVisibility: noEvent };
    await v.provider.resolveWebviewView(view, { state: undefined }, token);
  }

  // --- workspace ---------------------------------------------------------------------------------------
  const folder = { uri: workspaceUri, name: workspaceUri.path.split('/').pop() || 'home', index: 0 };
  const fs = {
    readFile: async (u) => { try { return await call('workspace.readBytes', pathOf(u)); } catch (e) { throw FileSystemError.FileNotFound(`${pathOf(u)}: ${e.message}`); } },
    writeFile: (u, bytes) => call('workspace.writeBytes', pathOf(u), bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)),
    stat: async (u) => { const s = await call('workspace.stat', pathOf(u)); if (!s) throw FileSystemError.FileNotFound(u); return s; },
    readDirectory: async (u) => (await call('workspace.list', pathOf(u))).map((e) => [e.name, e.dir ? 2 : 1]),
    createDirectory: async (u) => call('workspace.mkdir', pathOf(u)),
    delete: async (u) => { missing('vscode.workspace.fs.delete'); throw FileSystemError.NoPermissions(u); },
    rename: async (u) => { missing('vscode.workspace.fs.rename'); throw FileSystemError.NoPermissions(u); },
    copy: async (a, b) => fs.writeFile(b, await fs.readFile(a)),
    isWritableFileSystem: () => true,
  };
  const workspace = ns('workspace', {
    fs,
    workspaceFolders: [folder],
    name: folder.name,
    rootPath: workspaceUri.path,
    workspaceFile: undefined,
    isTrusted: true,
    textDocuments: [],
    getWorkspaceFolder: (u) => (pathOf(u).startsWith(`${workspaceUri.path}/`) || pathOf(u) === workspaceUri.path ? folder : undefined),
    asRelativePath: (u) => { const p = pathOf(u); return p.startsWith(`${workspaceUri.path}/`) ? p.slice(workspaceUri.path.length + 1) : p; },
    getConfiguration,
    openTextDocument,
    findFiles: async () => { missing('vscode.workspace.findFiles'); return []; },
    applyEdit: async () => { missing('vscode.workspace.applyEdit'); return false; },
    createFileSystemWatcher: () => ({ onDidChange: noEvent, onDidCreate: noEvent, onDidDelete: noEvent, dispose() {} }),
    registerFileSystemProvider: (scheme) => { missing(`vscode.workspace.registerFileSystemProvider (${scheme})`); return new Disposable(() => {}); },
    registerTextDocumentContentProvider: () => new Disposable(() => {}),
    onDidChangeConfiguration: configEvents.event,
    onDidSaveTextDocument: (fn) => api.workspace.onDidSaveFile(async ({ path }) => fn(textDocument(Uri.file(`/${path}`), ''))),
    onDidOpenTextDocument: noEvent,
    onDidCloseTextDocument: noEvent,
    onDidChangeTextDocument: noEvent,
    onDidChangeWorkspaceFolders: noEvent,
    onDidCreateFiles: noEvent,
    onDidDeleteFiles: noEvent,
    onDidRenameFiles: noEvent,
    onDidGrantWorkspaceTrust: noEvent,
  });

  // --- commands -----------------------------------------------------------------------------------------
  const commands = ns('commands', {
    registerCommand: (id, fn, thisArg) => { const d = api.commands.register(id, (...a) => fn.apply(thisArg, a)); return new Disposable(() => d.dispose()); },
    registerTextEditorCommand: (id, fn, thisArg) => { const d = api.commands.register(id, (...a) => fn.apply(thisArg, [undefined, undefined, ...a])); return new Disposable(() => d.dispose()); },
    executeCommand: async (id, ...args) => {
      switch (id) {
        case 'vscode.open': return api.workspace.openFile(pathOf(args[0]));
        case 'vscode.openWith': return call('customEditor.open', pathOf(args[0]), String(args[1] || ''));
        case 'setContext': return undefined;
        case 'workbench.action.openSettings': return api.commands.execute('workbench.action.openSettings');
        default: return api.commands.execute(id, ...args.map(plain));
      }
    },
    getCommands: async () => [],
  });

  // --- the rest -------------------------------------------------------------------------------------------
  const env = ns('env', {
    appName: 'Sulfur', appHost: 'web', appRoot: '', language: 'en', uriScheme: 'sulfur', uiKind: 2, remoteName: undefined, shell: '',
    machineId: `sulfur-${context.user || 'user'}`, sessionId: `sulfur-${Date.now()}`, isNewAppInstall: false, isTelemetryEnabled: false,
    clipboard: { readText: async () => '', writeText: (t) => call('env.clipboard', String(t)) },
    openExternal: async (u) => call('env.openExternal', String(u)),
    asExternalUri: async (u) => u,
    onDidChangeTelemetryEnabled: noEvent,
    onDidChangeShell: noEvent,
    createTelemetryLogger: () => ({ logUsage() {}, logError() {}, dispose() {}, onDidChangeEnableStates: noEvent, isUsageEnabled: false, isErrorsEnabled: false }),
  });
  const l10n = {
    t: (m, ...args) => {
      const msg = typeof m === 'object' ? m.message : m;
      const a = typeof m === 'object' ? m.args || [] : args;
      const named = a.length === 1 && a[0] && typeof a[0] === 'object' ? a[0] : null;
      return String(msg).replace(/\{(\w+)\}/g, (all, k) => { const v = named ? named[k] : a[k]; return v === undefined ? all : String(v); });
    },
    bundle: undefined,
    uri: undefined,
  };
  const languages = new Proxy({
    createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, forEach() {}, get: () => [], has: () => false, dispose() {} }),
    getLanguages: async () => [],
    match: () => 0,
    setTextDocumentLanguage: async (d) => d,
    onDidChangeDiagnostics: noEvent,
    getDiagnostics: () => [],
  }, {
    get(t, k) {
      if (k in t) return t[k];
      // providers: Sulfur's language features come from its language servers
      if (typeof k === 'string' && k.startsWith('register')) return () => { missing(`vscode.languages.${k}`); return new Disposable(() => {}); };
      return undefined;
    },
  });
  const extension = { id: extensionId, extensionUri, extensionPath: extensionUri.path, packageJSON, isActive: true, exports: undefined, extensionKind: 2 };
  const extensions = { getExtension: (id) => (String(id).toLowerCase() === String(extensionId).toLowerCase() ? extension : undefined), all: [extension], onDidChange: noEvent };

  const vscode = new Proxy({
    version: '1.95.0',
    Uri, EventEmitter, Disposable, Position, Range, Selection, ThemeColor, ThemeIcon, MarkdownString, TreeItem, CancellationTokenSource,
    RelativePattern, FileSystemError, Diagnostic, SnippetString, TextEdit, WorkspaceEdit,
    Location: class { constructor(uri, range) { this.uri = uri; this.range = range; } },
    ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    UIKind: { Desktop: 1, Web: 2 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ExtensionKind: { UI: 1, Workspace: 2 },
    EndOfLine: { LF: 1, CRLF: 2 },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
    window, workspace, commands, env, l10n, languages, extensions,
  }, {
    get(t, k) {
      if (k in t || typeof k === 'symbol' || k === 'then' || k === '__esModule' || k === 'default') return k === 'default' ? t : t[k];
      missing(`vscode.${String(k)}`);
      return undefined;
    },
  });

  const subscriptions = [];
  const extensionContext = {
    subscriptions,
    extensionUri,
    extensionPath: extensionUri.path,
    extension,
    globalState: memento('global'),
    workspaceState: memento('workspace'),
    secrets: (() => { const s = new Map(); const e = new EventEmitter(); return { get: async (k) => s.get(k), store: async (k, v) => { s.set(k, v); e.fire({ key: k }); }, delete: async (k) => { s.delete(k); e.fire({ key: k }); }, onDidChange: e.event }; })(),
    storageUri: undefined,
    globalStorageUri: Uri.joinPath(extensionUri, '..', '.storage'),
    logUri: Uri.joinPath(extensionUri, '..', '.log'),
    storagePath: undefined,
    globalStoragePath: `${root}/../.storage`,
    logPath: `${root}/../.log`,
    extensionMode: 1,
    environmentVariableCollection: { persistent: false, replace() {}, append() {}, prepend() {}, get() {}, forEach() {}, delete() {}, clear() {}, getScoped() { return this; } },
    asAbsolutePath: (rel) => normal(`${root}/${rel}`),
    languageModelAccessInformation: { onDidChange: noEvent, canSendRequest: () => undefined },
  };

  return {
    vscode,
    context: extensionContext,
    // the workbench opening a file with one of its custom editors, in the webview tab it made
    async resolveCustomEditor({ viewType, path, wid, title }) {
      const reg = customEditors.get(viewType);
      if (!reg) throw new Error(`no custom editor '${viewType}' is registered`);
      const uri = Uri.file(path);
      const panel = makePanel(wid, viewType, title, reg.options?.webviewOptions || {});
      if (typeof reg.provider.resolveCustomTextEditor === 'function') {
        await reg.provider.resolveCustomTextEditor(await openTextDocument(uri), panel, token);
      } else {
        const doc = await reg.provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
        panel.onDidDispose(() => { try { doc?.dispose?.(); } catch (err) { console.error(err); } });
        await reg.provider.resolveCustomEditor(doc, panel, token);
      }
      return true;
    },
    // its tab closed in the workbench
    closed(wid) { panels.get(wid)?._closed(); },
    deactivate() { for (const d of subscriptions.splice(0)) { try { d?.dispose?.(); } catch (err) { console.error(err); } } },
  };
}
