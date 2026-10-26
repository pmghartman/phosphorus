import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { captureEditorSession, rememberEditorSession, restoredSelection } from '../src/sulfur/editor-session.js';

// Execute the actual workbench lifecycle functions with file/UI boundaries stubbed.
const source = readFileSync(new URL('../src/sulfur/workbench.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const HOME = { home: true };
const locKey = (loc) => loc.host ? `${loc.host}:${loc.share}` : '*';
function fixture({ answer = 'drop', saved = true, restore = true } = {}) {
  const calls = [], stored = new Map();
  const state = { st: { root: 'a', loc: HOME, workspaces: {} }, tabs: [], active: null, closed: [], scmMsg: 'Draft A' };
  const context = {
    I: state, captureEditorSession, rememberEditorSession, restoredSelection,
    cleanPath: (p) => p, inScope: () => true, locOf: () => state.st.loc, sameLoc: (a, b) => locKey(a) === locKey(b),
    wsKey: () => `${locKey(state.st.loc)}\n${state.st.root}`, HOME_LOC: HOME,
    tabKept: (t) => t.loc?.host ? { rel: t.rel, host: t.loc.host, share: t.loc.share } : t.rel,
    keptLoc: (x) => typeof x === 'string' ? { rel: x, loc: HOME } : { rel: x.rel, loc: x.host ? { host: x.host, share: x.share } : HOME },
    setting: () => restore, ask: async () => typeof answer === 'function' ? answer() : answer,
    saveTab: async (tab) => { calls.push('save'); if (saved) tab.dirty = false; return saved; },
    closeTab: async (t) => { calls.push(`close:${t.rel}`); state.tabs.splice(state.tabs.indexOf(t), 1); state.active = null; },
    openFile: (rel, options) => { const tab = { rel, loc: options.loc, pendingSel: options.select }; state.tabs.push(tab); state.active ||= tab; calls.push(`open:${rel}`); return tab; },
    activate: (tab) => { state.active = tab; },
    applyRoot: (root, loc) => { calls.push(`root:${root}`); state.st.root = root; state.st.loc = loc; state.scmMsg = state.st.workspaces[context.wsKey()]?.commitMessage || ''; },
    paintChat() {}, paintNav() {}, paintEditors() {}, focusActive() {}, refreshTree() {}, saveState() {}, notify() {},
    localStorage: { setItem: (key, value) => stored.set(key, JSON.parse(value)) }, STATE_KEY: () => 'test',
  };
  vm.createContext(context);
  vm.runInContext(section('function persistState()', 'const saveState =') + section('function restoreEditors(', '// --- start and stop') + section('async function setRoot(', 'function applyRoot(') + section('async function confirmCloseTabs(', 'async function closeMany('), context);
  const add = (rel, dirty = false, selection = [1, 3]) => {
    const tab = { rel, loc: state.st.loc, dirty, title: rel, ed: { dirty: () => tab.dirty, ready: () => true, selection: () => selection } };
    state.tabs.push(tab); state.active = tab; return tab;
  };
  return { state, context, calls, stored, add };
}

test('switching folders closes old tabs and restores the destination order, active file, cursor and draft', async () => {
  const f = fixture(); f.add('a/one'); f.add('a/two');
  const loc = { host: 'remote', share: '3' }, key = 'remote:3\nb';
  f.state.st.workspaces[key] = { tabs: [{ rel: 'b/one', ...loc, selection: [8, 12] }, { rel: 'b/two', ...loc }], active: { rel: 'b/one', ...loc }, commitMessage: 'Draft B', closed: [{ rel: 'b/closed', ...loc }] };
  assert.equal(await f.context.setRoot('b', false, loc), true);
  assert.deepEqual(f.calls.filter((c) => /^(close|root|open):/.test(c)), ['close:a/one', 'close:a/two', 'root:b', 'open:b/one', 'open:b/two']);
  assert.equal(f.state.active.rel, 'b/one'); assert.deepEqual(f.state.active.pendingSel, [8, 12]);
  assert.equal(f.state.scmMsg, 'Draft B');
  const previous = f.state.st.workspaces['*\na'];
  assert.equal(previous.tabs.length, 2); assert.equal(previous.active, 'a/two'); assert.equal(previous.commitMessage, 'Draft A');
  assert.equal(f.stored.get('test').active.rel, 'b/one');
});

test('cancelling or failing a save leaves every tab and the original folder intact', async () => {
  for (const options of [{ answer: '' }, { answer: 'save', saved: false }]) {
    const f = fixture(options); const clean = f.add('a/clean'), dirty = f.add('a/dirty', true);
    assert.equal(await f.context.setRoot('b', false, HOME), false);
    assert.deepEqual(f.state.tabs, [clean, dirty]); assert.equal(f.state.st.root, 'a'); assert.equal(f.state.active, dirty);
    assert.equal(f.state.switchingWorkspace, false); assert.ok(!f.calls.some((c) => c.startsWith('close:')));
  }
});

test('a second folder switch cannot race a pending unsaved-changes decision', async () => {
  let resolve;
  const f = fixture({ answer: () => new Promise((r) => { resolve = r; }) }); f.add('a/dirty', true);
  const first = f.context.setRoot('b', false, HOME);
  assert.equal(await f.context.setRoot('c', false, HOME), false);
  assert.equal(f.state.st.root, 'a'); resolve('drop'); await first;
  assert.equal(f.state.st.root, 'b');
});

test('saved folders with no open files stay empty and restoration can be disabled', async () => {
  for (const restore of [true, false]) {
    const f = fixture({ restore }); f.add('a/file');
    f.state.st.workspaces['*\nb'] = { tabs: restore ? [] : [{ rel: 'b/file' }], active: '' };
    await f.context.setRoot('b', false, HOME);
    assert.equal(f.state.tabs.length, 0);
  }
});
