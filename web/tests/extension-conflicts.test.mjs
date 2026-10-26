import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionConflicts, createExtensionConflictIndex } from '../src/sulfur/extension-conflicts.js';

const extension = (id, contributes = {}, extra = {}) => ({ id, active: true, manifest: { contributes }, ...extra });

test('native SQLite overlaps are reported while optional editor alternatives coexist', () => {
  const viewer = extension('pub.viewer', { customEditors: [{ viewType: 'viewer', filenamePatterns: ['**/*.db'] }] });
  const conflicts = extensionConflicts([viewer]).get(viewer.id);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].other, 'sulfur.sqlite');
  assert.equal(conflicts[0].native, true);
  viewer.manifest.contributes.customEditors[0].priority = 'option';
  assert.equal(extensionConflicts([viewer]).get(viewer.id).length, 0);
});

test('commands, keys, runners, views and server overlaps identify both owners', () => {
  const contributes = (command, lang) => ({ commands: [{ command: 'duplicate' }], keybindings: [{ key: 'shift+ctrl+k', mac: 'shift+cmd+k', command }],
    runners: { '.py': command }, views: [{ id: 'same.view' }], languageServers: [{ extensions: ['py'] }], languages: [{ id: lang, extensions: ['.demo'] }] });
  const a = extension('a', contributes('a.run', 'first')), b = extension('b', contributes('b.run', 'second'));
  const issues = extensionConflicts([a, b], { mac: true });
  assert.deepEqual(issues.get('a').map((x) => x.kind).sort(), ['command', 'keybinding', 'runner', 'view', 'language server', 'language association'].sort());
  assert.ok(issues.get('a').every((x) => x.other === 'b'));
  assert.ok(issues.get('b').every((x) => x.other === 'a'));
  b.active = false;
  assert.equal(extensionConflicts([a, b]).get('a').length, 0);
});

test('dependency identities are case insensitive and distinguish missing from disabled', () => {
  const a = extension('a');
  a.manifest.extensionDependencies = ['PUB.B', 'missing', 'sulfur.sqlite'];
  const b = extension('pub.b', {}, { active: false });
  const issues = extensionConflicts([a, b]).get('a');
  assert.equal(issues.length, 2);
  assert.match(issues[0].detail, /disabled/);
  assert.match(issues[1].detail, /not installed/);
  b.active = true;
  assert.equal(extensionConflicts([a, b]).get('a').length, 1);
});

test('preview reuses an index without registering other candidates as installed', () => {
  const index = createExtensionConflictIndex([], { commands: [{ id: 'native.run', key: 'ctrl+k', alt: [] }] });
  const a = extension('a', { commands: [{ command: 'native.run' }], keybindings: [{ command: 'a.run', key: 'ctrl+k' }] });
  assert.equal(index.inspect(a).length, 2);
  assert.equal(index.inspect(extension('b', { commands: [{ command: 'a.run' }] })).length, 0);
  assert.equal(index.inspect(a).length, 2);
  assert.equal(index.issues.get('sulfur:core').length, 0);
});

test('shared language identities and identical key commands are not conflicts', () => {
  const c = { languages: [{ id: 'python', extensions: ['.py'] }], keybindings: [{ key: 'ctrl+shift+k', command: 'same' }] };
  assert.equal(extensionConflicts([extension('a', c), extension('b', c)]).get('a').length, 0);
});
