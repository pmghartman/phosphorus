// Raw pretty output works on every host without shell-sensitive format tokens.
export function parseGitLog(output) {
  const commits = [];
  let commit = null;
  for (const line of String(output).replace(/\r\n/g, '\n').split('\n')) {
    const head = /^commit ([a-f\d]{40,64})(?: \((.*)\))?$/.exec(line);
    if (head) {
      commit = { hash: head[1], refs: head[2] ? head[2].split(', ') : [], parents: [], message: '', author: '', email: '', time: 0, committer: '' };
      commits.push(commit);
    } else if (commit) {
      if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
      const person = /^(author|committer) (.*) <([^>]*)> (\d+) [+-]\d{4}$/.exec(line);
      if (person?.[1] === 'author') Object.assign(commit, { author: person[2], email: person[3], time: Number(person[4]) * 1000 });
      if (person?.[1] === 'committer') commit.committer = person[2];
      if (line.startsWith('    ')) commit.message += `${line.slice(4)}\n`;
    }
  }
  for (const commit of commits) { commit.message = commit.message.trimEnd(); commit.subject = commit.message.split('\n')[0] || '(no commit message)'; }
  return commits;
}

// Keep pending parents in lanes. First parents continue a lane, merges create
// lanes, and an already-pending parent joins its existing lane.
export function layoutGitGraph(commits) {
  let lanes = [], color = 0, columns = 1;
  const rows = [];
  for (const commit of commits) {
    let column = lanes.findIndex((l) => l.hash === commit.hash);
    const incoming = column >= 0;
    if (!incoming) { column = lanes.length; lanes.push({ hash: commit.hash, color: color++ }); }
    const before = [...lanes], node = before[column];
    const after = before.filter((_, i) => i !== column);
    const parents = [...new Set(commit.parents)];
    for (const [index, hash] of parents.entries()) {
      if (after.some((l) => l.hash === hash)) continue;
      const lane = { hash, color: index === 0 ? node.color : color++ };
      if (index === 0) after.splice(Math.min(column, after.length), 0, lane); else after.push(lane);
    }
    const edges = before.flatMap((l, i) => i === column ? [] : [{ from: i, to: after.findIndex((a) => a.hash === l.hash), color: l.color, node: false }]);
    edges.push(...parents.map((hash) => ({ from: column, to: after.findIndex((l) => l.hash === hash), color: after.find((l) => l.hash === hash).color, node: true })));
    columns = Math.max(columns, before.length, after.length);
    rows.push({ commit, column, color: node.color, incoming, before, after, edges });
    lanes = [...after];
  }
  return { rows, columns };
}

// With -z Git leaves paths unquoted; rename/copy entries contain two paths.
export function parseGitChanges(status, stats = '') {
  const parts = String(status).split('\0'), files = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    if (!code) continue;
    const first = parts[i++];
    const renamed = /^[RC]/.test(code);
    const path = renamed ? parts[i++] : first;
    if (path === undefined) break;
    files.push({ code: code[0], path, from: renamed ? first : '', added: '', removed: '' });
  }
  const counts = new Map();
  const fields = String(stats).split('\0');
  for (let i = 0; i < fields.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[i]);
    if (!match) continue;
    let path = match[3];
    if (!path) { i++; path = fields[++i]; }
    counts.set(path, { added: match[1], removed: match[2] });
  }
  return files.map((file) => ({ ...file, ...counts.get(file.path) }));
}

const COLORS = ['#4aa8ec', '#c586c0', '#73c991', '#e2b45c', '#e87979', '#65c9cc'];
const colorOf = (index) => COLORS[index % COLORS.length];
const dateOf = (commit) => commit.time ? new Date(commit.time).toLocaleString() : '';
const node = (tag, cls = '', text = '') => { const n = document.createElement(tag); n.className = cls; n.textContent = text; return n; };
const button = (text, action, cls = 'ide-button secondary') => { const b = node('button', cls, text); b.type = 'button'; b.addEventListener('click', action); return b; };

function laneSVG(row, columns) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const width = Math.max(32, columns * 16 + 16);
  svg.setAttribute('viewBox', `0 0 ${width} 32`);
  svg.setAttribute('width', width); svg.setAttribute('height', '32'); svg.setAttribute('aria-hidden', 'true');
  const x = (col) => 16 + col * 16;
  const path = (d, color) => {
    const p = document.createElementNS(svg.namespaceURI, 'path');
    p.setAttribute('d', d); p.setAttribute('stroke', colorOf(color)); p.setAttribute('stroke-width', '2'); p.setAttribute('fill', 'none'); svg.append(p);
  };
  row.before.forEach((lane, col) => { if (col !== row.column || row.incoming) path(`M${x(col)} 0V16`, lane.color); });
  for (const edge of row.edges) path(`M${x(edge.from)} 16C${x(edge.from)} 24 ${x(edge.to)} 24 ${x(edge.to)} 32`, edge.color);
  const circle = document.createElementNS(svg.namespaceURI, 'circle');
  circle.setAttribute('cx', x(row.column)); circle.setAttribute('cy', '16'); circle.setAttribute('r', row.commit.parents.length > 1 ? '5.5' : '4');
  circle.setAttribute('fill', colorOf(row.color)); circle.setAttribute('stroke', 'var(--ide-bg)'); circle.setAttribute('stroke-width', '1.5'); svg.append(circle);
  return svg;
}

