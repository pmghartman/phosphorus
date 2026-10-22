// LSP 3.17 client. Positions and offsets are UTF-16, as in the custom editor.
// The socket belongs to one host, root and active configuration. It never
// downloads packages or starts a server until an installed extension is used.
import { opEdits, opApply } from '../text-operations.js';

export const LANGUAGE_EXTENSIONS = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', java: 'java', cs: 'csharp', php: 'php',
  sh: 'shell', bash: 'shell', c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl', go: 'go',
};
export function languageId(path, extension) {
  if (/\.tsx$/i.test(path)) return 'typescriptreact';
  if (/\.jsx$/i.test(path)) return 'javascriptreact';
  if (extension === 'cpp' && /\.(c|h)$/i.test(path)) return 'c';
  return ({ shell: 'shellscript', hcl: 'terraform' })[extension] || extension;
}
export function positionAt(text, offset) {
  const before = text.slice(0, Math.max(0, Math.min(text.length, offset)));
  return { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 };
}
export function offsetAt(text, position) {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) throw new Error('Invalid language-server position');
  let at = 0;
  for (let n = 0; n < position.line; n++) {
    const end = text.indexOf('\n', at);
    if (end < 0) throw new Error('Language-server line is outside the document');
    at = end + 1;
  }
  let end = text.indexOf('\n', at);
  if (end < 0) end = text.length;
  if (text[end - 1] === '\r') end--;
  if (at + position.character > end) throw new Error('Language-server column is outside the line');
  return at + position.character;
}
export function fileUri(path) {
  const p = path.replace(/\\/g, '/');
  return `file://${p.startsWith('/') ? '' : '/'}${p.split('/').map((part, n) => n === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/')}`;
}
export function uriPath(uri) {
  const u = new URL(uri);
  if (u.protocol !== 'file:' || u.host || u.search || u.hash) throw new Error('Only project file locations are supported');
  return decodeURIComponent(u.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
}
export function relativeUri(rootUri, uri) {
  const root = uriPath(rootUri).replace(/\/$/, '');
  const path = uriPath(uri);
  const windows = /^[A-Za-z]:/.test(root);
  const norm = (x) => windows ? x.toLowerCase() : x;
  if (!norm(path).startsWith(norm(root) + '/') || path.split('/').some((x) => x === '..' || x === '.')) throw new Error('Language-server location is outside this project');
  return path.slice(root.length + 1);
}
export const textEditRanges = (text, edits) => edits.map((e) => ({ from: offsetAt(text, e.range.start), to: offsetAt(text, e.range.end), text: e.newText }));
export const applyTextEdits = (text, edits) => opApply(text, opEdits(text, textEditRanges(text, edits)));
export function completionEdits(item, text, caret, defaults = {}) {
  // snippetSupport is false; do not insert snippet syntax from a nonconforming server.
  if ((item.insertTextFormat || defaults.insertTextFormat) === 2) throw new Error('This completion requires snippets, which this editor does not support');
  const edit = item.textEdit;
  const prefix = text.slice(0, caret).match(/[\p{L}\p{N}_$]*$/u)[0];
  const range = edit?.range || edit?.replace || defaults.editRange?.replace || defaults.editRange || { start: positionAt(text, caret - prefix.length), end: positionAt(text, caret) };
  const newText = edit?.newText ?? item.textEditText ?? item.insertText ?? item.label;
  const edits = textEditRanges(text, [{ range, newText }, ...(item.additionalTextEdits || [])]);
  const ops = opEdits(text, edits);
  return { edits, ops, text: opApply(text, ops), caret: offsetAt(text, range.start) + newText.length + (item.additionalTextEdits || []).reduce((sum, e) => offsetAt(text, e.range.end) <= offsetAt(text, range.start) ? sum + e.newText.length - (offsetAt(text, e.range.end) - offsetAt(text, e.range.start)) : sum, 0) };
}

export function languageSocket(url, request, onEvent = () => {}) {
  const ws = new WebSocket(url.replace(/^http/, 'ws'));
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // A caller can create the connection before awaiting initialize.
  ready.catch(() => {});
  const send = (message) => { if (ws.readyState !== 1) throw new Error('Language server disconnected'); ws.send(JSON.stringify(message)); };
  const rejectAll = (error) => { for (const p of pending.values()) p.reject(error); pending.clear(); readyReject(error); };
  ws.onopen = () => ws.send(JSON.stringify(request));
  ws.onclose = () => { closed = true; rejectAll(new Error('Language server disconnected')); onEvent({ _sulfur: 'closed' }); };
  ws.onerror = () => rejectAll(new Error('Unable to connect to the project host'));
  const client = {
    ready, rootUri: '', capabilities: {}, documents: new Map(), closed: () => closed,
    notify: (method, params) => send({ jsonrpc: '2.0', method, params }),
    async request(method, params, { signal, timeout = 20000 } = {}) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const finish = (fn) => (value) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); pending.delete(id); fn(value); };
        const cancel = () => { try { client.notify('$/cancelRequest', { id }); } catch {} finish(reject)(new DOMException('Cancelled', 'AbortError')); };
        const timer = setTimeout(() => { try { client.notify('$/cancelRequest', { id }); } catch {} finish(reject)(new Error(`${method} timed out`)); }, timeout);
        pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
        signal?.addEventListener('abort', cancel, { once: true });
        try { send({ jsonrpc: '2.0', id, method, params }); } catch (e) { finish(reject)(e); }
      });
    },
    async initialize(settings = {}) {
      await ready;
      const result = await client.request('initialize', {
        processId: null, clientInfo: { name: 'Sulfur', version: '1' }, rootUri: client.rootUri,
        workspaceFolders: [{ uri: client.rootUri, name: uriPath(client.rootUri).split('/').pop() }],
        initializationOptions: settings,
        capabilities: { general: { positionEncodings: ['utf-16'] }, workspace: { configuration: true, workspaceFolders: true, workspaceEdit: { documentChanges: true, resourceOperations: [] } }, textDocument: {
          synchronization: { didSave: true }, completion: { completionItem: { snippetSupport: false, insertReplaceSupport: true, resolveSupport: { properties: ['textEdit', 'additionalTextEdits', 'documentation', 'detail'] } }, completionList: { itemDefaults: ['editRange', 'insertTextFormat', 'data'] } },
          definition: { linkSupport: true }, publishDiagnostics: { versionSupport: true }, rename: { prepareSupport: false },
        } },
      }, { timeout: 90000 });
      client.capabilities = result.capabilities || {};
      if (client.capabilities.positionEncoding && client.capabilities.positionEncoding !== 'utf-16') throw new Error('The server did not negotiate UTF-16 positions');
      client.notify('initialized', {});
      client.settings = settings;
      client.notify('workspace/didChangeConfiguration', { settings });
      return client;
    },
    sync(uri, language, text) {
      const old = client.documents.get(uri);
      if (old?.text === text) return old.version;
      const version = (old?.version || 0) + 1;
      const sync = client.capabilities.textDocumentSync;
      const mode = typeof sync === 'number' ? sync : sync?.change;
      if (!old) client.notify('textDocument/didOpen', { textDocument: { uri, languageId: language, version, text } });
      else if (mode !== 0) client.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: mode === 2 ? [{ range: { start: { line: 0, character: 0 }, end: positionAt(old.text, old.text.length) }, text }] : [{ text }] });
      client.documents.set(uri, { text, version });
      return version;
    },
    closeDocument(uri) { if (client.documents.delete(uri)) client.notify('textDocument/didClose', { textDocument: { uri } }); },
    close() { if (closed) return; closed = true; rejectAll(new Error('Language session stopped')); ws.close(); },
  };
  ws.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message._sulfur) {
      if (message._sulfur === 'ready') { client.rootUri = message.rootUri; readyResolve(message); }
      if (message._sulfur === 'error') rejectAll(new Error(message.error));
      if (message._sulfur === 'status') readyResolve(message);
      if (message._sulfur === 'stopped') client.close();
      onEvent(message);
    } else if (message.method) {
      if (message.id !== undefined) {
        const result = message.method === 'workspace/configuration' ? (message.params?.items || []).map((x) => x.section ? x.section.split('.').reduce((v, key) => v?.[key], client.settings) ?? null : client.settings || {})
          : message.method === 'workspace/workspaceFolders' ? [{ uri: client.rootUri, name: uriPath(client.rootUri).split('/').pop() }]
            : message.method === 'workspace/applyEdit' ? { applied: false, failureReason: 'Use Rename to review edits in Sulfur' } : null;
        send({ jsonrpc: '2.0', id: message.id, result });
      } else onEvent(message);
    } else {
      const p = pending.get(message.id);
      if (p) message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    }
  };
  return client;
}
