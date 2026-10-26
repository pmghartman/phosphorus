// Sulfur's own SQLite view. Database work runs on the host holding the file;
// this view keeps at most one page of results and never loads a database blob.
export const isSQLiteFile = (path) => /\.(?:sqlite3?|db3?)$/i.test(path);
export const quoteSQLiteIdentifier = (name) => `"${String(name).replaceAll('"', '""')}"`;
export function sqliteTableQuery(name, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid row offset');
  return `SELECT * FROM ${quoteSQLiteIdentifier(name)} LIMIT 201 OFFSET ${offset}`;
}

export function sqliteProjectPath(root, value) {
  const parts = String(value).trim().replaceAll('\\', '/').split('/');
  if (!parts.length || parts.some((p) => !p || p === '.' || p === '..' || /[:\x00-\x1f]/.test(p))) return null;
  return [root.replace(/\/$/, ''), ...parts].filter(Boolean).join('/');
}

export function createSQLiteClient(request) {
  let active = null, disposed = false;
  return {
    async run(op, sql = '', limit = 200) {
      if (disposed) throw new DOMException('View closed', 'AbortError');
      active?.abort();
      const current = active = new AbortController();
      const result = await request({ op, sql, limit }, current.signal);
      // A host may finish a request after its transport was cancelled.
      if (current.signal.aborted || disposed) throw new DOMException('Request cancelled', 'AbortError');
      return result;
    },
    dispose() { disposed = true; active?.abort(); },
  };
}

