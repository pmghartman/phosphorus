import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/sulfur/workbench.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function copyEntry('), source.indexOf('// --- making, renaming, deleting, moving'));
function fixture({ clipboard, entries = [], listing = {}, save = true, moved = true } = {}) {
  const calls = [], notes = [], loc = { host: 'target', share: '1' };
  const state = { fileClipboard: clipboard, st: { root: 'project', loc }, tabs: [] };
  const context = {
    I: state, wsKey: () => 'target:1\nproject', locOf: () => loc,
    sameLoc: (a, b) => a.host === b.host && a.share === b.share,
    under: (p, d) => p === d || p.startsWith(d + '/'), baseName: (p) => p.split('/').pop(), filesJoin: (a, b) => `${a}/${b}`,
    isHomeLoc: (l) => !l.host, homePick: () => 'default', homeAt: (host) => ({ host, share: 'home' }),
    apiLoc: (l) => l, fileLoc: (p, host, l) => l.host ? l : { host, share: 'home' }, holdersOf: async () => ['holder'],
    loadDir: async () => entries, renameEntry: async (...args) => { calls.push(['rename', ...args]); return moved; },
    copyFile: async (...args) => calls.push(['copy', ...args.slice(0, 4)]),
    filesCall: async (at, op, body, query) => { calls.push([op, at, body, query]); return { entries: listing[query?.path] || [] }; },
    jsonPost: (body) => body, saveTab: async () => save,
    notify: (type, message) => { notes.push([type, message]); return { close() {} }; },
    selectRow: (p) => calls.push(['select', p]), setStatusFlash() {}, paintTreeSoon() {},
  };
  vm.createContext(context); vm.runInContext(code, context);
  return { context, state, calls, notes, loc };
}

test('copying a file preserves an existing destination and selects a free copy name', async () => {
  const f = fixture({ clipboard: { path: 'project/a.txt', loc: { host: 'target', share: '1' } }, entries: [{ name: 'a.txt' }, { name: 'a copy.txt' }] });
  await f.context.pasteEntry('project');
  const copy = f.calls.find(([op]) => op === 'copy');
  assert.equal(copy[2], 'project/a.txt'); assert.equal(copy[4], 'project/a copy 2.txt');
  assert.equal(f.state.filePaste, false);
});

test('cut refuses collisions and cross-location moves, clearing the clipboard only on success', async () => {
  for (const collision of [true, false]) {
    const f = fixture({ clipboard: { path: 'old/a.txt', loc: { host: 'target', share: '1' }, cut: true }, entries: collision ? [{ name: 'a.txt' }] : [] });
    await f.context.pasteEntry('project');
    assert.equal(f.calls.some(([op]) => op === 'rename'), !collision);
    assert.equal(f.state.fileClipboard === null, !collision);
  }
  const f = fixture({ clipboard: { path: 'old/a.txt', loc: { host: 'other', share: '1' }, cut: true } });
  await f.context.pasteEntry('project'); assert.equal(f.calls.length, 0);
});

test('folder paste rejects recursion and copies nested files using the source and destination locations', async () => {
  const bad = fixture({ clipboard: { path: 'project/folder', loc: { host: 'target', share: '1' }, directory: true } });
  await bad.context.pasteEntry('project/folder/child'); assert.equal(bad.calls.length, 0);
  const f = fixture({ clipboard: { path: 'source/folder', loc: {}, directory: true }, listing: { 'source/folder': [{ name: 'nested', dir: true }], 'source/folder/nested': [{ name: 'file.txt', dir: false }] } });
  await f.context.pasteEntry('project');
  const copy = f.calls.find(([op]) => op === 'copy');
  assert.equal(copy[1].host, 'holder'); assert.equal(copy[3].host, 'target');
  assert.equal(copy[2], 'source/folder/nested/file.txt'); assert.equal(copy[4], 'project/folder/nested/file.txt');
  assert.equal(f.calls.filter(([op]) => op === 'mkdir').length, 2);
});

test('copying an open dirty file stops when saving fails', async () => {
  const f = fixture({ clipboard: { path: 'old/a.txt', loc: { host: 'target', share: '1' } }, save: false });
  f.state.tabs.push({ rel: 'old/a.txt', loc: f.loc, ed: { dirty: () => true } });
  await f.context.pasteEntry('project');
  assert.equal(f.calls.some(([op]) => op === 'copy'), false); assert.equal(f.state.filePaste, false);
});
