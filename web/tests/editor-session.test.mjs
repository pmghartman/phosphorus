import test from 'node:test';
import assert from 'node:assert/strict';
import { captureEditorSession, rememberEditorSession, restoredSelection } from '../src/sulfur/editor-session.js';

const keep = (t) => t.host ? { rel: t.rel, host: t.host, share: t.share } : t.rel;
test('folder sessions retain file order, location and selections without buffer contents or utility pages', () => {
  const tabs = [
    { rel: 'project/a.js', ed: { ready: () => true, selection: () => [4, 12], text: () => 'secret unsaved buffer' } },
    { kind: 'page', page: 'settings' },
    { rel: 'project/image.png', host: 'other', share: '2' },
    { rel: 'project/opening.js', pendingSel: [20, 20] },
  ];
  const session = captureEditorSession(tabs, tabs[2], keep);
  assert.deepEqual(session.tabs, [{ rel: 'project/a.js', selection: [4, 12] }, { rel: 'project/image.png', host: 'other', share: '2' }, { rel: 'project/opening.js', selection: [20, 20] }]);
  assert.deepEqual(session.active, { rel: 'project/image.png', host: 'other', share: '2' });
  assert.ok(!JSON.stringify(session).includes('secret'));
});

test('workspace history keeps machines and shares separate, limits old entries and remembers an explicitly empty session', () => {
  let sessions = {};
  for (let n = 0; n < 30; n++) sessions = rememberEditorSession(sessions, `host:${n}\nproject`, { tabs: [n] });
  assert.equal(Object.keys(sessions).length, 24);
  assert.equal(sessions['host:0\nproject'], undefined);
  sessions = rememberEditorSession(sessions, 'host:20\nproject', { tabs: [], active: '' });
  assert.equal(Object.keys(sessions)[0], 'host:20\nproject');
  assert.deepEqual(sessions['host:20\nproject'].tabs, []);
  assert.deepEqual(sessions['host:21\nproject'].tabs, [21]);
});

test('persisted cursor positions are validated before passing them to the editor', () => {
  assert.deepEqual(restoredSelection({ selection: [0, 80] }), [0, 80]);
  for (const selection of [null, '1,2', [1], [-1, 2], [1, Infinity], [1.5, 4], ['0', 1]]) assert.equal(restoredSelection({ selection }), undefined);
});
