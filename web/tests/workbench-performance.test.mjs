import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { findMatches, literalSearch } from '../src/sulfur/search.js';
import { excludeMatcher } from '../src/sulfur/excludes.js';

const source = readFileSync(new URL('../src/sulfur/workbench.js', import.meta.url), 'utf8');
function functions(...names) {
  return names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    return (source.slice(start - 6, start) === 'async ' ? 'async ' : '') + source.slice(start, source.indexOf('\n}', start) + 2);
  }).join('\n');
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const plain = (value) => JSON.parse(JSON.stringify(value));

function ui() {
  const nodes = [];
  const doc = { activeElement: null, getElementById: (id) => nodes.find((n) => n.id === id) };
  const el = (tag = 'div', className = '', textContent = '') => {
    const classes = new Set(className.split(' ')), listeners = new Map();
    const node = { tag, className, textContent, value: '', dataset: {}, style: {}, attrs: {}, children: [],
      clientHeight: 200, offsetTop: 0, offsetHeight: 24, scrollTop: 0, scrollHeight: 1200, isConnected: true,
      classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), contains: (name) => classes.has(name), toggle(name, on) { if (on ?? !classes.has(name)) classes.add(name); else classes.delete(name); } },
      append(...items) { node.children.push(...items); }, replaceChildren(...items) { node.children = items; },
      setAttribute: (name, value) => { node.attrs[name] = value; },
      addEventListener: (type, fn) => { const list = listeners.get(type) || []; list.push(fn); listeners.set(type, list); },
      emit(type, props = {}) { const event = { key: '', preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...props }; for (const fn of listeners.get(type) || []) fn(event); return event; },
      focus() { doc.activeElement = node; }, select() {}, setSelectionRange() {}, contains: (n) => n === node, remove() { node.isConnected = false; },
    };
    nodes.push(node); return node;
  };
  doc.createElement = el;
  doc.head = el();
  return { el, nodes, document: doc };
}

test('late file indexes cannot replace another workspace or clear its in-flight request', async () => {
  const requests = [];
  const context = { I: { st: { root: 'a' } }, INDEX_TTL: 30000, Date,
    wsKey: () => context.I.st.root, isHomeLoc: () => true, homeOnline: () => ['local'], homeAt: () => ({}),
    searchSkip: () => '', excluded: () => ({ path: () => false }),
    filesCall: () => { const request = deferred(); requests.push(request); return request.promise; } };
  vm.createContext(context); vm.runInContext(functions('fileIndex'), context);
  const a = context.fileIndex();
  context.I.st.root = 'b';
  const b = context.fileIndex();
  const latest = context.I.indexing;
  requests[0].resolve({ entries: [{ path: 'a/old.js' }] }); await a;
  assert.equal(context.I.index, undefined);
  assert.equal(context.I.indexing, latest);
  requests[1].resolve({ entries: [{ path: 'b/new.js' }] }); await b;
  assert.equal(context.I.index.root, 'b');
  assert.equal(context.I.index.files[0].path, 'b/new.js');
});

test('file index completion after closing the workbench is harmless', async () => {
  const request = deferred();
  const context = { I: { st: { root: 'a' } }, INDEX_TTL: 30000, Date,
    wsKey: () => context.I.st.root, isHomeLoc: () => true, homeOnline: () => ['local'], homeAt: () => ({}),
    searchSkip: () => '', excluded: () => ({ path: () => false }), filesCall: () => request.promise };
  vm.createContext(context); vm.runInContext(functions('fileIndex'), context);
  const pending = context.fileIndex(); context.I = null;
  request.resolve({ entries: [] }); await pending;
  assert.equal(context.I, null);
});

for (const kind of ['color', 'icons']) test(`${kind} themes ignore stale same-key loads and loads from a closed workbench`, async () => {
  const u = ui(), requests = [], warnings = [];
  const theme = { key: 'a', label: 'A', data: () => { const request = deferred(); requests.push(request); return request.promise; } };
  const state = () => ({ w: { node: u.el() }, tabs: [] });
  const context = { ...u, I: state(), contributedThemes: () => [theme], contributedIconThemes: () => [theme],
    themeCss: (data) => data.css, iconFontCss: (data) => data.css, iconFamily: () => 'icons',
    notify: (...args) => warnings.push(args), repaintIcons() {}, requestAnimationFrame() {} };
  vm.createContext(context); vm.runInContext(functions('wearExtTheme', 'wearIconTheme'), context);
  const wear = context[kind === 'color' ? 'wearExtTheme' : 'wearIconTheme'];
  const first = wear('a'); await wear(''); const last = wear('a');
  requests[1].resolve({ css: 'latest' }); await last;
  requests[0].resolve({ css: 'stale' }); await first;
  const tag = u.document.getElementById(kind === 'color' ? 'sulfur-ext-theme' : 'sulfur-ext-icons');
  assert.equal(tag.textContent, 'latest');
  const closed = wear('a'); context.I = state();
  requests[2].reject(new Error('old host disconnected')); await closed;
  assert.equal(tag.textContent, 'latest');
  assert.equal(warnings.length, 0);
});

