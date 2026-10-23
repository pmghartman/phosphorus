import { LANGUAGE_EXTENSIONS, languageId, positionAt, offsetAt, relativeUri, applyTextEdits, textEditRanges, completionEdits, languageSocket } from './language-client.js';
import { isWordChar, wordBefore, rankCompletions, wordCompletions, kindOf, inCommentOrString } from './completion.js';
import { reindent } from './format.js';

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
    session.client?.close();
    for (const [t, doc] of attached) if (doc.session === session) { attached.delete(t); t.ed?.setDiagnostics(null); }
    for (const [key, value] of diagnostics) if (value.session === session) diagnostics.delete(key);
    api.problems();
  }
  function stopMatching(host, language) {
    for (const [key, value] of sessions) if (value.context.host === host && (!language || value.extension === language)) { clearSession(value); sessions.delete(key); }
  }
  function reset() {
    generation++;
    for (const s of sessions.values()) clearSession(s);
    sessions.clear(); attached.clear(); diagnostics.clear();
  }
  function receive(session, message) {
    if (message._sulfur === 'error' || message._sulfur === 'closed') {
      if (message.error) { state(session.context.host).errors[session.extension] = message.error; panel?.paint(); }
      clearSession(session); return;
    }
    if (message.method === 'window/logMessage' || message.method === 'window/showMessage') api.log(message.params?.message || '', `Languages: ${session.context.host}`);
    if (message.method !== 'textDocument/publishDiagnostics') return;
    const p = message.params;
    try {
      const rel = relativeUri(session.client.rootUri, p.uri);
      const document = session.client.documents.get(p.uri);
      if (p.version != null && p.version !== document?.version) return;
      const tab = [...attached].find(([, d]) => d.session === session && d.uri === p.uri)?.[0];
      if (tab && document?.text !== tab.ed.text()) return;
      const items = (p.diagnostics || []).map((d) => ({ ...d, path: api.join(session.context.rootRel, rel) }));
      diagnostics.set(session.key + '\n' + p.uri, { session, uri: p.uri, items });
      if (tab) tab.ed.setDiagnostics(items.map((d) => ({ from: offsetAt(document.text, d.range.start), to: offsetAt(document.text, d.range.end), what: d.message, severity: d.severity, source: d.source || session.extension })));
      api.problems();
    } catch (e) { api.log(e.message, `Languages: ${session.context.host}`); }
  }
  async function get(tab) {
    if (!tab?.ed?.ready() || tab.info?.readOnly) return null;
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
      session.promise = session.client.initialize({ ...(context.settings[extension] || {}), sulfur: { configuration: context.configuration, buildDirectory: context.buildDirectory } }).then(() => { panel?.paint(); return session; }).catch((e) => { state(context.host).errors[extension] = e.message; panel?.paint(); clearSession(session); return null; });
    }
    const ready = await session.promise;
    if (!ready || epoch !== generation || session.client.closed() || !api.alive(tab)) return null;
    const uri = `${session.client.rootUri.replace(/\/$/, '')}/${context.documentRel.split('/').map(encodeURIComponent).join('/')}`;
    const previous = attached.get(tab);
    if (previous && (previous.uri !== uri || previous.session !== session)) previous.session.client.closeDocument(previous.uri);
    session.client.sync(uri, languageId(tab.rel, extension), tab.ed.text());
    const result = { session, uri };
    attached.set(tab, result);
    return result;
  }
  function changed(tab) {
    const doc = attached.get(tab);
    if (!doc || doc.session.client.closed()) return;
    const client = doc.session.client;
    if (client.documents.get(doc.uri)?.text !== tab.ed.text()) {
      client.sync(doc.uri, languageId(tab.rel, doc.session.extension), tab.ed.text());
      tab.ed.setDiagnostics(null);
      diagnostics.delete(doc.session.key + '\n' + doc.uri);
      api.problems();
    }
  }
  async function request(tab, method, extra = {}, signal) {
    const doc = await get(tab);
    if (!doc) return null;
    const capability = { completion: 'completionProvider', definition: 'definitionProvider', references: 'referencesProvider', rename: 'renameProvider' }[method];
    if (!doc.session.client.capabilities[capability]) return null;
    const text = tab.ed.text();
    const caret = tab.ed.selection()[0];
    const version = doc.session.client.documents.get(doc.uri).version;
    const value = await doc.session.client.request(`textDocument/${method}`, { textDocument: { uri: doc.uri }, position: positionAt(text, caret), ...extra }, { signal });
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
    ta.setAttribute('aria-controls', box.id); ta.setAttribute('aria-autocomplete', 'list');
    tab.view.append(box);
    // session: the items asked for the word starting at from; shown: those matching what's typed
    let session = null, shown = [], selected = 0, timer, controller;
    function close() { box.hidden = true; ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-activedescendant'); }
    function hide() { clearTimeout(timer); controller?.abort(); session = null; shown = []; close(); }
    // the highlight's class at a place before the caret: VS Code's quick suggestions stay out of comments and strings
    function quiet(offset) {
      if (offset < 0) return false;
      const pre = tab.view.querySelector('pre.code-hl:not(.code-agent):not(.code-finds):not(.code-squig)');
      if (!pre) return false;
      const walk = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
      for (let at = 0, node = walk.nextNode(); node; node = walk.nextNode()) {
        if (offset < at + node.length) return !!node.parentElement?.closest('.hljs-comment, .hljs-string, .hljs-regexp');
        at += node.length;
      }
      return false;
    }
    function paint() {
      box.replaceChildren(...shown.map(({ item, matches }, index) => {
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
      }));
      ta.setAttribute('aria-activedescendant', `${box.id}-${selected}`);
      const row = box.children[selected];
      if (row && row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop;
      else if (row && row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
    }
    // the list under the word's start, above it when there's no room below
    function place(text, from) {
      const style = getComputedStyle(ta);
      const before = text.slice(0, from);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      const tabSize = parseInt(style.tabSize, 10) || 4;
      const columns = [...line].reduce((n, ch) => ch === '\t' ? n + tabSize - n % tabSize : n + 1, 0);
      const measure = document.createElement('canvas').getContext('2d'); measure.font = style.font;
      const rect = ta.getBoundingClientRect(); const outer = tab.view.getBoundingClientRect();
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
      const y = rect.top - outer.top + parseFloat(style.paddingTop) + before.split('\n').length * lineHeight - ta.scrollTop;
      box.style.left = `${Math.max(0, Math.min(outer.width - box.offsetWidth, rect.left - outer.left + parseFloat(style.paddingLeft) + columns * measure.measureText('M').width - ta.scrollLeft))}px`;
      box.style.top = `${Math.max(0, y + box.offsetHeight > outer.height ? y - box.offsetHeight - lineHeight : y)}px`;
    }
    function refilter() {
      if (!session) return;
      const text = tab.ed.text();
      const caret = ta.selectionStart;
      const typed = text.slice(session.from, caret);
      if (caret !== ta.selectionEnd || caret < session.from || /[^\p{L}\p{N}_$]/u.test(typed) || (!typed && !session.anchored)) { hide(); return; }
      shown = rankCompletions(session.items, typed);
      // a word that's already whole is nothing to suggest
      if (!session.lsp && shown.length === 1 && shown[0].item.label === typed) shown = [];
      if (!shown.length) { close(); return; }
      selected = 0; box.hidden = false; ta.setAttribute('aria-expanded', 'true');
      paint(); place(text, session.from);
    }
    async function trigger(triggerKind, triggerCharacter = '', explicit = false) {
      controller?.abort();
      const own = controller = new AbortController();
      const text = tab.ed.text();
      const caret = ta.selectionStart;
      if (ta !== document.activeElement || caret !== ta.selectionEnd || tab.info?.readOnly) return;
      const from = caret - wordBefore(text, caret).length;
      let items = [], lsp = null, defaults = {}, incomplete = false;
      try {
        const result = await request(tab, 'completion', { context: triggerCharacter ? { triggerKind: 2, triggerCharacter } : { triggerKind } }, own.signal);
        if (result?.value) {
          lsp = result; defaults = result.value.itemDefaults || {};
          items = Array.isArray(result.value) ? result.value : result.value.items || [];
          incomplete = !!result.value.isIncomplete;
        }
      } catch (e) { if (!aborted(e) && explicit) api.error(e); }
      if (own.signal.aborted || document.activeElement !== ta) return;
      const now = tab.ed.text();
      // typed since the request: fine while it only went on with the same word
      if (now.slice(0, from) !== text.slice(0, from) || ta.selectionStart < from) return;
      if (!items.length) {
        if (triggerCharacter) return;
        items = wordCompletions(api.documents?.(tab) || [], now, ta.selectionStart);
        lsp = null;
      }
      session = { from, items, lsp, defaults, incomplete, anchored: explicit || !!triggerCharacter };
      refilter();
    }
    async function accept() {
      const pick = shown[selected];
      const s = session;
      hide();
      if (!pick || !s || tab.info?.readOnly) return;
      let item = pick.item;
      if (!s.lsp) { const end = s.from + String(item.label).length; tab.ed.editMany([{ from: s.from, to: ta.selectionStart, text: String(item.label) }], [end, end]); changed(tab); return; }
      const client = s.lsp.doc.session.client;
      if (client.capabilities.completionProvider?.resolveProvider) {
        try { item = { ...item, ...await client.request('completionItem/resolve', { ...item, data: item.data ?? s.defaults.data }) }; } catch (e) { api.log(e.message, `Languages: ${s.lsp.doc.session.context.host}`); }
      }
      const text = tab.ed.text();
      const caret = ta.selectionStart;
      if (!api.alive(tab) || caret < s.from || text.slice(0, s.from) !== s.lsp.text.slice(0, s.from)) return;
      const move = (r) => rebase(r, s.lsp.text, s.lsp.caret, text, caret);
      const moved = { ...item, ...(item.textEdit ? { textEdit: { ...item.textEdit, ...(item.textEdit.range ? { range: move(item.textEdit.range) } : move({ insert: item.textEdit.insert, replace: item.textEdit.replace })) } } : {}), additionalTextEdits: (item.additionalTextEdits || []).map((e) => ({ ...e, range: move(e.range) })) };
      const defaults = s.defaults.editRange ? { ...s.defaults, editRange: move(s.defaults.editRange) } : s.defaults;
      const applied = completionEdits(moved, text, caret, defaults);
      tab.ed.editMany(applied.edits, applied.selection);
      changed(tab);
    }
    const triggers = () => attached.get(tab)?.session.client.capabilities.completionProvider?.triggerCharacters || [];
    ta.addEventListener('input', (e) => {
      if (e.isComposing) return;
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
    ta.addEventListener('scroll', () => { if (!box.hidden) hide(); });
    ta.addEventListener('pointerdown', hide);
    const selectionChanged = () => { if (document.activeElement === ta && session && (ta.selectionStart !== ta.selectionEnd || ta.selectionStart < session.from)) hide(); };
    document.addEventListener('selectionchange', selectionChanged);
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') { e.preventDefault(); e.stopImmediatePropagation(); trigger(1, '', true); return; }
      if (box.hidden) { if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) hide(); return; }
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Enter', 'Tab', 'Escape'].includes(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); e.stopImmediatePropagation();
        if (e.key === 'Escape') hide();
        else if (e.key === 'Enter' || e.key === 'Tab') accept().catch(api.error);
        else {
          const page = Math.max(1, Math.floor(box.clientHeight / (box.firstChild?.offsetHeight || 22)) - 1);
          const step = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page }[e.key];
          selected = e.key.startsWith('Page') ? Math.max(0, Math.min(shown.length - 1, selected + step)) : (selected + step + shown.length) % shown.length;
          paint();
        }
      } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) hide();
    }, true);
    const dispose = tab.dispose;
    tab.dispose = () => { hide(); document.removeEventListener('selectionchange', selectionChanged); const doc = attached.get(tab); if (doc) { doc.session.client.closeDocument(doc.uri); attached.delete(tab); diagnostics.delete(doc.session.key + '\n' + doc.uri); } dispose(); box.remove(); api.problems(); };
  }
  async function navigate(tab, references = false) {
    const result = await request(tab, references ? 'references' : 'definition', references ? { context: { includeDeclaration: true } } : {});
    if (!result) return false;
    if (result.stale) return true;
    const locations = (Array.isArray(result.value) ? result.value : result.value ? [result.value] : []).flatMap((x) => {
      try {
        const uri = x.targetUri || x.uri;
        const range = x.targetSelectionRange || x.range;
        return [{ uri, range, rel: api.join(result.doc.session.context.rootRel, relativeUri(result.doc.session.client.rootUri, uri)) }];
      } catch { return []; }
    });
    if (!locations.length) { api.notice('No project locations returned by the language server.'); return true; }
    const hit = locations.length === 1 ? locations[0] : await api.pick(locations.map((x) => ({ label: `${x.rel}:${x.range.start.line + 1}`, value: x })), { title: references ? 'References' : 'Definitions' });
    if (hit && api.alive(tab)) api.open(hit.rel, result.doc.session.context, hit.range);
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
  return { mount, filter, format, attach, changed, navigate, rename, reset, get, problems: () => [...diagnostics.values()].flatMap((d) => d.items.map((item) => ({ ...item, context: d.session.context }))), saved(tab) { const d = attached.get(tab); if (d) { changed(tab); const save = d.session.client.capabilities.textDocumentSync?.save; if (save) d.session.client.notify('textDocument/didSave', { textDocument: { uri: d.uri }, ...(save.includeText ? { text: tab.ed.text() } : {}) }); } } };
}
