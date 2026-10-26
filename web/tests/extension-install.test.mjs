import test from 'node:test';
import assert from 'node:assert/strict';
import { installConvertedExtension } from '../src/sulfur/extension-install.js';

const conversion = () => ({ files: { 'package.json': '{}', 'vscode/main.js': 'main', 'vscode/style.css': 'style' }, binary: { 'vscode/view.wasm': btoa('\0asm') } });
function harness(overrides = {}) {
  const events = [], writes = new Map();
  return { events, writes, options: {
    directory: 'extensions/pub.ext', staging: '.staging', backup: '.backup', existing: true,
    write: async (path, data) => { writes.set(path, data); events.push(['write', path]); },
    rename: async (a, b) => { events.push(['rename', a, b]); },
    remove: async (path) => { events.push(['remove', path]); },
    beforeCommit: () => { events.push(['stop']); }, ...overrides,
  } };
}

test('binary and text files finish before replacement and the backup is removed after commit', async () => {
  const h = harness();
  await installConvertedExtension(conversion(), h.options);
  assert.deepEqual([...h.writes.get('.staging/vscode/view.wasm')], [0, 97, 115, 109]);
  assert.deepEqual(h.events.slice(-4), [['stop'], ['rename', 'extensions/pub.ext', '.backup'], ['rename', '.staging', 'extensions/pub.ext'], ['remove', '.backup']]);
});

test('failed uploads settle before staging cleanup and leave the installed extension running', async () => {
  let running = 0, maximum = 0, settled = 0, removedAt;
  const h = harness({ concurrency: 2,
    write: async (path) => { running++; maximum = Math.max(maximum, running); await new Promise(setImmediate); running--; settled++; if (path.endsWith('main.js')) throw new Error('offline'); },
    remove: async () => { removedAt = running; },
  });
  await assert.rejects(installConvertedExtension(conversion(), h.options), /offline/);
  assert.equal(maximum, 2); assert.equal(removedAt, 0); assert.ok(settled >= 2);
  assert.equal(h.events.length, 0);
});

test('failed directory replacement restores the old extension', async () => {
  const h = harness();
  h.options.rename = async (a, b) => { h.events.push(['rename', a, b]); if (a === '.staging') throw new Error('rename failed'); };
  await assert.rejects(installConvertedExtension(conversion(), h.options), /rename failed/);
  assert.deepEqual(h.events.slice(-3), [['rename', '.staging', 'extensions/pub.ext'], ['rename', '.backup', 'extensions/pub.ext'], ['remove', '.staging']]);
  assert.equal(h.events.some((e) => e[0] === 'remove' && e[1] === '.backup'), false);
});

test('a failed restore preserves the backup and identifies its recovery path', async () => {
  const h = harness({ rename: async (from) => { if (from !== 'extensions/pub.ext') throw new Error('denied'); } });
  await assert.rejects(installConvertedExtension(conversion(), h.options), /Previous files remain at .backup/);
  assert.equal(h.events.some((e) => e[0] === 'remove' && e[1] === '.backup'), false);
});

test('unsafe and colliding paths are rejected before any writes', async () => {
  for (const path of ['../escape', '/absolute', 'vscode/../../escape', 'C:/escape', 'vscode\\escape', 'vscode//main.js', 'PACKAGE.JSON']) {
    const h = harness(), conv = conversion(); conv.files[path] = 'bad';
    await assert.rejects(installConvertedExtension(conv, h.options), /Invalid|Duplicate/);
    assert.equal(h.events.length, 0);
  }
});

test('successful installs tolerate leftover backup cleanup and new installs do not rename old folders', async () => {
  const h = harness({ existing: false });
  await installConvertedExtension(conversion(), h.options);
  assert.deepEqual(h.events.at(-1), ['rename', '.staging', 'extensions/pub.ext']);
  const withBackup = harness({ remove: async () => { throw new Error('busy'); } });
  await installConvertedExtension(conversion(), withBackup.options);
});
