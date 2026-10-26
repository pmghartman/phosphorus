import test from 'node:test';
import assert from 'node:assert/strict';
import { topRanked } from '../src/sulfur/ranked.js';

test('bounded ranking agrees with a stable full sort across ties and workspace sizes', () => {
  let seed = 1024;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % 200);
  const compare = (a, b) => b.score - a.score || a.length - b.length;
  for (const size of [0, 1, 40, 201, 10000]) {
    const entries = Array.from({ length: size }, (_, id) => ({ id, score: random(), length: random() }));
    for (const limit of [0, 1, 40, 200, size + 1]) {
      assert.deepEqual(topRanked(entries.values(), limit, compare), [...entries].sort(compare).slice(0, limit));
    }
  }
});

test('large quick-open indexes discard low-ranked entries without sorting the entire index', () => {
  const entries = Array.from({ length: 50000 }, (_, id) => ({ id, score: (Math.imul(id, 2654435761) >>> 0) }));
  let comparisons = 0;
  const result = topRanked(entries, 200, (a, b) => { comparisons++; return b.score - a.score; });
  assert.deepEqual(result, [...entries].sort((a, b) => b.score - a.score).slice(0, 200));
  assert.ok(comparisons < 100000, `${comparisons} comparisons for 50,000 entries`);
});
