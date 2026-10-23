// LSP 3.17 client. Positions and offsets are UTF-16, as in the custom editor.
// The socket belongs to one host, root and active configuration. It never
// downloads packages or starts a server until an installed extension is used.
import { opEdits, opApply, commonEnds } from '../text-operations.js';
import { TOKEN_TYPES, TOKEN_MODIFIERS } from './semantic-tokens.js';
import { expandSnippet, wordStart, wordEnd } from './completion.js';

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
export function serverSettings(extension, context) {
  const user = context.settings?.[extension] || {};
  return {
    ...user,
    ...(extension === 'csharp' ? { csharp: { analyzersEnabled: context.analyzersEnabled ?? true, useMetadataUris: true, applyFormattingOptions: true, ...(context.solutionPath ? { solutionPathOverride: context.solutionPath } : {}), ...(user.csharp || user) } } : {}),
    sulfur: { configuration: context.configuration, buildDirectory: context.buildDirectory },
  };
}
// Line starts of the last few texts asked about: diagnostics, edits and every keystroke's
// sync convert many positions of the same text, each a bisection rather than a scan
const lineIndexes = [];
function lineIndex(text) {
  for (const x of lineIndexes) if (x.text === text) return x.starts;
  const starts = [0];
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  lineIndexes.unshift({ text, starts });
  if (lineIndexes.length > 3) lineIndexes.pop();
  return starts;
}
export function positionAt(text, offset) {
  const at = Math.max(0, Math.min(text.length, offset));
  const starts = lineIndex(text);
  let lo = 0, hi = starts.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= at) lo = mid + 1; else hi = mid; }
  return { line: lo - 1, character: at - starts[lo - 1] };
}
export function offsetAt(text, position) {
  if (!position || !Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) throw new Error('Invalid language-server position');
  const starts = lineIndex(text);
  if (position.line >= starts.length) throw new Error('Language-server line is outside the document');
  const at = starts[position.line];
  let end = position.line + 1 < starts.length ? starts[position.line + 1] - 1 : text.length;
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
// Validate snippet defaults and choices before expansion. Unsupported transforms
// are rejected, never inserted as raw snippet syntax.
export function snippetText(source) {
  let at = 0;
  const values = new Map();
  function read(end = '') {
    let out = '';
    while (at < source.length) {
      const ch = source[at++];
      if (end && ch === end) return out;
      if (ch === '\\' && /[\\$}]/.test(source[at] || ' ')) { out += source[at++]; continue; }
      if (ch !== '$') { out += ch; continue; }
      const id = source.slice(at).match(/^(?:\d+|[A-Za-z_][\w]*)/);
      if (id) { at += id[0].length; out += values.get(id[0]) || ''; continue; }
      if (source[at] !== '{') { out += ch; continue; }
      at++;
      const name = source.slice(at).match(/^(?:\d+|[A-Za-z_][\w]*)/);
      if (!name) throw new Error('Unsupported completion snippet');
      at += name[0].length;
      const kind = source[at++];
      if (kind === '}') { out += values.get(name[0]) || ''; continue; }
      if (kind === ':') { const value = read('}'); values.set(name[0], value); out += value; continue; }
      if (kind === '|') {
        let choice = '', first = true, done = false;
        while (at < source.length) {
          const c = source[at++];
          if (c === '\\') { if (first) choice += source[at]; at++; }
          else if (c === '|' && source[at] === '}') { at++; done = true; break; }
          else if (c === ',') first = false;
          else if (first) choice += c;
        }
        if (!done) throw new Error('Invalid completion snippet');
        values.set(name[0], choice); out += choice; continue;
      }
      throw new Error('Unsupported completion snippet transform');
    }
    if (end) throw new Error('Invalid completion snippet');
    return out;
  }
  read(); at = 0;
  return read();
}
export function completionEdits(item, text, caret, defaults = {}) {
  const edit = item.textEdit;
  const prefix = text.slice(wordStart(text, caret), caret);
  const suffix = text.slice(caret, wordEnd(text, caret));
  const range = edit?.range || edit?.replace || defaults.editRange?.replace || defaults.editRange || { start: positionAt(text, caret - prefix.length), end: positionAt(text, caret + suffix.length) };
  // a snippet goes in as its text, its first tab stop selected
  const raw = edit?.newText ?? item.textEditText ?? item.insertText ?? item.label;
  if ((item.insertTextFormat || defaults.insertTextFormat) === 2) snippetText(raw);
  const { text: newText, selection: [selFrom, selTo] } = (item.insertTextFormat || defaults.insertTextFormat) === 2 ? expandSnippet(raw) : { text: raw, selection: [raw.length, raw.length] };
  const edits = textEditRanges(text, [{ range, newText }, ...(item.additionalTextEdits || [])]);
  const ops = opEdits(text, edits);
  const start = offsetAt(text, range.start) + (item.additionalTextEdits || []).reduce((sum, e) => offsetAt(text, e.range.end) <= offsetAt(text, range.start) ? sum + e.newText.length - (offsetAt(text, e.range.end) - offsetAt(text, e.range.start)) : sum, 0);
  return { edits, ops, text: opApply(text, ops), caret: start + selTo, selection: [start + selFrom, start + selTo] };
}

