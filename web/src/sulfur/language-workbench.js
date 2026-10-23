import { LANGUAGE_EXTENSIONS, languageId, positionAt, offsetAt, relativeUri, applyTextEdits, textEditRanges, completionEdits, snippetText, languageSocket } from './language-client.js';
import { createInlinePreview, attachAgentCompletion, inlineSuffix, preferLanguageCompletion } from './inline-completion.js';
import { semanticRanges } from './semantic-tokens.js';

const titles = ['TypeScript', 'Python', 'JavaScript', 'Java', 'C#', 'PHP', 'Shell (Bash)', 'C / C++', 'HCL / Terraform', 'Go'];
const ids = ['typescript', 'python', 'javascript', 'java', 'csharp', 'php', 'shell', 'cpp', 'hcl', 'go'];
const aborted = (e) => e?.name === 'AbortError';

// Keep the editor independent of hosts and installers. All text mutations use
// its edit() API, so completion/rename participate in collaboration and undo.
export function createLanguageWorkbench(api) {
  const states = new Map();
  const sessions = new Map();
  const attached = new Map();
  const diagnostics = new Map();
  const completions = new Map();
  const analyses = new Map();
  let generation = 0;
  let panel;
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
    for (const [t, doc] of attached) if (doc.session === session) { attached.delete(t); t.ed?.setDiagnostics(null); }
    for (const [key, value] of diagnostics) if (value.session === session) diagnostics.delete(key);
    api.problems();
  }
  function stopMatching(host, language) {
    for (const [key, value] of sessions) if (value.context.host === host && (!language || value.extension === language)) { clearSession(value); sessions.delete(key); }
  }
  function reset() {
    for (const c of completions.values()) c.cancel();
    generation++;
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
      if (tab) tab.ed.setDiagnostics(items.map((d) => ({ from: offsetAt(document.text, d.range.start), to: offsetAt(document.text, d.range.end), what: `${d.code ? `${d.code}: ` : ''}${d.message}`, severity: d.severity, source: d.source || session.extension })));
      api.problems();
    } catch (e) { api.log(e.message, `Languages: ${session.context.host}`); }
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
    const key = JSON.stringify([context.host, context.root, extension, context.configuration, context.buildDirectory, context.settings]);
    // Reinitialization is intentional: servers cache active build settings.
    for (const [old, session] of sessions) if (old !== key && session.extension === extension && session.context.host === context.host && session.context.root === context.root) { clearSession(session); sessions.delete(old); }
    let session = sessions.get(key);
    if (!session) {
      session = { key, context, extension };
      sessions.set(key, session);
      session.client = connect(context.host, { op: 'launch', language: extension, root: context.root, configuration: context.configuration, buildDirectory: context.buildDirectory }, (m) => receive(session, m));
      const userSettings = context.settings[extension] || {};
      const settings = extension === 'csharp' ? { csharp: { analyzersEnabled: api.setting('sulfur.csharp.analyzersEnabled'), useMetadataUris: true, applyFormattingOptions: true, ...(userSettings.csharp || userSettings) } } : userSettings;
      session.promise = session.client.initialize({ ...settings, sulfur: { configuration: context.configuration, buildDirectory: context.buildDirectory } }).then(() => { panel?.paint(); return session; }).catch((e) => { state(context.host).errors[extension] = e.message; panel?.paint(); clearSession(session); return null; });
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
      scheduleAnalysis(tab); scheduleWorkspaceAnalysis(session);
    }
    return result;
  }
  function changed(tab) {
    completions.get(tab)?.changed();
    const doc = attached.get(tab);
    if (!doc || doc.session.client.closed()) return;
    const client = doc.session.client;
    if (client.documents.get(doc.uri)?.text !== tab.ed.text()) {
      client.sync(doc.uri, languageId(tab.rel, doc.session.extension), tab.ed.text());
      tab.ed.setDiagnostics(null);
      diagnostics.delete(doc.session.key + '\n' + doc.uri);
      api.problems();
      scheduleAnalysis(tab);
      scheduleWorkspaceAnalysis(doc.session);
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
  function scheduleAnalysis(tab) {
    stopAnalysis(tab);
    if (!attached.has(tab)) return;
    const task = { controller: new AbortController() };
    analyses.set(tab, task);
    task.timer = setTimeout(async () => {
      const doc = attached.get(tab);
      if (!doc || !api.alive(tab) || doc.session.client.closed()) return;
      const { client } = doc.session;
      const text = tab.ed.text(), version = client.documents.get(doc.uri)?.version;
      const current = () => analyses.get(tab) === task && !task.controller.signal.aborted && api.alive(tab) && attached.get(tab) === doc && text === tab.ed.text() && version === client.documents.get(doc.uri)?.version;
      const options = { signal: task.controller.signal, timeout: 60000 };
      const requests = [];
      if (client.capabilities.semanticTokensProvider?.full) requests.push((async () => {
        const result = await client.request('textDocument/semanticTokens/full', { textDocument: { uri: doc.uri } }, options);
        if (current()) tab.ed.setSemanticTokens(semanticRanges(text, result?.data || [], client.capabilities.semanticTokensProvider.legend), text);
      })());
      if (client.capabilities.diagnosticProvider) requests.push((async () => {
        const result = await client.request('textDocument/diagnostic', { textDocument: { uri: doc.uri }, ...(doc.diagnosticResultId ? { previousResultId: doc.diagnosticResultId } : {}) }, options);
        if (!current()) return;
        doc.diagnosticResultId = result?.resultId;
        if (result?.kind === 'full') receive(doc.session, { method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, version, resultId: result.resultId, diagnostics: result.items || [] } });
        for (const [uri, report] of Object.entries(result?.relatedDocuments || {})) if (report.kind === 'full') receive(doc.session, { method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: report.items || [] } });
      })());
      const results = await Promise.allSettled(requests);
      if (current() && requests.length) {
        doc.session.analysisReady = results.every((r) => r.status === 'fulfilled');
        panel?.paint();
      }
      for (const result of results) if (result.status === 'rejected' && !aborted(result.reason) && current()) api.log(result.reason.message, `Languages: ${doc.session.context.host}`);
    }, 350);
  }
  async function request(tab, method, extra = {}, signal) {
    if (signal?.aborted) return null;
    const doc = await get(tab);
    if (!doc || signal?.aborted) return null;
    const capability = { completion: 'completionProvider', definition: 'definitionProvider', references: 'referencesProvider', rename: 'renameProvider', formatting: 'documentFormattingProvider' }[method];
    if (!doc.session.client.capabilities[capability]) return null;
    const text = tab.ed.text();
    const caret = tab.ed.selection()[0];
    const version = doc.session.client.documents.get(doc.uri).version;
    const value = await doc.session.client.request(`textDocument/${method}`, { textDocument: { uri: doc.uri }, position: positionAt(text, caret), ...extra }, { signal });
    if (!api.alive(tab) || text !== tab.ed.text() || version !== doc.session.client.documents.get(doc.uri)?.version || (method === 'completion' && tab.ed.selection()[0] !== caret)) return { stale: true };
    return { value, doc, text, caret, version };
  }
  function attach(tab) {
    const ta = tab.view.querySelector('.code-ta');
    const box = api.el('div', 'ide-completion');
    box.hidden = true; box.setAttribute('role', 'listbox'); box.id = `${tab.id}-completions`;
    ta.setAttribute('aria-controls', box.id); ta.setAttribute('aria-autocomplete', 'both'); ta.setAttribute('aria-expanded', 'false');
    tab.view.append(box);
    const preview = createInlinePreview(tab, api.el);
    let timer, controller, items = [], selected = 0, snapshot, defaults, manual = false, disposed = false;
    const agent = attachAgentCompletion(tab, {
      alive: api.alive, enabled: () => api.setting('sulfur.agentCompletion.enabled'),
      delay: () => Math.max(300, Number(api.setting('sulfur.agentCompletion.delay')) || 700),
      suggest: api.suggest, error: api.error, listVisible: () => !box.hidden,
      preferLanguage: () => manual || (!box.hidden && preferLanguageCompletion(tab.ed.text(), ta.selectionStart, items)),
      beforeShow: () => hide(),
    }, preview);
    function hide() { clearTimeout(timer); controller?.abort(); box.hidden = true; ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant'); if (preview.current()?.source === 'language') preview.clear(); }
    function cancel() { hide(); manual = false; preview.clear(); agent.cancel(); }
    function paintPreview() {
      if (!api.setting('editor.inlineSuggest.enabled') || !snapshot || !items[selected]) { preview.clear(); return; }
      try { preview.show(snapshot.text, snapshot.caret, inlineSuffix(completionEdits(items[selected], snapshot.text, snapshot.caret, defaults), snapshot.text, snapshot.caret), 'language'); } catch { preview.clear(); }
    }
    function paint() {
      box.replaceChildren(...items.map((item, index) => {
        const row = api.el('div', `ide-completion-item${index === selected ? ' on' : ''}`);
        row.id = `${box.id}-${index}`; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected));
        row.append(api.el('span', '', item.label), api.el('small', '', item.detail || item.labelDetails?.description || ''));
        row.addEventListener('mousedown', (e) => { e.preventDefault(); selected = index; insert().catch(api.error); });
        return row;
      }));
      ta.setAttribute('aria-activedescendant', `${box.id}-${selected}`);
      const row = box.children[selected];
      if (row && row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
      else if (row && row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
      paintPreview();
    }
    async function insert() {
      const current = snapshot;
      const item = items[selected];
      const currentDefaults = defaults;
      cancel();
      if (!current || current.stale || current.text !== tab.ed.text() || current.caret !== tab.ed.selection()[0] || tab.info?.readOnly) return;
      const client = current.doc.session.client;
      let resolved = item;
      if (client.capabilities.completionProvider?.resolveProvider) {
        try { resolved = { ...item, ...await client.request('completionItem/resolve', { ...item, data: item.data ?? currentDefaults?.data }) }; }
        catch (e) { api.log(`Completion details unavailable: ${e.message}`, 'Languages'); }
      }
      if (current.text !== tab.ed.text() || current.caret !== tab.ed.selection()[0] || !api.alive(tab) || document.activeElement !== ta || ta.readOnly || client.closed() || client.documents.get(current.doc.uri)?.version !== current.version) return;
      const applied = completionEdits(resolved, current.text, current.caret, currentDefaults);
      tab.ed.editMany(applied.edits, [applied.caret, applied.caret]);
      changed(tab);
    }
    async function complete(explicit = false) {
      hide();
      if (explicit) agent.cancel();
      manual = explicit;
      if (disposed || ta !== document.activeElement || ta.selectionStart !== ta.selectionEnd || ta.readOnly) return;
      controller = new AbortController();
      const own = controller;
      try {
        const result = await request(tab, 'completion', { context: { triggerKind: 1 } }, own.signal);
        if (!result && explicit && !own.signal.aborted && document.activeElement === ta) api.notice('Enable this file’s language extension in Extensions for project IntelliSense.');
        if (!result || result.stale || own.signal.aborted || disposed || document.activeElement !== ta) return;
        defaults = result.value?.itemDefaults || {};
        const prefix = result.text.slice(0, result.caret).match(/[\p{L}\p{N}_$]*$/u)[0].toLowerCase();
        items = (Array.isArray(result.value) ? result.value : result.value?.items || []).filter((x) => {
          if (prefix && !String(x.filterText || x.label).toLowerCase().startsWith(prefix)) return false;
          try {
            if ((x.insertTextFormat || defaults.insertTextFormat) === 2) snippetText(x.textEdit?.newText ?? x.textEditText ?? x.insertText ?? x.label);
            return true;
          } catch { return false; }
        }).sort((a, b) => String(a.sortText || a.label).localeCompare(String(b.sortText || b.label))).slice(0, 100);
        if (!items.length) { if (explicit) api.notice('No code completions returned. Check the language extension in Extensions, or enable agent completions in Settings.'); return; }
        snapshot = result; selected = 0; box.hidden = false; ta.setAttribute('aria-expanded', 'true'); paint();
        const style = getComputedStyle(ta);
        const before = result.text.slice(0, result.caret);
        const line = before.slice(before.lastIndexOf('\n') + 1);
        const tabSize = parseInt(style.tabSize, 10) || 4;
        const columns = [...line].reduce((n, ch) => ch === '\t' ? n + tabSize - n % tabSize : n + 1, 0);
        const canvas = document.createElement('canvas'); const measure = canvas.getContext('2d'); measure.font = style.font;
        const rect = ta.getBoundingClientRect(); const outer = tab.view.getBoundingClientRect();
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
        const y = rect.top - outer.top + parseFloat(style.paddingTop) + before.split('\n').length * lineHeight - ta.scrollTop;
        box.style.left = `${Math.max(0, Math.min(outer.width - box.offsetWidth, rect.left - outer.left + parseFloat(style.paddingLeft) + columns * measure.measureText('M').width - ta.scrollLeft))}px`;
        box.style.top = `${Math.max(0, y + box.offsetHeight > outer.height ? y - box.offsetHeight - lineHeight : y)}px`;
      } catch (e) { if (!aborted(e) && explicit) api.error(e); }
    }
    const events = new AbortController();
    const on = (target, event, fn, options = {}) => target.addEventListener(event, fn, { ...options, signal: events.signal });
    on(ta, 'input', (e) => { hide(); manual = false; if (!e.isComposing) timer = setTimeout(() => complete(), 180); });
    on(ta, 'compositionstart', cancel);
    on(ta, 'blur', cancel);
    const scroller = tab.view.querySelector('.code-ed');
    // Highlighting and keeping the caret visible also scroll this element.
    // Only user scrolling should dismiss a completion, not those redraws.
    on(scroller, 'wheel', cancel, { passive: true });
    on(scroller, 'touchmove', cancel, { passive: true });
    on(scroller, 'pointerdown', (e) => { if (e.target !== ta) cancel(); });
    on(ta, 'pointerdown', cancel);
    const selectionChanged = () => { if (document.activeElement !== ta || (!box.hidden && snapshot && (snapshot.caret !== ta.selectionStart || ta.selectionStart !== ta.selectionEnd))) cancel(); };
    document.addEventListener('selectionchange', selectionChanged);
    on(ta, 'keydown', (e) => {
      if (e.isComposing) return;
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); complete(true); return; }
      if (box.hidden) { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) hide(); return; }
      if (['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) {
        if (e.key === 'Tab' && (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey)) { cancel(); return; }
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Escape') cancel();
        else if (e.key === 'Enter' || e.key === 'Tab') insert().catch(api.error);
        else { manual = true; agent.cancel(); selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; paint(); }
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) hide();
    }, { capture: true });
    completions.set(tab, { cancel, changed() { agent.changed(); if (snapshot && (snapshot.text !== tab.ed.text() || ta.readOnly)) hide(); }, complete: () => complete(true), agent: () => { manual = false; return agent.complete(true); } });
    const dispose = tab.dispose;
    tab.dispose = () => { disposed = true; cancel(); stopAnalysis(tab); events.abort(); agent.dispose(); preview.remove(); completions.delete(tab); document.removeEventListener('selectionchange', selectionChanged); const doc = attached.get(tab); if (doc) { doc.session.client.closeDocument(doc.uri); attached.delete(tab); diagnostics.delete(doc.session.key + '\n' + doc.uri); } dispose(); box.remove(); api.problems(); };
  }
  async function navigate(tab, references = false) {
    const result = await request(tab, references ? 'references' : 'definition', references ? { context: { includeDeclaration: true } } : {});
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
    const hit = locations.length === 1 ? locations[0] : await api.pick(locations.map((x) => ({ label: `${x.rel}:${x.range.start.line + 1}`, value: x })), { title: references ? 'References' : 'Definitions' });
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
  async function rename(tab) {
    const doc = await get(tab);
    if (!doc?.session.client.capabilities.renameProvider) return false;
    const value = await api.input({ title: 'Rename Symbol', prompt: 'New symbol name (language server validates it)' });
    if (!value) return true;
    const result = await request(tab, 'rename', { newName: value });
    if (!result || result.stale || !result.value) return true;
    const edit = result.value;
    const groups = [];
    if (edit.changes) for (const [uri, edits] of Object.entries(edit.changes)) groups.push({ textDocument: { uri }, edits });
    if (edit.documentChanges) groups.push(...edit.documentChanges);
    if (groups.some((x) => !x.textDocument || !Array.isArray(x.edits))) throw new Error('This rename includes file operations, which Sulfur cannot apply.');
    const prepared = [];
    const seen = new Set();
    for (const group of groups) {
      const uri = group.textDocument.uri;
      if (seen.has(uri)) throw new Error('Duplicate document edits in rename');
      seen.add(uri);
      const path = api.join(doc.session.context.rootRel, relativeUri(doc.session.client.rootUri, uri));
      const target = await api.prepare(path, doc.session.context);
      const version = group.textDocument.version;
      if (version != null && doc.session.client.documents.get(uri)?.version !== version) throw new Error(`Document version changed: ${path}`);
      const before = target.ed.text();
      prepared.push({ target, before, after: applyTextEdits(before, group.edits), edits: textEditRanges(before, group.edits) });
    }
    if (!prepared.length) return true;
    // Review in open tabs, as with Sulfur's syntax rename. Validate all before
    // any mutation; each file gets a single undo entry.
    const apply = await api.pick([{ label: `Apply rename to ${prepared.length} files`, value: true }, { label: 'Cancel', value: false }], { title: 'Rename from language server', placeholder: prepared.map((x) => x.target.rel).join(', ') });
    if (!apply) return true;
    if (prepared.some((x) => !api.alive(x.target) || x.target.ed.text() !== x.before || x.target.info?.readOnly)) throw new Error('Files changed while reviewing rename. Run Rename again.');
    for (const x of prepared) { x.target.ed.editMany(x.edits); changed(x.target); }
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
      rows.replaceChildren(...s.extensions.map((item) => {
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
  return { mount, attach, changed, navigate, rename, reset, get, request,
    complete: (tab) => completions.get(tab)?.complete(), agentComplete: (tab) => completions.get(tab)?.agent(),
    cancelCompletions: () => { for (const c of completions.values()) c.cancel(); },
    problems: () => [...diagnostics.values()].flatMap((d) => d.items.map((item) => ({ ...item, context: d.session.context }))),
    saved(tab) { const d = attached.get(tab); if (d) { changed(tab); const save = d.session.client.capabilities.textDocumentSync?.save; if (save) d.session.client.notify('textDocument/didSave', { textDocument: { uri: d.uri }, ...(save.includeText ? { text: tab.ed.text() } : {}) }); } },
  };
}
