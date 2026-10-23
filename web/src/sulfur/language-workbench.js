import { LANGUAGE_EXTENSIONS, languageId, positionAt, offsetAt, relativeUri, applyTextEdits, textEditRanges, completionEdits, snippetText, languageSocket, serverSettings } from './language-client.js';
import { isWordChar, wordBefore, rankCompletions, wordCompletions, kindOf, inCommentOrString, sameCompletionWord } from './completion.js';
import { reindent } from './format.js';
import { diagnosticDelay } from './diagnostics.js';
import { inlineSuffix, preferLanguageCompletion } from './inline-completion.js';
import { semanticRanges } from './semantic-tokens.js';
import { documentSymbols } from './navigation.js';

const titles = ['TypeScript', 'Python', 'JavaScript', 'Java', 'C#', 'PHP', 'Shell (Bash)', 'C / C++', 'HCL / Terraform', 'Go'];
const ids = ['typescript', 'python', 'javascript', 'java', 'csharp', 'php', 'shell', 'cpp', 'hcl', 'go'];
const aborted = (e) => e?.name === 'AbortError';
// how long a server still starting is waited for before words are suggested instead
const WORD_WAIT = 1200;

// Keep the editor independent of hosts and installers. All text mutations use
// its edit() API, so completion/rename participate in collaboration and undo.
export function createLanguageWorkbench(api) {
  const states = new Map();
  const sessions = new Map();
  const attached = new Map();
  const diagnostics = new Map();
  const completers = new Map();
  const analyses = new Map();
  let generation = 0;
  let panel;
  let query = '';
  const state = (host) => { if (!states.has(host)) states.set(host, { extensions: ids.map((id, n) => ({ id, name: titles[n] })), errors: {}, busy: new Set() }); return states.get(host); };
  const connect = (host, request, event) => languageSocket(api.url(host), request, (m) => { if (m._sulfur === 'log') api.log(m.text, `Languages: ${host}`); event?.(m); });
  async function manage(host, op = 'status', language) {
    const s = state(host);
    s.busy.add(language || '*'); delete s.errors[language || '*']; panel?.paint();
    let connection;
    try {
      if (op !== 'status') stopMatching(host, language);
      connection = connect(host, { op, language }, (m) => {
        if (m._sulfur === 'status') s.extensions = m.extensions;
        if (m._sulfur === 'error') s.errors[language || '*'] = m.error;
      });
      await connection.ready;
      s.loaded = true;
    } catch (e) { s.errors[language || '*'] = e.message; throw e; }
    finally { connection?.close(); s.busy.delete(language || '*'); panel?.paint(); }
  }
  function clearSession(session) {
    if (sessions.get(session.key) === session) sessions.delete(session.key);
    clearTimeout(session.workspaceTimer); session.workspaceController?.abort();
    for (const [t, doc] of attached) if (doc.session === session) {
      stopAnalysis(t); t.ed?.setSemanticTokens([], t.ed.text());
    }
    session.client?.close();
    for (const [t, doc] of attached) if (doc.session === session) { clearTimeout(doc.diagnosticTimer); doc.diagnosticController?.abort(); attached.delete(t); t.ed?.setDiagnostics(null); }
    for (const [key, value] of diagnostics) if (value.session === session) diagnostics.delete(key);
    api.problems();
  }
  function stopMatching(host, language) {
    for (const [key, value] of sessions) if (value.context.host === host && (!language || value.extension === language)) { clearSession(value); sessions.delete(key); }
  }
  function reset() {
    generation++;
    api.onReset?.();
    for (const c of completers.values()) c.hide();
    for (const s of sessions.values()) clearSession(s);
    sessions.clear(); attached.clear(); diagnostics.clear();
  }
  function receive(session, message) {
    if (message._sulfur === 'error' || message._sulfur === 'closed') {
      if (message.error) { state(session.context.host).errors[session.extension] = message.error; panel?.paint(); }
      clearSession(session); return;
    }
    if (message.method === 'window/logMessage' || message.method === 'window/showMessage' || message.method === '$/logTrace') api.log(message.params?.message || '', `Languages: ${session.context.host}`);
    if (['workspace/semanticTokens/refresh', 'workspace/diagnostic/refresh'].includes(message.method)) {
      if (message.method === 'workspace/diagnostic/refresh') scheduleWorkspaceAnalysis(session);
      for (const [tab, doc] of attached) if (doc.session === session) scheduleDiagnostics(tab);
      for (const [t, d] of attached) if (d.session === session) scheduleAnalysis(t);
    }
    if (message.method !== 'textDocument/publishDiagnostics') return;
    const p = message.params;
    try {
      const rel = relativeUri(session.client.rootUri, p.uri);
      const document = session.client.documents.get(p.uri);
      if (p.version != null && p.version !== document?.version) return;
      const tab = [...attached].find(([, d]) => d.session === session && d.uri === p.uri)?.[0];
      if (tab && document?.text !== tab.ed.text()) return;
      const items = (p.diagnostics || []).map((d) => ({ ...d, path: api.join(session.context.rootRel, rel) }));
      const key = session.key + '\n' + p.uri;
      diagnostics.set(key, { session, uri: p.uri, items, resultId: p.resultId || diagnostics.get(key)?.resultId });
      if (tab) tab.ed.setDiagnostics(items.map((d) => ({ from: offsetAt(document.text, d.range.start), to: offsetAt(document.text, d.range.end), what: d.message, code: d.code, severity: d.severity ?? 1, source: d.source || session.extension })));
      api.problems();
    } catch (e) { api.log(e.message, `Languages: ${session.context.host}`); }
  }
  function scheduleDiagnostics(tab) {
    const doc = attached.get(tab);
    if (!doc?.session.client.capabilities.diagnosticProvider) return;
    clearTimeout(doc.diagnosticTimer); doc.diagnosticController?.abort();
    doc.diagnosticTimer = setTimeout(async () => {
      const client = doc.session.client;
      const snapshot = client.documents.get(doc.uri);
      if (!snapshot || !api.alive(tab)) return;
      const own = doc.diagnosticController = new AbortController();
      try {
        const report = await client.request('textDocument/diagnostic', { textDocument: { uri: doc.uri }, ...(client.capabilities.diagnosticProvider.identifier ? { identifier: client.capabilities.diagnosticProvider.identifier } : {}), ...(doc.resultId ? { previousResultId: doc.resultId } : {}) }, { signal: own.signal });
        if (own.signal.aborted || attached.get(tab) !== doc || client.documents.get(doc.uri)?.version !== snapshot.version || tab.ed.text() !== snapshot.text) return;
        if (report.kind === 'full') doc.pullItems = report.items || [];
        doc.resultId = report.resultId;
        for (const [uri, related] of Object.entries(report.relatedDocuments || {})) if (related.kind === 'full') receive(doc.session, { method: 'textDocument/publishDiagnostics', params: { uri, resultId: related.resultId, diagnostics: related.items || [] } });
        receive(doc.session, { method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, version: snapshot.version, resultId: report.resultId, diagnostics: doc.pullItems || [] } });
      } catch (error) { if (!aborted(error) && !client.closed()) api.log(error.message, `Languages: ${doc.session.context.host}`); }
    }, diagnosticDelay(api.diagnosticDelay?.()));
  }
  async function get(tab) {
    if (!tab?.rel || !tab.ed?.ready() || tab.info?.readOnly) return null;
    const extension = LANGUAGE_EXTENSIONS[tab.rel.split('.').pop().toLowerCase()];
    if (!extension) return null;
    const epoch = generation;
    const context = await api.context(tab);
    if (!context || epoch !== generation) return null;
    const s = state(context.host);
    if (!s.loaded) {
      if (!s.checking && Date.now() - (s.checkedAt || 0) > 30000) {
        s.checkedAt = Date.now();
        s.checking = manage(context.host).catch(() => null).finally(() => { s.checking = null; });
      }
      if (s.checking) await s.checking;
      if (!s.loaded) return null;
    }
    if (epoch !== generation || !s.extensions.find((x) => x.id === extension)?.enabled) return null;
    const key = JSON.stringify([context.host, context.root, extension, context.solutionPath, context.configuration, context.buildDirectory, context.settings]);
    // Reinitialization is intentional: servers cache active build settings.
    for (const [old, session] of sessions) if (old !== key && session.extension === extension && session.context.host === context.host && session.context.root === context.root) { clearSession(session); sessions.delete(old); }
    let session = sessions.get(key);
    if (!session) {
      session = { key, context, extension };
      sessions.set(key, session);
      session.client = connect(context.host, { op: 'launch', language: extension, root: context.root, configuration: context.configuration, buildDirectory: context.buildDirectory }, (m) => receive(session, m));
      // a code action's command editing files (workspace/applyEdit), through the editors
      session.client.applyEdit = (edit) => applyEdit(session, edit);
      session.promise = session.client.initialize(serverSettings(extension, { ...context, analyzersEnabled: api.setting?.('sulfur.csharp.analyzersEnabled') })).then(() => { session.readyAt = Date.now(); panel?.paint(); return session; }).catch((e) => { state(context.host).errors[extension] = e.message; panel?.paint(); clearSession(session); return null; });
    }
    const ready = await session.promise;
    if (!ready || epoch !== generation || session.client.closed() || !api.alive(tab)) return null;
    const uri = `${session.client.rootUri.replace(/\/$/, '')}/${context.documentRel.split('/').map(encodeURIComponent).join('/')}`;
    const previous = attached.get(tab);
    if (previous && (previous.uri !== uri || previous.session !== session)) previous.session.client.closeDocument(previous.uri);
    const previousVersion = session.client.documents.get(uri)?.version;
    const version = session.client.sync(uri, languageId(tab.rel, extension), tab.ed.text());
    const result = previous?.session === session && previous.uri === uri ? previous : { session, uri };
    attached.set(tab, result);
    if (!previous || previous.session !== session || previous.uri !== uri || previousVersion !== version) {
      scheduleAnalysis(tab); scheduleDiagnostics(tab); scheduleWorkspaceAnalysis(session);
    }
    return result;
  }
  function changed(tab) {
    const doc = attached.get(tab);
    if (!doc || doc.session.client.closed()) return;
    const client = doc.session.client;
    if (client.documents.get(doc.uri)?.text !== tab.ed.text()) {
      // the last report stays, moved with the edits by the editor, until the next one
      // replaces it: squiggles never blink off as you type, as in VS Code
      client.sync(doc.uri, languageId(tab.rel, doc.session.extension), tab.ed.text());
      scheduleAnalysis(tab);
      scheduleWorkspaceAnalysis(doc.session);
      scheduleDiagnostics(tab);
    }
  }
  function stopAnalysis(tab) {
    const task = analyses.get(tab);
    if (task) { clearTimeout(task.timer); task.controller?.abort(); analyses.delete(tab); }
  }
  function scheduleWorkspaceAnalysis(session) {
    session.revision = (session.revision || 0) + 1;
    clearTimeout(session.workspaceTimer); session.workspaceController?.abort();
    if (!session.client.capabilities.diagnosticProvider?.workspaceDiagnostics) return;
    session.workspaceTimer = setTimeout(async () => {
      const revision = session.revision, controller = session.workspaceController = new AbortController();
      try {
        const previousResultIds = [...diagnostics.values()].filter((d) => d.session === session && d.resultId).map((d) => ({ uri: d.uri, value: d.resultId }));
        const result = await session.client.request('workspace/diagnostic', { previousResultIds }, { signal: controller.signal, timeout: 90000 });
        if (controller.signal.aborted || session.revision !== revision || session.client.closed()) return;
        for (const report of result?.items || []) if (report.kind === 'full') {
          receive(session, { method: 'textDocument/publishDiagnostics', params: { uri: report.uri, version: report.version, resultId: report.resultId, diagnostics: report.items || [] } });
          const entry = diagnostics.get(session.key + '\n' + report.uri);
          if (entry) entry.resultId = report.resultId;
        }
      } catch (e) { if (!aborted(e) && !session.client.closed()) api.log(e.message, `Languages: ${session.context.host}`); }
    }, 1200);
  }
  // Semantic tokens as VS Code asks for them: one request at a time, never cancelled by
  // typing; a reply for text since edited is moved onto the text now by the editor, and
  // asked again once it lands, so colors keep up instead of waiting for a pause.
  function scheduleAnalysis(tab) {
    const running = analyses.get(tab);
    if (running?.inflight) { running.again = true; return; }
    stopAnalysis(tab);
    if (!attached.has(tab)) return;
    const task = { controller: new AbortController() };
    analyses.set(tab, task);
    task.timer = setTimeout(async () => {
      const doc = attached.get(tab);
      if (!doc || !api.alive(tab) || doc.session.client.closed()) return;
      const { client } = doc.session;
      const text = client.documents.get(doc.uri)?.text ?? tab.ed.text();
      const current = () => analyses.get(tab) === task && !task.controller.signal.aborted && api.alive(tab) && attached.get(tab) === doc && !client.closed();
      const options = { signal: task.controller.signal, timeout: 60000 };
      const requests = [];
      if (client.capabilities.semanticTokensProvider?.full) requests.push((async () => {
        const result = await client.request('textDocument/semanticTokens/full', { textDocument: { uri: doc.uri } }, options);
        if (current() && result?.data) tab.ed.setSemanticTokens(semanticRanges(text, result.data, client.capabilities.semanticTokensProvider.legend), text);
      })());
      task.inflight = true;
      const results = await Promise.allSettled(requests);
      task.inflight = false;
      if (current() && requests.length) {
        doc.session.analysisReady = results.every((r) => r.status === 'fulfilled');
        panel?.paint();
      }
      for (const result of results) if (result.status === 'rejected' && !aborted(result.reason) && current()) api.log(result.reason.message, `Languages: ${doc.session.context.host}`);
      if (current()) {
        analyses.delete(tab);
        if (task.again || text !== tab.ed.text()) scheduleAnalysis(tab);
      }
    }, 350);
  }
  async function request(tab, method, extra = {}, signal) {
    if (signal?.aborted) return null;
    const doc = await get(tab);
    if (!doc || signal?.aborted) return null;
    const capability = { completion: 'completionProvider', definition: 'definitionProvider', declaration: 'declarationProvider', typeDefinition: 'typeDefinitionProvider', implementation: 'implementationProvider', references: 'referencesProvider', rename: 'renameProvider', formatting: 'documentFormattingProvider', documentSymbol: 'documentSymbolProvider', prepareCallHierarchy: 'callHierarchyProvider', hover: 'hoverProvider', signatureHelp: 'signatureHelpProvider', codeAction: 'codeActionProvider', documentHighlight: 'documentHighlightProvider' }[method];
    if (!doc.session.client.capabilities[capability]) return null;
    const text = tab.ed.text();
    const caret = tab.ed.selection()[0];
    const version = doc.session.client.documents.get(doc.uri).version;
    const value = await doc.session.client.request(`textDocument/${method}`, { textDocument: { uri: doc.uri }, ...(method === 'documentSymbol' || method === 'codeAction' ? {} : { position: positionAt(text, caret) }), ...extra }, { signal });
    if (!api.alive(tab) || text !== tab.ed.text() || version !== doc.session.client.documents.get(doc.uri)?.version || (method === 'completion' && tab.ed.selection()[0] !== caret)) return { stale: true, value, doc, text, caret, version };
    return { value, doc, text, caret, version };
  }
  // an item's ranges, given for the text it was asked of, moved onto the text now: what came
  // before the caret then is where it was, what came after shifted by what's been typed since
  function rebase(range, was, wasCaret, text, caret) {
    if (!range) return range;
    if (range.insert) return { insert: rebase(range.insert, was, wasCaret, text, caret), replace: rebase(range.replace, was, wasCaret, text, caret) };
    const move = (p) => { const o = offsetAt(was, p); return positionAt(text, o >= wasCaret ? o + caret - wasCaret : o); };
    return { start: move(range.start), end: move(range.end) };
  }
  // Completion as VS Code runs it: suggestions on typing a word (not in comments or strings),
  // on a server's trigger characters and on Ctrl+Space; one request per word, its items
  // filtered and ranked here as typing goes on, asked again only when the server said they
  // were incomplete; the open documents' words when there's no server or it has nothing.
  function attach(tab) {
    const ta = tab.view.querySelector('.code-ta');
    const box = api.el('div', 'ide-completion');
    box.hidden = true; box.setAttribute('role', 'listbox'); box.id = `${tab.id}-completions`;
    ta.setAttribute('aria-expanded', 'false');
    ta.setAttribute('aria-controls', box.id); ta.setAttribute('aria-autocomplete', 'both');
    tab.view.append(box);
    // session: the items asked for the word starting at from; shown: those matching what's typed
    let session = null, shown = [], selected = 0, timer, controller, wordTimer;
    let languagePreview = false;
    // VS Code's list: rows of one height, only those in view drawn, above or below the
    // word as decided when it opens and kept there while typing narrows it
    const ROW = 22, ROWS = 12;
    let placement = '';
    const spacer = api.el('div', 'ide-completion-spacer');
    function close() { if (languagePreview) { tab.ed.setInlineSuggestion?.(null); languagePreview = false; } box.hidden = true; placement = ''; ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant'); }
    function hide() { clearTimeout(timer); clearTimeout(wordTimer); controller?.abort(); session = null; shown = []; close(); }
    // the highlight's class at a place before the caret: VS Code's quick suggestions stay out of comments and strings
    function quiet(offset) {
      return offset >= 0 && !!tab.ed.tokenClass && /hljs-(comment|string|regexp)/.test(tab.ed.tokenClass(offset));
    }
    function paintPreview() {
      if (api.setting?.('editor.suggest.inlinePreview') === false || !session || !shown[selected]) { if (languagePreview) tab.ed.setInlineSuggestion?.(null); languagePreview = false; return; }
      const text = tab.ed.text(), caret = ta.selectionStart;
      try {
        const item = shown[selected].item;
        const applied = completionEdits(item, text, caret, session.defaults);
        const insert = inlineSuffix(applied, text, caret);
        languagePreview = !!insert;
        tab.ed.setInlineSuggestion?.(insert ? { text, caret, insert } : null);
      } catch { if (languagePreview) tab.ed.setInlineSuggestion?.(null); languagePreview = false; }
    }
    // the selection scrolled into view, then the rows in view drawn; the list's scroll kept
    // here rather than read back, so typing into an open list forces no layout
    let listTop = 0;
    const scrollList = (top) => { listTop = Math.max(0, top); box.scrollTop = listTop; };
    box.addEventListener('scroll', () => { listTop = box.scrollTop; if (!box.hidden) paintRows(); }, { passive: true });
    function paint() {
      const height = ROW * Math.min(ROWS, shown.length);
      if (selected * ROW < listTop) scrollList(selected * ROW);
      else if ((selected + 1) * ROW > listTop + height) scrollList((selected + 1) * ROW - height);
      paintRows();
      ta.setAttribute('aria-activedescendant', `${box.id}-${selected}`);
      paintPreview();
    }
    function paintRows() {
      const first = Math.max(0, Math.min(shown.length - 1, Math.floor(listTop / ROW) - 2));
      const last = Math.min(shown.length, first + ROWS + 4);
      box.style.paddingTop = `${first * ROW}px`;
      spacer.style.height = `${(shown.length - last) * ROW}px`;
      box.replaceChildren(...shown.slice(first, last).map(({ item, matches }, n) => {
        const index = first + n;
        const row = api.el('div', `ide-completion-item${index === selected ? ' on' : ''}`);
        row.id = `${box.id}-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected));
        const { kind, glyph } = kindOf(item);
        const label = api.el('span', 'ide-completion-label');
        const text = String(item.label);
        const hit = new Set(text === String(item.filterText || item.label) ? matches : []);
        for (let i = 0; i < text.length;) {
          let j = i + 1;
          while (j < text.length && hit.has(j) === hit.has(i)) j++;
          label.append(hit.has(i) ? api.el('b', '', text.slice(i, j)) : text.slice(i, j));
          i = j;
        }
        row.append(api.el('span', `ide-completion-kind k-${kind}`, glyph), label, api.el('small', '', item.detail || item.labelDetails?.description || ''));
        const docs = typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;
        if (docs) row.title = docs;
        row.addEventListener('mousedown', (e) => { e.preventDefault(); selected = index; accept().catch(api.error); });
        return row;
      }), spacer);
    }
    // the list under the word's start, above it when there's no room below for a full list
    let measure;
    function place(text, from) {
      const style = getComputedStyle(ta);
      const lineStart = text.lastIndexOf('\n', from - 1) + 1;
      const row = positionAt(text, lineStart).line;
      const tabSize = parseInt(style.tabSize, 10) || 4;
      const columns = [...text.slice(lineStart, from)].reduce((n, ch) => ch === '\t' ? n + tabSize - n % tabSize : n + 1, 0);
      measure ||= document.createElement('canvas').getContext('2d');
      measure.font = style.font || `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const rect = ta.getBoundingClientRect(); const outer = tab.view.getBoundingClientRect();
      const lineHeight = tab.ed.lineHeight?.() || parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
      const y = rect.top - outer.top + parseFloat(style.paddingTop) + (row + 1) * lineHeight - ta.scrollTop;
      const full = ROW * ROWS + 2;
      placement ||= y + full > outer.height && y - lineHeight - full >= 0 ? 'above' : 'below';
      box.style.left = `${Math.max(0, Math.min(outer.width - box.offsetWidth, rect.left - outer.left + parseFloat(style.paddingLeft) + columns * measure.measureText('M').width - ta.scrollLeft))}px`;
      if (placement === 'above') { box.style.top = ''; box.style.bottom = `${Math.max(0, outer.height - (y - lineHeight))}px`; }
      else { box.style.bottom = ''; box.style.top = `${Math.max(0, y)}px`; }
    }
    function refilter() {
      if (!session) return;
      const text = tab.ed.text();
      const caret = ta.selectionStart;
      const typed = text.slice(session.from, caret);
      if (caret !== ta.selectionEnd || !sameCompletionWord(session.text, session.caret, session.from, text, caret) || (!typed && !session.anchored)) { hide(); return; }
      shown = rankCompletions(session.items, typed);
      // a word that's already whole is nothing to suggest
      if (!session.lsp && shown.length === 1 && shown[0].item.label === typed) shown = [];
      if (!shown.length) { close(); return; }
      // placed when it opens or its word moves, never while typing narrows the list
      const opening = box.hidden || session.placedAt !== session.from;
      selected = 0; box.hidden = false; ta.setAttribute('aria-expanded', 'true');
      if (session.anchored || preferLanguageCompletion(text, caret, shown.map((x) => x.item))) api.onSuggest?.();
      if (opening) scrollList(0);
      paint();
      if (opening) { place(text, session.from); session.placedAt = session.from; }
    }
    async function trigger(triggerKind, triggerCharacter = '', explicit = false, retry = 0) {
      api.onSuggest?.();
      controller?.abort();
      const own = controller = new AbortController();
      clearTimeout(timer);
      const text = tab.ed.text();
      const caret = ta.selectionStart;
      if (ta !== document.activeElement || caret !== ta.selectionEnd || tab.info?.readOnly) return;
      const from = caret - wordBefore(text, caret).length;
      clearTimeout(wordTimer);
      // asked again for an incomplete list: the old one stays, filtered, until the new
      // one comes, rather than words flashing up between them
      const placedAt = session?.placedAt;
      if (!(session && session.from === from && triggerKind === 3)) {
        // With a language server, its list is waited for, as VS Code waits for its
        // providers: words shown first and swapped for the server's list under the caret
        // are what made the list jump. Words come at once only without a server, or
        // after a while for one still starting.
        const server = !!attached.get(tab)?.session.client.capabilities.completionProvider;
        const words = () => triggerCharacter ? [] : wordCompletions(api.documents?.(tab) || [], tab.ed.text(), ta.selectionStart);
        const waiting = session = { from, text, caret, items: server ? [] : words(), lsp: null, defaults: {}, incomplete: false, anchored: explicit || !!triggerCharacter, placedAt };
        refilter();
        if (server && !triggerCharacter) wordTimer = setTimeout(() => { if (session === waiting) { waiting.items = words(); refilter(); } }, WORD_WAIT);
      }
      let items = [], lsp = null, defaults = {}, incomplete = false;
      try {
        const result = await request(tab, 'completion', { context: triggerCharacter ? { triggerKind: 2, triggerCharacter } : { triggerKind } }, own.signal);
        if (result?.value) {
          lsp = result; defaults = result.value.itemDefaults || {};
          items = (Array.isArray(result.value) ? result.value : result.value.items || []).filter((item) => {
            try {
              if ((item.insertTextFormat || defaults.insertTextFormat) === 2) snippetText(item.textEdit?.newText ?? item.textEditText ?? item.insertText ?? item.label);
              return true;
            } catch { return false; }
          });
          incomplete = !!result.value.isIncomplete;
        }
      } catch (e) { if (!aborted(e) && explicit) api.error(e); }
      if (own.signal.aborted || document.activeElement !== ta || !api.alive(tab)) return;
      const now = tab.ed.text();
      // typed since the request: fine while it only went on with the same word
      if (ta.selectionStart !== ta.selectionEnd || !sameCompletionWord(text, caret, from, now, ta.selectionStart)) { hide(); return; }
      if (lsp && !sameCompletionWord(lsp.text, lsp.caret, from, now, ta.selectionStart)) { hide(); return; }
      if (!items.length) {
        const warming = lsp?.doc.session.extension === 'csharp' && Date.now() - lsp.doc.session.readyAt < 10000;
        if (warming && retry < 3) timer = setTimeout(() => trigger(3, triggerCharacter, explicit, retry + 1), [300, 900, 1800][retry]);
        incomplete = !!warming;
        if (triggerCharacter && !warming) { hide(); return; }
        items = wordCompletions(api.documents?.(tab) || [], now, ta.selectionStart);
        lsp = null;
      }
      clearTimeout(wordTimer);
      session = { from, text, caret, items, lsp, defaults, incomplete, anchored: explicit || !!triggerCharacter || (session?.from === from && !!session.anchored), placedAt: session?.from === from ? session.placedAt : undefined };
      refilter();
    }
    async function accept() {
      const pick = shown[selected];
      const s = session;
      const text = tab.ed.text();
      const caret = ta.selectionStart;
      hide();
      if (!pick || !s || tab.info?.readOnly || caret !== ta.selectionEnd || !sameCompletionWord(s.text, s.caret, s.from, text, caret)) return;
      let item = pick.item;
      if (!s.lsp) { const applied = completionEdits(item, text, caret); tab.ed.editMany(applied.edits, applied.selection); changed(tab); return; }
      const client = s.lsp.doc.session.client;
      const epoch = generation;
      const own = controller = new AbortController();
      if (client.capabilities.completionProvider?.resolveProvider) {
        try { item = { ...item, ...await client.request('completionItem/resolve', { ...item, data: item.data ?? s.defaults.data }, { signal: own.signal }) }; } catch (e) { if (!aborted(e)) api.log(e.message, `Languages: ${s.lsp.doc.session.context.host}`); }
      }
      if (own.signal.aborted || epoch !== generation || !api.alive(tab) || client.closed() || attached.get(tab)?.session !== s.lsp.doc.session || document.activeElement !== ta || tab.info?.readOnly || text !== tab.ed.text() || caret !== ta.selectionStart || caret !== ta.selectionEnd) return;
      const move = (r) => rebase(r, s.lsp.text, s.lsp.caret, text, caret);
      const moved = { ...item, ...(item.textEdit ? { textEdit: { ...item.textEdit, ...(item.textEdit.range ? { range: move(item.textEdit.range) } : move({ insert: item.textEdit.insert, replace: item.textEdit.replace })) } } : {}), additionalTextEdits: (item.additionalTextEdits || []).map((e) => ({ ...e, range: move(e.range) })) };
      const defaults = s.defaults.editRange ? { ...s.defaults, editRange: move(s.defaults.editRange) } : s.defaults;
      const applied = completionEdits(moved, text, caret, defaults);
      tab.ed.editMany(applied.edits, applied.selection);
      changed(tab);
    }
    const triggers = () => attached.get(tab)?.session.client.capabilities.completionProvider?.triggerCharacters || [];

    // Signature help, as VS Code's parameter hints: asked on the server's trigger characters
    // (an opening parenthesis), asked again as the arguments are typed and the caret moves,
    // gone once the server has none for the caret (the call closed) or on Escape
    const sig = api.el('div', 'ide-signature');
    sig.hidden = true; sig.setAttribute('role', 'tooltip');
    tab.view.append(sig);
    let sigController = null, sigActive = null, sigTimer = 0;
    function hideSignature() { clearTimeout(sigTimer); sigController?.abort(); sigController = null; sigActive = null; sig.hidden = true; }
    async function askSignature(triggerKind, triggerCharacter = '') {
      clearTimeout(sigTimer);
      sigController?.abort();
      const own = sigController = new AbortController();
      const context = { triggerKind, isRetrigger: !!sigActive, ...(triggerCharacter ? { triggerCharacter } : {}), ...(sigActive ? { activeSignatureHelp: sigActive } : {}) };
      let result = null;
      try { result = await signatureHelp(tab, context, own.signal); } catch (e) { if (!aborted(e)) api.log(e.message, 'Languages'); }
      if (own.signal.aborted || !api.alive(tab) || document.activeElement !== ta) return;
      if (!result) { hideSignature(); return; }
      sigActive = result.help;
      paintSignature();
    }
    const signatureSoon = (kind = 3, ch = '') => { clearTimeout(sigTimer); sigTimer = setTimeout(() => askSignature(kind, ch), 120); };
    const docText = (d) => (typeof d === 'string' ? d : d?.value || '');
    function paintSignature() {
      const help = sigActive;
      const n = Math.max(0, Math.min(help.activeSignature ?? 0, help.signatures.length - 1));
      const signature = help.signatures[n];
      const label = String(signature.label);
      const param = signature.parameters?.[signature.activeParameter ?? help.activeParameter ?? 0];
      let range = null;
      if (Array.isArray(param?.label)) range = param.label;
      else if (param?.label) { const at = label.indexOf(param.label); if (at >= 0) range = [at, at + param.label.length]; }
      const head = api.el('div', 'ide-signature-label');
      if (help.signatures.length > 1) head.append(api.el('span', 'ide-signature-count', `${n + 1}/${help.signatures.length}`));
      if (range) head.append(label.slice(0, range[0]), api.el('b', '', label.slice(range[0], range[1])), label.slice(range[1]));
      else head.append(label);
      sig.replaceChildren(head, api.el('div', 'ide-signature-doc', [docText(param?.documentation), docText(signature.documentation)].filter(Boolean).join('\n\n')));
      sig.hidden = false;
      // above the caret's line, below it when there's no room
      const p = tab.ed.pointAt?.(ta.selectionStart);
      if (!p) return;
      const outer = tab.view.getBoundingClientRect();
      sig.style.left = `${Math.max(0, Math.min(outer.width - sig.offsetWidth - 4, p.x - outer.left - 8))}px`;
      const above = p.top - outer.top - sig.offsetHeight - 2;
      sig.style.top = `${above >= 0 ? above : p.bottom - outer.top + 2}px`;
    }
    ta.addEventListener('input', (e) => {
      if (e.isComposing) return;
      const caps = api.setting?.('editor.parameterHints.enabled') === false ? null : signatureTriggers(tab);
      if (!caps) return;
      const ch = e.inputType === 'insertText' && e.data ? [...e.data].at(-1) : '';
      if (ch && caps.trigger.includes(ch)) signatureSoon(2, ch);
      else if (sigActive) signatureSoon(3, caps.retrigger.includes(ch) ? ch : '');
    });
    ta.addEventListener('blur', hideSignature);
    ta.addEventListener('pointerdown', hideSignature);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !sig.hidden && box.hidden) { e.preventDefault(); e.stopImmediatePropagation(); hideSignature(); return; }
      if (sigActive && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) signatureSoon(3);
    }, true);
    tab.view.querySelector('.code-ed')?.addEventListener('scroll', () => { if (!sig.hidden) paintSignature(); }, { passive: true });
    ta.addEventListener('input', (e) => {
      if (e.isComposing) { hide(); return; }
      clearTimeout(timer);
      // the last character typed (a pasted text never asks)
      const ch = e.inputType === 'insertText' && e.data ? [...e.data].at(-1) : '';
      if (ch && triggers().includes(ch)) { hide(); timer = setTimeout(() => trigger(2, ch), 10); return; }
      if (session) {
        // an incomplete list asked again for the longer word, the old one filtered meanwhile
        if (session.incomplete && isWordChar(ch)) timer = setTimeout(() => trigger(3, '', session?.anchored), 10);
        refilter();
        return;
      }
      if (!isWordChar(ch)) return;
      const text = tab.ed.text();
      const start = ta.selectionStart - wordBefore(text, ta.selectionStart).length;
      if (!inCommentOrString(text, start, tab.rel.split('.').pop().toLowerCase()) && !quiet(start - 1)) timer = setTimeout(() => trigger(1), 10);
    });
    ta.addEventListener('compositionstart', hide);
    ta.addEventListener('blur', hide);
    const scroller = tab.view.querySelector('.code-ed');
    scroller?.addEventListener('wheel', hide, { passive: true });
    scroller?.addEventListener('touchmove', hide, { passive: true });
    scroller?.addEventListener('pointerdown', (e) => { if (e.target !== ta) hide(); });
    ta.addEventListener('pointerdown', hide);
    const selectionChanged = () => { if (document.activeElement === ta && session && (ta.selectionStart !== ta.selectionEnd || ta.selectionStart < session.from)) hide(); };
    document.addEventListener('selectionchange', selectionChanged);
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); trigger(1, '', true); return; }
      if (box.hidden) { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) hide(); return; }
      if (e.shiftKey && (e.key === 'Tab' || e.key === 'Enter')) { hide(); return; }
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Escape') hide();
        else if (e.key === 'Enter' || e.key === 'Tab') accept().catch(api.error);
        else {
          if (session) session.anchored = true;
          const page = Math.max(1, Math.floor(box.clientHeight / (box.firstChild?.offsetHeight || 22)) - 1);
          const step = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key];
          selected = e.key.startsWith('Page') ? Math.max(0, Math.min(shown.length - 1, selected + step)) : (selected + step + shown.length) % shown.length;
          paint();
        }
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) hide();
    }, true);
    completers.set(tab, { hide, trigger, manual: () => !!session?.anchored && !box.hidden, symbols: () => shown.map((x) => x.item), signature: () => askSignature(1), hideSignature });
    const dispose = tab.dispose;
    tab.dispose = () => { hide(); hideSignature(); sig.remove(); stopAnalysis(tab); completers.delete(tab); document.removeEventListener('selectionchange', selectionChanged); const doc = attached.get(tab); if (doc) { clearTimeout(doc.diagnosticTimer); doc.diagnosticController?.abort(); doc.session.client.closeDocument(doc.uri); attached.delete(tab); diagnostics.delete(doc.session.key + '\n' + doc.uri); } dispose(); box.remove(); api.problems(); };
  }
  async function navigate(tab, references = false) {
    const method = typeof references === 'string' ? references : references ? 'references' : 'definition';
    const result = await request(tab, method, method === 'references' ? { context: { includeDeclaration: true } } : {});
    if (!result) return false;
    if (result.stale) return true;
    const locations = (Array.isArray(result.value) ? result.value : result.value ? [result.value] : []).flatMap((x) => {
      try {
        const uri = x.targetUri || x.uri;
        const range = x.targetSelectionRange || x.range;
        if (result.doc.session.extension === 'csharp' && uri.startsWith('csharp:/')) return [{ uri, range, metadata: true, rel: decodeURIComponent(uri).split('/').pop() }];
        return [{ uri, range, rel: api.join(result.doc.session.context.rootRel, relativeUri(result.doc.session.client.rootUri, uri)) }];
      } catch { return []; }
    });
    if (!locations.length) { api.notice('No project locations returned by the language server.'); return true; }
    const hit = locations.length === 1 ? locations[0] : await api.pick(locations.map((x) => ({ label: `${x.rel}:${x.range.start.line + 1}`, value: x })), { title: method === 'references' ? 'References' : method === 'implementation' ? 'Implementations' : 'Definitions' });
    if (hit && api.alive(tab)) {
      if (hit.metadata) {
        const metadata = await result.doc.session.client.request('csharp/metadata', { textDocument: { uri: hit.uri } });
        if (!metadata?.source) throw new Error('The C# server could not decompile this assembly. Check project references and Languages output.');
        if (api.alive(tab)) {
          const target = api.openMetadata(hit.uri, metadata, result.doc.session.context, hit.range);
          const client = result.doc.session.client;
          if (target && client.capabilities.semanticTokensProvider?.full) {
            const tokens = await client.request('textDocument/semanticTokens/full', { textDocument: { uri: hit.uri } });
            if (api.alive(target)) target.ed.setSemanticTokens(semanticRanges(metadata.source, tokens?.data || [], client.capabilities.semanticTokensProvider.legend), metadata.source);
          }
        }
      } else api.open(hit.rel, result.doc.session.context, hit.range);
    }
    return true;
  }
  async function documentOutline(tab, signal) {
    const result = await request(tab, 'documentSymbol', {}, signal);
    return result && !result.stale ? documentSymbols(result.text, result.value, result.doc.uri) : null;
  }
  const sessionCurrent = (doc) => sessions.get(doc.session.key) === doc.session;
  async function openLocation(doc, uri, range) {
    if (!sessionCurrent(doc)) throw new Error('The language session changed. Run navigation again.');
    if (doc.session.extension === 'csharp' && uri.startsWith('csharp:/')) {
      const metadata = await doc.session.client.request('csharp/metadata', { textDocument: { uri } });
      if (!metadata?.source) throw new Error('The C# server could not decompile this assembly.');
      if (sessionCurrent(doc)) {
        const target = api.openMetadata(uri, metadata, doc.session.context, range);
        const client = doc.session.client;
        if (target && client.capabilities.semanticTokensProvider?.full) {
          const tokens = await client.request('textDocument/semanticTokens/full', { textDocument: { uri } });
          if (api.alive(target)) target.ed.setSemanticTokens(semanticRanges(metadata.source, tokens?.data || [], client.capabilities.semanticTokensProvider.legend), metadata.source);
        }
      }
    } else api.open(api.join(doc.session.context.rootRel, relativeUri(doc.session.client.rootUri, uri)), doc.session.context, range);
  }
  async function workspaceSymbols(tab, query) {
    const doc = await get(tab);
    if (!doc?.session.client.capabilities.workspaceSymbolProvider) return null;
    const result = await doc.session.client.request('workspace/symbol', { query });
    if (!sessionCurrent(doc) || !api.alive(tab)) return [];
    return (result || []).map((item) => ({ item, doc }));
  }
  async function openWorkspaceSymbol(hit) {
    let { item } = hit;
    if (!item.location?.range && hit.doc.session.client.capabilities.workspaceSymbolProvider?.resolveProvider) item = await hit.doc.session.client.request('workspaceSymbol/resolve', item);
    if (!item.location?.range) throw new Error('The language server did not return a location for this symbol.');
    return openLocation(hit.doc, item.location.uri, item.location.range);
  }
  async function callHierarchy(tab) {
    const result = await request(tab, 'prepareCallHierarchy');
    return result && !result.stale ? { doc: result.doc, items: result.value || [] } : null;
  }
  async function hierarchyCalls(handle, item, direction, signal) {
    if (!sessionCurrent(handle.doc)) throw new Error('The language session changed. Open Call Hierarchy again.');
    const calls = await handle.doc.session.client.request(direction === 'outgoing' ? 'callHierarchy/outgoingCalls' : 'callHierarchy/incomingCalls', { item }, { signal });
    return sessionCurrent(handle.doc) ? calls || [] : [];
  }
  async function rename(tab) {
    const doc = await get(tab);
    if (!doc?.session.client.capabilities.renameProvider) return false;
    const value = await api.input({ title: 'Rename Symbol', prompt: 'New symbol name (language server validates it)' });
    if (!value) return true;
    const result = await request(tab, 'rename', { newName: value });
    if (!result || result.stale || !result.value) return true;
    const prepared = await prepareEdit(doc.session, result.value);
    if (!prepared.length) return true;
    // Review in open tabs, as with Sulfur's syntax rename. Validate all before
    // any mutation; each file gets a single undo entry.
    const apply = await api.pick([{ label: `Apply rename to ${prepared.length} files`, value: true }, { label: 'Cancel', value: false }], { title: 'Rename from language server', placeholder: prepared.map((x) => x.target.rel).join(', ') });
    if (!apply) return true;
    applyPrepared(prepared, 'Files changed while reviewing rename. Run Rename again.');
    return true;
  }
  // A WorkspaceEdit's text edits made ready in open tabs: every file validated (versions,
  // writable, positions) before any is touched, each file then one undo step
  async function prepareEdit(session, edit) {
    const groups = [];
    if (edit?.changes) for (const [uri, edits] of Object.entries(edit.changes)) groups.push({ textDocument: { uri }, edits });
    if (edit?.documentChanges) groups.push(...edit.documentChanges);
    if (groups.some((x) => !x.textDocument || !Array.isArray(x.edits))) throw new Error('This edit creates, renames or deletes files, which Sulfur cannot apply.');
    const prepared = [];
    const seen = new Set();
    for (const group of groups) {
      const uri = group.textDocument.uri;
      if (seen.has(uri)) throw new Error('Duplicate document edits');
      seen.add(uri);
      const path = api.join(session.context.rootRel, relativeUri(session.client.rootUri, uri));
      const target = await api.prepare(path, session.context);
      const version = group.textDocument.version;
      if (version != null && session.client.documents.get(uri)?.version !== version) throw new Error(`Document version changed: ${path}`);
      const before = target.ed.text();
      // snippet edits (AnnotatedTextEdit and the like) go in as their text
      const edits = group.edits.map((e) => ({ range: e.range, newText: e.newText ?? e.snippet?.value ?? '' }));
      prepared.push({ target, before, after: applyTextEdits(before, edits), edits: textEditRanges(before, edits) });
    }
    return prepared;
  }
  function applyPrepared(prepared, stale = 'Files changed while the edit was prepared. Try again.') {
    if (prepared.some((x) => !api.alive(x.target) || x.target.ed.text() !== x.before || x.target.info?.readOnly)) throw new Error(stale);
    for (const x of prepared) { x.target.ed.editMany(x.edits); changed(x.target); }
  }
  async function applyEdit(session, edit) {
    if (sessions.get(session.key) !== session) throw new Error('The language session changed');
    applyPrepared(await prepareEdit(session, edit));
  }

  // --- hover, signature help, code actions: asked of an attached document only, so moving
  // the mouse or typing never starts a server ---
  const markdownOf = (contents) => (Array.isArray(contents) ? contents : [contents]).map((x) => {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (x.kind) return x.kind === 'markdown' ? x.value : String(x.value).replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
    if (x.language) return `\`\`\`${x.language}\n${x.value}\n\`\`\``;
    return x.value || '';
  }).filter((x) => x.trim()).join('\n\n---\n\n');
  async function hover(tab, offset, signal) {
    if (!attached.has(tab) || !attached.get(tab).session.client.capabilities.hoverProvider) return null;
    const result = await request(tab, 'hover', { position: positionAt(tab.ed.text(), offset) }, signal);
    if (!result || result.stale || !result.value?.contents) return null;
    return markdownOf(result.value.contents) || null;
  }
  // context: { triggerKind, triggerCharacter, isRetrigger, activeSignatureHelp }
  async function signatureHelp(tab, context, signal) {
    if (!attached.has(tab)) return null;
    const caps = attached.get(tab).session.client.capabilities.signatureHelpProvider;
    if (!caps) return null;
    const result = await request(tab, 'signatureHelp', { context }, signal);
    if (!result || result.stale || !result.value?.signatures?.length) return null;
    return { help: result.value, text: result.text, caret: result.caret };
  }
  function signatureTriggers(tab) {
    const caps = attached.get(tab)?.session.client.capabilities.signatureHelpProvider;
    return caps ? { trigger: caps.triggerCharacters || ['('], retrigger: caps.retriggerCharacters || [','] } : null;
  }
  const before = (a, b) => a.line < b.line || (a.line === b.line && a.character < b.character);
  async function codeActions(tab, only) {
    const doc = await get(tab);
    if (!doc?.session.client.capabilities.codeActionProvider) return null;
    const text = tab.ed.text();
    const [from, to] = tab.ed.selection();
    const range = { start: positionAt(text, from), end: positionAt(text, to) };
    // the problems the selection touches (the caret's line with nothing selected), as published
    const entry = diagnostics.get(doc.session.key + '\n' + doc.uri);
    const touches = (d) => (from === to ? d.range.start.line <= range.start.line && range.start.line <= d.range.end.line : !before(d.range.end, range.start) && !before(range.end, d.range.start));
    const items = (entry?.items || []).filter(touches).map(({ path, ...d }) => d);
    const result = await request(tab, 'codeAction', { range, context: { diagnostics: items, triggerKind: 1, ...(only ? { only: [only] } : {}) } });
    if (!result || result.stale) return null;
    return { doc: result.doc, actions: (result.value || []).filter((a) => a && !a.disabled) };
  }
  async function runCodeAction(handle, action) {
    const { client } = handle.doc.session;
    let a = action;
    if (typeof a.command === 'string' && !a.edit && !a.kind) {
      await client.request('workspace/executeCommand', { command: a.command, arguments: a.arguments });
      return;
    }
    if (!a.edit && client.capabilities.codeActionProvider?.resolveProvider) a = await client.request('codeAction/resolve', a);
    if (a.edit) await applyEdit(handle.doc.session, a.edit);
    if (a.command?.command) await client.request('workspace/executeCommand', { command: a.command.command, arguments: a.command.arguments });
  }
  // Quick Fix (Ctrl+.) and the Refactor / Source Action menus: the server's actions for the
  // selection, preferred first, picked from a list
  async function quickFix(tab, only = '', title = 'Quick Fix') {
    const handle = await codeActions(tab, only);
    if (!handle) return false;
    if (!handle.actions.length) { api.notice(only ? `No ${title.toLowerCase()} actions available` : 'No code actions available'); return true; }
    const sorted = [...handle.actions].sort((a, b) => (b.isPreferred ? 1 : 0) - (a.isPreferred ? 1 : 0));
    const action = sorted.length === 1 && only === 'source.organizeImports' ? sorted[0]
      : await api.pick(sorted.map((a) => ({ label: a.title, description: a.kind || '', detail: a.isPreferred ? 'preferred' : '', value: a })), { title, placeholder: 'Select a code action' });
    if (action && api.alive(tab)) await runCodeAction(handle, action);
    return true;
  }
  function mount(container) {
    const wrap = api.el('div', 'ide-language-manager');
    wrap.append(api.el('h3', '', 'Optional language extensions'));
    const host = api.el('select', 'ide-input'); host.setAttribute('aria-label', 'Language extension host');
    const note = api.el('p', 'ide-run-note', 'Install only the languages you use. Servers run as your user on the selected host. Python 3.10+ is required on every host. Installed servers work offline with cached project dependencies.');
    const rows = api.el('div', 'ide-language-list');
    const install = api.el('button', 'ide-button', 'Install selected'); install.type = 'button';
    const refresh = api.el('button', 'ide-button secondary', 'Refresh status'); refresh.type = 'button';
    const error = api.el('p', 'ide-language-error'); error.setAttribute('role', 'status');
    const selected = new Set();
    let batch = false;
    const action = async (op, id) => { try { await manage(host.value, op, id); } catch (e) { api.error(e); } };
    const paint = () => {
      const old = host.value;
      host.replaceChildren(...api.hosts().map((h) => Object.assign(api.el('option', '', h), { value: h })));
      if ([...host.options].some((x) => x.value === old)) host.value = old;
      const s = state(host.value);
      install.disabled = batch || !selected.size || !!s.busy.size; refresh.disabled = batch || !!s.busy.size; host.disabled = batch || !!s.busy.size;
      error.textContent = s.errors['*'] || '';
      const shown = s.extensions.filter((item) => !query || `${item.name} ${item.id} ${item.server || ''} ${(item.manifest?.packages || []).join(' ')}`.toLowerCase().includes(query));
      rows.replaceChildren(...(s.extensions.length && !shown.length ? [api.el('p', 'ide-run-note', 'No language extensions match.')] : []), ...shown.map((item) => {
        const row = api.el('div', 'ide-language-row');
        const label = api.el('label');
        const check = Object.assign(api.el('input'), { type: 'checkbox', checked: selected.has(item.id), disabled: item.installed || batch || s.busy.size > 0 });
        check.addEventListener('change', () => { check.checked ? selected.add(item.id) : selected.delete(item.id); paint(); });
        label.append(check, api.el('strong', '', item.name));
        const active = [...sessions.values()].find((x) => x.context.host === host.value && x.extension === item.id && !x.client.closed());
        row.append(label, api.el('span', 'ide-language-status', s.busy.has(item.id) ? 'Working…' : s.errors[item.id] ? 'Error: ' + s.errors[item.id] : active ? 'Running' : item.enabled ? 'Enabled' : item.installed ? 'Disabled' : 'Not installed'), api.el('small', '', `${item.server || ''}${item.prerequisites ? ' · ' + item.prerequisites : ''}`));
        if (item.manifest?.packages) row.append(api.el('small', '', item.manifest.packages.join(', ')));
        if (item.installed) for (const [op, title] of [[item.enabled ? 'disable' : 'enable', item.enabled ? 'Disable' : 'Enable'], ['uninstall', 'Uninstall']]) {
          const button = api.el('button', 'ide-button small secondary', title); button.type = 'button'; button.disabled = batch || !!s.busy.size;
          button.addEventListener('click', () => action(op, item.id)); row.append(button);
        }
        return row;
      }));
    };
    host.addEventListener('change', () => { selected.clear(); action('status'); });
    refresh.addEventListener('click', () => action('status'));
    install.addEventListener('click', async () => { const target = host.value; batch = true; paint(); for (const id of [...selected]) { try { await manage(target, 'install', id); selected.delete(id); } catch {} } batch = false; paint(); });
    wrap.append(host, note, install, refresh, error, rows); container.append(wrap);
    container.firstChild?.after(wrap);
    panel = { paint }; paint(); action('status');
  }
  // Format Selection (the document with nothing selected): the language server's formatter
  // when one runs, else Sulfur's own reindent; one undo step either way
  async function format(tab, whole = false) {
    if (!tab?.ed?.ready() || tab.info?.readOnly) return false;
    const text = tab.ed.text();
    const [from, to] = whole ? [0, 0] : tab.ed.selection();
    const indent = tab.ed.info().indent;
    const options = { tabSize: indent === 'tab' ? 4 : indent, insertSpaces: indent !== 'tab' };
    const doc = await get(tab).catch(() => null);
    const caps = doc?.session.client.capabilities || {};
    const ranged = from !== to;
    if (doc && (ranged ? caps.documentRangeFormattingProvider : caps.documentFormattingProvider)) {
      const edits = await doc.session.client.request(ranged ? 'textDocument/rangeFormatting' : 'textDocument/formatting', { textDocument: { uri: doc.uri }, options, ...(ranged ? { range: { start: positionAt(text, from), end: positionAt(text, to) } } : {}) });
      if (!api.alive(tab) || text !== tab.ed.text()) throw new Error('The file changed while formatting. Format it again.');
      if (edits?.length) { tab.ed.editMany(textEditRanges(text, edits)); changed(tab); }
      return true;
    }
    const edits = reindent(text, from, to, { ext: tab.rel.split('.').pop().toLowerCase(), unit: indent === 'tab' ? '\t' : ' '.repeat(indent) });
    if (edits.length) { tab.ed.editMany(edits); changed(tab); }
    return true;
  }
  // the Extensions view's search box narrows this list as well as the installed one
  function filter(text) { query = String(text || '').trim().toLowerCase(); panel?.paint(); }
  function suggesting(tab) { return tab?.view.querySelector('.ide-completion')?.hidden === false; }
  function dismissSuggest(tab) { completers.get(tab)?.hide(); }
  function suggest(tab) { tab?.ed?.focus(); return completers.get(tab)?.trigger(1, '', true); }
  function signature(tab) { tab?.ed?.focus(); return completers.get(tab)?.signature(); }
  function symbols(tab) { return completers.get(tab)?.symbols() || []; }
  function preferLanguage(tab) {
    const c = completers.get(tab);
    return !!c?.manual?.() || preferLanguageCompletion(tab.ed.text(), tab.ed.selection()[0], c?.symbols() || []);
  }
  const hasCodeActions = (tab) => !!attached.get(tab)?.session.client.capabilities.codeActionProvider;
  return { hover, signatureHelp, signatureTriggers, signature, quickFix, hasCodeActions, documentOutline, workspaceSymbols, openWorkspaceSymbol, callHierarchy, hierarchyCalls, openLocation, mount, filter, format, attach, changed, navigate, rename, reset, get, request, suggest, complete: suggest, cancelCompletions: () => { for (const c of completers.values()) c.hide(); api.onSuggest?.(); }, suggesting, dismissSuggest, symbols, preferLanguage, problems: () => [...diagnostics.values()].flatMap((d) => d.items.map((item) => ({ ...item, context: d.session.context }))), saved(tab) { const d = attached.get(tab); if (d) { changed(tab); const save = d.session.client.capabilities.textDocumentSync?.save; if (save) d.session.client.notify('textDocument/didSave', { textDocument: { uri: d.uri }, ...(save.includeText ? { text: tab.ed.text() } : {}) }); } } };
}
