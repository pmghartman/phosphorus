import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatches, literalSearch } from '../src/sulfur/search.js';

test('case and whole-word constraints apply to the same occurrence', () => {
  const re = literalSearch('foo', { caseSensitive: true, wholeWord: true });
  assert.deepEqual(findMatches('FOO food', re), []);
  assert.deepEqual(findMatches('FOO food foo', re), [[9, 12]]);
  assert.deepEqual(findMatches('foofoo foo', re), [[7, 10]]);
});

test('whole-word search respects Unicode letters, combining marks and UTF-16 offsets', () => {
  const re = literalSearch('cat', { wholeWord: true });
  assert.deepEqual(findMatches('écat caté cat\u0301 cat_cat cat2 😀cat CAT', re), [[30, 33], [34, 37]]);
  assert.deepEqual(findMatches('a+b aab A+B', literalSearch('a+b')), [[0, 3], [8, 11]]);
});

test('selection searches preserve regex context and never accept a match crossing the boundary', () => {
  assert.deepEqual(findMatches('cat cat\ncat', /^cat/gm, { from: 4 }), [[8, 11]]);
  assert.deepEqual(findMatches('foo cat end', /(?<=foo )cat/g, { from: 4, to: 7 }), [[4, 7]]);
  assert.deepEqual(findMatches('abc abc', /abc/g, { from: 0, to: 2 }), []);
});

test('zero-width searches stop at the selection boundary without scanning the remaining file', () => {
  const re = /(?:)/gu;
  let calls = 0;
  const exec = re.exec.bind(re);
  re.exec = (text) => { calls++; return exec(text); };
  assert.deepEqual(findMatches('😀abc' + 'x'.repeat(100000), re, { to: 5 }), []);
  assert.equal(calls, 5);
});

test('match limits bound highlighting and the same regex starts fresh for each line', () => {
  const re = literalSearch('a');
  assert.deepEqual(findMatches('aaaa', re, { limit: 2 }), [[0, 1], [1, 2]]);
  assert.deepEqual(findMatches('a', re), [[0, 1]]);
  assert.deepEqual(findMatches('', re), []);
});