function quickFixture(provide) {
  const u = ui();
  const context = { ...u, I: { seq: 0, layer: u.el(), root: u.el() }, IC: {}, setTimeout, icon: () => u.el(), fileIcon: () => u.el(), hlText: (text) => text };
  vm.createContext(context); vm.runInContext(functions('quick', 'closeQuick'), context);
  context.quick({ title: 'Choose a theme', provide });
  return context;
}

test('quick pick renders an initial page and can navigate beyond option 500 with accurate ARIA selection', () => {
  let accepted = -1;
  const items = Array.from({ length: 620 }, (_, i) => ({ label: String(i), accept: () => { accepted = i; } }));
  const context = quickFixture(() => ({ items }));
  const q = context.I.quick;
  assert.equal(q.list.children.length, 40);
  assert.equal(q.input.attrs['aria-label'], 'Choose a theme');
  for (let i = 0; i < 51; i++) q.input.emit('keydown', { key: 'PageDown' });
  assert.equal(q.at, 510);
  assert.equal(q.list.children[510].attrs['aria-selected'], 'true');
  assert.equal(q.list.children[0].attrs['aria-selected'], 'false');
  q.input.emit('keydown', { key: 'Enter', isComposing: true });
  assert.equal(accepted, -1);
  q.input.emit('keydown', { key: 'Enter' });
  assert.equal(accepted, 510);
});

test('a selected option beyond 500 is visible and failed async picker results are announced', async () => {
  const context = quickFixture(() => ({ items: Array.from({ length: 620 }, (_, i) => ({ label: String(i) })), at: 590 }));
  assert.ok(context.I.quick.list.children[590].classList.contains('on'));
  const wait = deferred();
  context.quick({ provide: () => ({ items: [], wait: wait.promise }) });
  const q = context.I.quick;
  assert.equal(q.list.attrs['aria-busy'], 'true');
  wait.reject(new Error('offline')); await Promise.resolve();
  assert.match(q.msg.textContent, /offline/);
  assert.equal(q.list.attrs['aria-busy'], 'false');
});

function searchFixture() {
  const u = ui(), requests = [], pending = new Set();
  const state = { st: { root: 'project' }, sideViews: new Map([['search', { body: u.el() }]]), offs: [] };
  const context = { ...u, I: state, AbortController, findMatches, literalSearch, excludeMatcher,
    debounce: (fn) => { const run = () => pending.add(fn); run.cancel = () => pending.delete(fn); return run; },
    btn: () => u.el('button'), icon: () => u.el(), fileIcon: () => u.el(), contextActions() {}, hlText: (text) => text,
    wsKey: () => state.st.root, isHomeLoc: () => true, homeOnline: () => ['local'], homeAt: () => ({}), searchSkip: () => '',
    excluded: () => ({ path: () => false }), under: () => false, baseName: (p) => p.split('/').at(-1), filesParent: () => '',
    filesCall: (at, op, init, params) => { const request = deferred(); requests.push({ ...request, init, params }); return request.promise; } };
  vm.createContext(context); vm.runInContext(functions('buildSearch'), context); context.buildSearch();
  return { context, state, requests, nodes: u.nodes, flush: async () => { const tasks = [...pending]; pending.clear(); await Promise.all(tasks.map((fn) => fn())); } };
}

test('typing cancels active workspace searches immediately, before the debounce expires', async () => {
  const h = searchFixture(), search = h.state.search;
  search.q.value = 'old'; const old = search.refresh();
  search.q.value = 'new'; search.q.emit('input');
  assert.equal(h.requests[0].init.signal.aborted, true);
  h.requests[0].resolve({ results: [{ path: 'project/old.js', matches: [{ text: 'old', line: 1 }] }] }); await old;
  assert.equal(search.S.results.length, 0);
  const latest = h.flush();
  h.requests[1].resolve({ results: [{ path: 'project/new.js', matches: [{ text: 'new', line: 1 }] }] }); await latest;
  assert.equal(search.S.query, 'new');
  assert.equal(search.S.results[0].path, 'project/new.js');
  assert.equal(search.list.attrs['aria-busy'], 'false');
  const third = search.refresh(); for (const off of h.state.offs) off();
  assert.equal(h.requests[2].init.signal.aborted, true);
  h.requests[2].resolve({ results: [] }); await third;
  assert.equal(search.S.results[0].path, 'project/new.js');
});

test('workspace search includes every requested glob and reports unavailable hosts', async () => {
  const h = searchFixture(), search = h.state.search;
  h.nodes.find((n) => n.attrs['aria-label'] === 'Files to include').value = '*.js, *.ts';
  search.q.value = 'foo';
  const result = search.refresh();
  assert.equal(h.requests[0].params.glob, undefined);
  h.requests[0].resolve({ results: ['a.js', 'b.ts', 'c.css'].map((name) => ({ path: `project/${name}`, matches: [{ text: 'foo', line: 1 }] })) }); await result;
  assert.deepEqual(plain(search.S.results.map((r) => r.path)), ['project/a.js', 'project/b.ts']);
  const header = search.list.children[0];
  assert.equal(header.tabIndex, 0);
  assert.equal(header.emit('keydown', { key: ' ' }).defaultPrevented, true);
  assert.equal(search.list.children[0].attrs['aria-expanded'], 'false');
  const failed = search.refresh(); h.requests[1].reject(new Error('offline')); await failed;
  assert.match(h.nodes.find((n) => n.className === 'ide-search-summary').textContent, /Search failed/);
});