export function mountGitGraph(view, { git, contextMenu, copy, openPatch, unborn = false, title = 'Repository', onError }) {
  let disposed = false, generation = 0, detailGeneration = 0, commits = [], selected = null, limit = 100, hasMore = false, all = true;
  const root = node('div', 'ide-git-graph');
  const toolbar = node('div', 'ide-git-toolbar');
  const heading = node('strong', '', title);
  const find = node('input', 'ide-input ide-git-find');
  find.placeholder = 'Find commits…'; find.setAttribute('aria-label', 'Find commits by message, author, branch or hash');
  const scope = node('select', 'ide-select'); scope.setAttribute('aria-label', 'History scope');
  for (const [value, label] of [['all', 'All branches'], ['current', 'Current branch']]) { const option = node('option', '', label); option.value = value; scope.append(option); }
  const refresh = button('Refresh', () => load());
  toolbar.append(heading, find, scope, refresh);
  const status = node('div', 'ide-git-status'); status.setAttribute('role', 'status');
  const body = node('div', 'ide-git-body');
  const history = node('div', 'ide-git-history');
  const list = node('div', 'ide-git-list'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', 'Commit graph'); list.tabIndex = 0;
  const more = button('Load more commits', () => { limit += 100; load(); }, 'ide-button secondary ide-git-more'); more.hidden = true;
  history.append(list, more);
  const details = node('section', 'ide-git-details'); details.setAttribute('aria-label', 'Commit details');
  details.append(node('p', 'ide-empty-note', 'Select a commit to see its message and changed files.'));
  body.append(history, details); root.append(toolbar, status, body); view.append(root);
  const report = (error) => { if (!disposed) onError?.(error); };
  const safe = (promise) => Promise.resolve(promise).catch(report);
  const matches = (c) => `${c.hash}\n${c.message}\n${c.author}\n${c.refs.join(' ')}`.toLowerCase().includes(find.value.trim().toLowerCase());

  async function load() {
    const version = ++generation;
    refresh.disabled = more.disabled = true; status.textContent = 'Loading commit graph…';
    try {
      const result = await git(['log', '--topo-order', '--decorate=short', '--format=raw', '--no-color', '-n', String(limit + 1), ...(all ? ['--all'] : [])], { anyCode: true });
      if (disposed || version !== generation) return;
      if (result.code !== 0 && !(unborn && /does not have any commits yet|bad default revision/i.test(result.err))) throw new Error(result.err || 'Could not load Git history.');
      const parsed = parseGitLog(result.out);
      hasMore = parsed.length > limit; commits = parsed.slice(0, limit);
      const previous = selected && commits.find((c) => c.hash === selected.hash);
      selected = previous || commits[0] || null;
      render();
      if (selected) safe(select(selected));
      else { detailGeneration++; details.replaceChildren(node('p', 'ide-empty-note', 'No commits yet. Write a message in Source Control to create the first commit.')); }
    } catch (error) {
      if (!disposed && version === generation) { status.textContent = error.message; report(error); }
    } finally { if (!disposed && version === generation) refresh.disabled = more.disabled = false; }
  }

  function render() {
    const top = list.scrollTop, focused = list.contains(document.activeElement);
    const graph = layoutGitGraph(commits);
    list.style.setProperty('--git-lanes', `${Math.max(32, graph.columns * 16 + 16)}px`);
    const query = find.value.trim();
    const count = commits.filter(matches).length;
    status.textContent = !commits.length ? 'No commits yet.' : `${commits.length} commits${hasMore ? ' loaded' : ''}${query ? ` · ${count} matches (Enter for next)` : ''}`;
    const rows = graph.rows.map((row) => {
      const c = row.commit;
      const b = button('', () => safe(select(c)), `ide-git-row${selected?.hash === c.hash ? ' on' : ''}${query && !matches(c) ? ' dim' : ''}`);
      b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(selected?.hash === c.hash)); b.tabIndex = selected?.hash === c.hash ? 0 : -1;
      b.title = `${c.subject}\n${c.author} · ${dateOf(c)}\n${c.hash}`;
      b.append(laneSVG(row, graph.columns));
      const summary = node('span', 'ide-git-summary');
      for (const ref of c.refs) summary.append(node('span', 'ide-git-ref', ref));
      summary.append(node('span', 'ide-git-subject', c.subject));
      b.append(summary, node('span', 'ide-git-author', c.author), node('span', 'ide-git-date', c.time ? new Date(c.time).toLocaleDateString() : ''), node('code', 'ide-git-hash', c.hash.slice(0, 8)));
      b.addEventListener('dblclick', () => safe(openPatch(c)));
      contextMenu(b, () => [{ label: 'Show Commit Details', run: () => select(c) }, { label: 'Open Commit Changes', run: () => openPatch(c) }, '-',
        { label: 'Copy Commit Hash', run: () => copy(c.hash) }, { label: 'Copy Commit Message', run: () => copy(c.message) }]);
      return b;
    });
    list.replaceChildren(...rows); list.scrollTop = top;
    if (focused) list.querySelector('.on')?.focus({ preventScroll: true });
    more.hidden = !hasMore;
  }

  async function parent(hash) {
    const existing = commits.find((c) => c.hash === hash);
    if (existing) return select(existing);
    const version = detailGeneration;
    const result = await git(['show', '--no-patch', '--format=raw', hash]);
    if (disposed || version !== detailGeneration) return;
    const c = parseGitLog(result.out)[0]; if (c) return select(c);
  }

  async function select(c) {
    if (disposed) return;
    selected = c;
    const version = ++detailGeneration;
    for (const [index, row] of [...list.children].entries()) {
      const active = commits[index]?.hash === c.hash;
      row.classList.toggle('on', active); row.setAttribute('aria-selected', String(active)); row.tabIndex = active ? 0 : -1;
    }
    const meta = node('div', 'ide-git-meta');
    const head = node('div', 'ide-git-detail-head');
    head.append(node('strong', '', 'Commit details'), button('Open Changes', () => safe(openPatch(c))));
    meta.append(head);
    const fields = node('dl', 'ide-git-fields');
    const field = (label, value) => { const dd = node('dd'); if (typeof value === 'string') dd.textContent = value; else dd.append(value); fields.append(node('dt', '', label), dd); };
    field('Commit', button(c.hash, () => safe(copy(c.hash)), 'ide-link ide-git-full-hash'));
    field('Author', `${c.author}${c.email ? ` <${c.email}>` : ''}`); field('Date', dateOf(c));
    if (c.committer !== c.author) field('Committer', c.committer);
    if (c.refs.length) field('Refs', c.refs.join(', '));
    if (c.parents.length) { const parents = node('span', 'ide-git-parents'); for (const hash of c.parents) parents.append(button(hash.slice(0, 8), () => safe(parent(hash)), 'ide-link')); field('Parents', parents); }
    meta.append(fields, node('pre', 'ide-git-message', c.message));
    const changes = node('div', 'ide-git-changes');
    const changedHeading = node('strong', '', 'Changed files');
    const note = node('p', 'ide-empty-note', 'Loading changed files…');
    changes.append(changedHeading);
    if (c.parents.length > 1) changes.append(node('p', 'ide-git-merge-note', 'Merge changes compared with the first parent.'));
    changes.append(note); details.replaceChildren(meta, changes);
    try {
      const args = c.parents.length ? ['diff', '--find-renames', c.parents[0], c.hash] : ['show', '--format=', '--find-renames', c.hash];
      const [statusResult, statResult] = await Promise.all([
        git([...args, '--name-status', '-z', '--']), git([...args, '--numstat', '-z', '--']),
      ]);
      if (disposed || version !== detailGeneration) return;
      const files = parseGitChanges(statusResult.out, statResult.out);
      note.remove(); changedHeading.textContent = `Changed files (${files.length})`;
      if (!files.length) changes.append(node('p', 'ide-empty-note', 'This commit has no file changes.'));
      for (const file of files) {
        const row = button('', () => safe(openPatch(c, file.path)), 'ide-git-file');
        row.title = file.from ? `${file.from} → ${file.path}` : file.path;
        const added = file.added === '-' ? 'binary' : file.added ? `+${file.added}` : '';
        const removed = file.removed && file.removed !== '-' ? `−${file.removed}` : '';
        row.append(node('span', 'ide-git-file-status', file.code), node('span', 'ide-git-file-path', file.path), node('span', 'ide-git-added', added), node('span', 'ide-git-removed', removed));
        contextMenu(row, () => [{ label: 'Open File Changes', run: () => openPatch(c, file.path) }, { label: 'Copy Path', run: () => copy(file.path) }, { label: 'Copy Commit Hash', run: () => copy(c.hash) }]);
        changes.append(row);
      }
    } catch (error) { if (!disposed && version === detailGeneration) note.textContent = error.message; }
  }

  find.addEventListener('input', render);
  find.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); find.value = ''; render(); }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const start = commits.findIndex((c) => c.hash === selected?.hash);
    for (let i = 1; i <= commits.length; i++) { const c = commits[(start + i) % commits.length]; if (matches(c)) { safe(select(c)); list.children[commits.indexOf(c)]?.scrollIntoView({ block: 'nearest' }); break; } }
  });
  list.addEventListener('keydown', (e) => {
    const step = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[e.key];
    if (step === undefined || !commits.length) return;
    e.preventDefault();
    const index = Math.max(0, Math.min(commits.length - 1, commits.findIndex((c) => c.hash === selected?.hash) + step));
    safe(select(commits[index])); list.children[index]?.focus();
  });
  scope.addEventListener('change', () => { all = scope.value === 'all'; limit = 100; safe(load()); });
  safe(load());
  return { refresh: () => safe(load()), dispose: () => { disposed = true; generation++; detailGeneration++; } };
}
