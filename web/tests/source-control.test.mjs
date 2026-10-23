import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitStatus, explorerChanges } from '../src/sulfur/source-control.js';

test('Git porcelain paths retain spaces/newlines and rename sources do not become extra entries', () => {
  const status = parseGitStatus('## main...origin/main [ahead 2, behind 1]\0 M scripts/a file.cs\0R  scripts/New.cs\0scripts/Old.cs\0 R scripts/Renamed.cs\0scripts/Before.cs\0?? scripts/a\nline.cs\0UU conflict.cs\0!! ignored.cs\0');
  assert.equal(status.branch, 'main'); assert.equal(status.upstream, 'origin/main');
  assert.equal(status.ahead, 2); assert.equal(status.behind, 1);
  assert.equal(status.staged[0].from, 'scripts/Old.cs');
  assert.equal(status.changes.find((x) => x.path === 'scripts/Renamed.cs').from, 'scripts/Before.cs');
  assert.ok(status.changes.some((x) => x.path === 'scripts/a\nline.cs' && x.untracked));
  assert.ok(status.changes.some((x) => x.path === 'conflict.cs' && x.conflict));
  assert.equal(status.staged.length + status.changes.length, 5);
});

test('Explorer decorations combine staging states, aggregate folders and prioritize conflicts', () => {
  const parsed = parseGitStatus('## main\0AM src/Player.cs\0?? src/New.cs\0 D src/Deleted.cs\0UU src/Conflict.cs\0');
  const changes = explorerChanges({ ...parsed, top: '/repo' }, 'tester/game');
  const player = changes.files.get('tester/game/src/Player.cs');
  assert.equal(player.code, 'M'); assert.equal(player.staged, true); assert.equal(player.unstaged, true);
  assert.equal(changes.files.get('tester/game/src/New.cs').color, 'untracked');
  assert.equal(changes.folders.get('tester/game/src').color, 'conflict');
  assert.equal(changes.folders.get('tester/game').count, 4);
  assert.match(changes.folders.get('tester/game/src').title, /deleted/);
  assert.equal(changes.files.has('tester/game/clean.cs'), false);
});

test('a workspace inside a repository only decorates paths beneath its prefix and clears clean/non-repositories', () => {
  const state = { top: '/repo', prefix: 'games/stellar/', staged: [], changes: [{ path: 'games/stellar/Player.cs', code: 'M' }, { path: 'games/stellar-other/Else.cs', code: 'M' }, { path: 'games/stellar/../outside.cs', code: 'M' }] };
  const changes = explorerChanges(state, 'user/workspace');
  assert.deepEqual([...changes.files.keys()], ['user/workspace/Player.cs']);
  assert.equal(explorerChanges({ ...state, top: '' }, 'user/workspace').files.size, 0);
  assert.equal(explorerChanges({ ...state, changes: [] }, 'user/workspace').folders.size, 0);
});

test('renames decorate both parent folders, count once in common ancestors, and include moves out of the workspace', () => {
  const state = { top: '/repo', prefix: 'game/', staged: [{ path: 'game/new/Player.cs', from: 'game/old/Player.cs', code: 'R' }], changes: [] };
  const changes = explorerChanges(state, 'user/game');
  assert.equal(changes.folders.get('user/game/new').color, 'renamed');
  assert.equal(changes.folders.get('user/game/old').color, 'renamed');
  assert.equal(changes.folders.get('user/game').count, 1);
  assert.equal(changes.files.has('user/game/old/Player.cs'), false);
  state.staged[0].path = 'outside/Player.cs';
  const moved = explorerChanges(state, 'user/game');
  assert.equal(moved.files.size, 0);
  assert.equal(moved.folders.get('user/game/old').count, 1);
});