export function incrementalChange(before, after) {
  let { head: from, tail } = commonEnds(before, after);
  if (from && ((before.charCodeAt(from - 1) >= 0xD800 && before.charCodeAt(from - 1) <= 0xDBFF) || before[from - 1] === '\r' && before[from] === '\n')) from--;
  const end = before.length - tail;
  if (tail && ((before.charCodeAt(end) >= 0xDC00 && before.charCodeAt(end) <= 0xDFFF) || before[end - 1] === '\r' && before[end] === '\n')) tail--;
  return { range: { start: positionAt(before, from), end: positionAt(before, before.length - tail) }, text: after.slice(from, after.length - tail) };
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
  ws.onclose = () => { closed = true; client.documents.clear(); rejectAll(new Error('Language server disconnected')); onEvent({ _sulfur: 'closed' }); };
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
      client.settings = settings;
      const result = await client.request('initialize', {
        processId: null, clientInfo: { name: 'Sulfur', version: '1' }, rootUri: client.rootUri,
        workspaceFolders: [{ uri: client.rootUri, name: uriPath(client.rootUri).split('/').pop() }],
        initializationOptions: settings,
        capabilities: { experimental: { csharp: { metadataUris: true } }, general: { positionEncodings: ['utf-16'] }, workspace: { configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false, resolveSupport: { properties: ['location.range'] } }, semanticTokens: { refreshSupport: true }, diagnostics: { refreshSupport: true }, workspaceEdit: { documentChanges: true, resourceOperations: [] }, applyEdit: true, executeCommand: { dynamicRegistration: false } }, textDocument: {
          synchronization: { didSave: true }, completion: { contextSupport: true, completionItem: { snippetSupport: true, insertReplaceSupport: true, resolveSupport: { properties: ['textEdit', 'additionalTextEdits', 'documentation', 'detail'] } }, completionList: { itemDefaults: ['editRange', 'insertTextFormat', 'data'] } },
          definition: { linkSupport: true }, declaration: { linkSupport: true }, typeDefinition: { linkSupport: true }, implementation: { linkSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true }, callHierarchy: { dynamicRegistration: false },
          publishDiagnostics: { versionSupport: true }, rename: { prepareSupport: false },
          formatting: { dynamicRegistration: false }, rangeFormatting: {},
          hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: { dynamicRegistration: false, contextSupport: true, signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
          codeAction: { dynamicRegistration: false, isPreferredSupport: true, disabledSupport: true, dataSupport: true, resolveSupport: { properties: ['edit'] }, codeActionLiteralSupport: { codeActionKind: { valueSet: ['', 'quickfix', 'refactor', 'refactor.extract', 'refactor.inline', 'refactor.rewrite', 'source', 'source.organizeImports', 'source.fixAll'] } } },
          documentHighlight: { dynamicRegistration: false },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: true },
          semanticTokens: { dynamicRegistration: false, requests: { full: true }, tokenTypes: TOKEN_TYPES, tokenModifiers: TOKEN_MODIFIERS, formats: ['relative'], overlappingTokenSupport: false, multilineTokenSupport: false },
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
      else if (mode !== 0) client.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: mode === 2 ? [incrementalChange(old.text, text)] : [{ text }] });
      client.documents.set(uri, { text, version });
      return version;
    },
    closeDocument(uri) { if (client.documents.delete(uri) && !closed && ws.readyState === 1) client.notify('textDocument/didClose', { textDocument: { uri } }); },
    close() { if (closed) return; closed = true; client.documents.clear(); rejectAll(new Error('Language session stopped')); ws.close(); },
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
      if (message.id !== undefined && message.method === 'workspace/applyEdit' && client.applyEdit) {
        // a code action's command editing files: applied through the editors, answered once done
        Promise.resolve().then(() => client.applyEdit(message.params?.edit, message.params?.label)).then(
          () => ({ applied: true }), (e) => ({ applied: false, failureReason: e.message })).then((result) => { try { send({ jsonrpc: '2.0', id: message.id, result }); } catch {} });
      } else if (message.id !== undefined) {
        if (['workspace/semanticTokens/refresh', 'workspace/diagnostic/refresh'].includes(message.method)) onEvent(message);
        const result = message.method === 'workspace/configuration' ? (message.params?.items || []).map((x) => x.section ? x.section.split('.').reduce((v, key) => v?.[key], client.settings) ?? null : client.settings || {})
          : message.method === 'workspace/workspaceFolders' ? [{ uri: client.rootUri, name: uriPath(client.rootUri).split('/').pop() }]
            : message.method === 'workspace/applyEdit' ? { applied: false, failureReason: 'Use Rename to review edits in Sulfur' } : null;
        send({ jsonrpc: '2.0', id: message.id, result });
        if (message.method === 'workspace/diagnostic/refresh') onEvent(message);
      } else onEvent(message);
    } else {
      const p = pending.get(message.id);
      if (p) message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
    }
  };
  return client;
}
