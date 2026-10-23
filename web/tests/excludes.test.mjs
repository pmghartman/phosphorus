import test from 'node:test';
import assert from 'node:assert/strict';
import { excludeMatcher } from '../src/sulfur/excludes.js';

test('names, globs and the default list', () => {
  const x = excludeMatcher('.git, node_modules, __pycache__, .DS_Store, *.o');
  assert.ok(x('.git', true) && x('node_modules', true) && x('.DS_Store') && x('main.o'));
  assert.ok(!x('src', true) && !x('main.c') && !x('git'));
  // a bare repository folder is a folder, not a .git file
  assert.ok(!x('project.git', true));
});

test('a dotted extension hides files ending in it, as people write it', () => {
  const x = excludeMatcher('.meta');
  assert.ok(x('CombatManager.cs.meta') && x('.meta') && x('scenes.meta'));
  assert.ok(!x('CombatManager.cs') && !x('assets.meta', true) && !x('metadata'));
});

test("VS Code's forms: **/, trailing slashes, braces, paths", () => {
  const x = excludeMatcher('**/*.meta, out/, **/bin/**, *.{png,jpg}, build/cache');
  assert.ok(x('a.cs.meta') && x('out', true) && !x('out') && x('bin', true) && x('icon.png') && x('photo.jpg'));
  assert.ok(x.path('src/out/a.js') && x.path('build/cache/x') && x.path('deep/build/cache'));
  assert.ok(!x.path('src/output/a.js') && !x.path('build/cached') && !x.path('src/main.cs'));
  assert.ok(x.path('scripts/core/Registry.cs.meta'));
  assert.ok(!excludeMatcher('').path('anything') && !excludeMatcher(' , ').path('a'));
});
