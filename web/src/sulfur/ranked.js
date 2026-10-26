// Keep only the best K entries while scanning an index. The worst retained entry
// sits at the root, so a large workspace never needs a full sort or a second
// array of every scored match. Equal scores retain the provider's order.
export function topRanked(items, limit, compare) {
  if (limit <= 0) return [];
  const heap = [];
  const order = (a, b) => compare(a.item, b.item) || a.index - b.index;
  const down = (at) => {
    for (;;) {
      let worst = at;
      const left = at * 2 + 1, right = left + 1;
      if (left < heap.length && order(heap[left], heap[worst]) > 0) worst = left;
      if (right < heap.length && order(heap[right], heap[worst]) > 0) worst = right;
      if (worst === at) return;
      [heap[at], heap[worst]] = [heap[worst], heap[at]];
      at = worst;
    }
  };
  let index = 0;
  for (const item of items) {
    const entry = { item, index: index++ };
    if (heap.length < limit) {
      let at = heap.push(entry) - 1;
      while (at > 0) {
        const parent = (at - 1) >> 1;
        if (order(heap[at], heap[parent]) <= 0) break;
        [heap[at], heap[parent]] = [heap[parent], heap[at]];
        at = parent;
      }
    } else if (order(entry, heap[0]) < 0) {
      heap[0] = entry;
      down(0);
    }
  }
  return heap.sort(order).map((entry) => entry.item);
}