export function mountSQLite(container, { path, request, onChange = () => {} }) {
  const client = createSQLiteClient(request);
  const node = (tag, cls, text) => {
    const n = document.createElement(tag);
    n.className = cls || '';
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const controls = [];
  const button = (text, action, parent) => {
    const b = node('button', 'ide-button secondary', text);
    b.type = 'button';
    b.addEventListener('click', action);
    controls.push(b);
    parent.append(b);
    return b;
  };
  const root = node('div', 'ide-sqlite');
  const header = node('div', 'ide-sqlite-header');
  header.append(node('h2', '', 'SQLite'), node('span', 'ide-sqlite-path', path));
  const body = node('div', 'ide-sqlite-body');
  const side = node('aside', 'ide-sqlite-side');
  const tools = node('div', 'ide-sqlite-tools');
  const tables = node('div', 'ide-sqlite-tables');
  tables.setAttribute('aria-label', 'Tables and views');
  const main = node('div', 'ide-sqlite-main');
  const sql = node('textarea', 'ide-input ide-sqlite-sql');
  sql.setAttribute('aria-label', 'SQL');
  sql.spellcheck = false;
  sql.placeholder = 'SELECT * FROM "table_name";';
  const actions = node('div', 'ide-sqlite-tools');
  const status = node('div', 'ide-sqlite-status', 'Opening database…');
  status.setAttribute('role', 'status');
  const result = node('div', 'ide-sqlite-result');
  const paging = node('div', 'ide-sqlite-tools');
  let busy = false, closed = false, selected = '', offset = 0, nextOffset = 0, hasMore = false;
  let browsing = false, schema = [];
  const paintControls = () => {
    for (const b of controls) b.disabled = busy;
    prev.disabled = busy || !browsing || offset === 0;
    next.disabled = busy || !browsing || !hasMore;
    for (const b of tables.querySelectorAll('button')) b.disabled = busy;
    sql.disabled = busy;
    root.setAttribute('aria-busy', String(busy));
  };
  function showResult(r) {
    const table = node('table', 'ide-sqlite-grid');
    const head = node('tr');
    for (const c of r.columns || []) head.append(node('th', '', c));
    const thead = node('thead');
    thead.append(head);
    table.append(thead);
    const tbody = node('tbody');
    for (const row of r.rows || []) {
      const tr = node('tr');
      for (const value of row) {
        const td = node('td', value === null ? 'ide-sqlite-null' : '', value === null ? 'NULL' : String(value));
        tr.append(td);
      }
      tbody.append(tr);
    }
    table.append(tbody);
    result.replaceChildren(table);
  }
  async function task(label, work) {
    if (busy || closed) return;
    busy = true;
    status.classList.remove('error');
    status.textContent = label;
    paintControls();
    try { await work(); }
    catch (err) {
      if (!closed && err.name !== 'AbortError') {
        status.classList.add('error');
        status.textContent = err.message;
      }
    } finally {
      busy = false;
      if (!closed) paintControls();
    }
  }
  async function loadSchema() {
    const r = await client.run('schema', '', 1000);
    schema = r.rows || [];
    tables.replaceChildren();
    for (const [name, type, ddl] of schema) {
      const b = node('button', 'ide-sqlite-table', `${name}${type === 'view' ? ' (view)' : ''}`);
      b.type = 'button';
      b.title = ddl || name;
      b.dataset.table = name;
      b.classList.toggle('selected', name === selected);
      b.addEventListener('click', () => task('Loading rows…', () => browse(name, 0)));
      tables.append(b);
    }
    if (!schema.length) tables.append(node('p', 'ide-muted', 'No tables yet. Choose New Table to start.'));
    if (r.truncated) tables.append(node('p', '', 'Showing the first 1,000 tables and views.'));
  }
  async function browse(name, start) {
    const query = sqliteTableQuery(name, start);
    const r = await client.run('query', query);
    selected = name;
    offset = start;
    nextOffset = start + r.rows.length;
    browsing = true;
    hasMore = !!r.truncated && r.rows.length > 0;
    sql.value = query;
    for (const b of tables.querySelectorAll('button')) b.classList.toggle('selected', b.dataset.table === name);
    showResult(r);
    status.textContent = r.rows.length ? `Rows ${offset + 1}–${offset + r.rows.length}${r.truncated ? ' · more available' : ''}` : 'No rows';
  }
  button('Refresh', () => task('Refreshing…', async () => {
    await loadSchema();
    if (selected && schema.some((t) => t[0] === selected)) await browse(selected, offset);
    else { selected = ''; browsing = false; result.replaceChildren(); status.textContent = `${schema.length} tables and views`; }
  }), tools);
  button('New Table', () => {
    sql.value = 'CREATE TABLE "example" (\n  "id" INTEGER PRIMARY KEY,\n  "name" TEXT NOT NULL\n);';
    browsing = false;
    status.textContent = 'Edit the table definition, then choose Execute SQL.';
    paintControls();
    sql.focus();
  }, tools);
  const query = () => task('Running query…', async () => {
    const r = await client.run('query', sql.value);
    browsing = false;
    showResult(r);
    status.textContent = `${r.rows.length} ${r.rows.length === 1 ? 'row' : 'rows'}${r.truncated ? ' · result limited to 200 rows or 8 MiB' : ''}`;
  });
  button('Run Query', query, actions).title = 'Read-only query · Ctrl+Enter';
  button('Execute SQL', () => task('Executing transaction…', async () => {
    const r = await client.run('execute', sql.value);
    browsing = false;
    await loadSchema();
    result.replaceChildren();
    status.textContent = `Transaction committed · ${r.changes || 0} rows changed`;
    onChange();
  }), actions).title = 'Apply SQL changes atomically; errors roll back the batch';
  const prev = button('Previous 200', () => task('Loading rows…', () => browse(selected, Math.max(0, offset - 200))), paging);
  const next = button('Next 200', () => task('Loading rows…', () => browse(selected, nextOffset)), paging);
  sql.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); query(); }
  });
  sql.addEventListener('input', () => { browsing = false; paintControls(); });
  tools.setAttribute('aria-label', 'Database tools');
  side.append(tools, tables);
  main.append(sql, actions, status, result, paging);
  body.append(side, main);
  root.append(header, body);
  container.append(root);
  task('Opening database…', async () => {
    await loadSchema();
    if (schema.length) await browse(schema[0][0], 0);
    else status.textContent = 'Database ready. Create a table or run SQL.';
  });
  return { dispose() { closed = true; client.dispose(); root.remove(); } };
}
