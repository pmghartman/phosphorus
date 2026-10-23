// Text operations shared by the live session and its undo history.
const opIns = (o) => typeof o === 'string';
const opDel = (o) => typeof o === 'number' && o < 0;
export function opBuilder() {
  const ops = [];
  const add = (o) => {
    if (o === 0 || o === '') return;
    const last = ops[ops.length - 1];
    if (opIns(o) && opDel(last)) {
      const before = ops[ops.length - 2];
      if (opIns(before)) ops[ops.length - 2] = before + o; else ops.splice(ops.length - 1, 0, o);
    } else if (last !== undefined && typeof last === typeof o && (opIns(o) || (o > 0) === (last > 0))) ops[ops.length - 1] = last + o;
    else ops.push(o);
  };
  return { ops, retain: (n) => add(n), insert: (s) => add(s), del: (n) => add(-n) };
}
export function opApply(doc, ops) {
  let out = '';
  let at = 0;
  for (const o of ops) {
    if (opIns(o)) out += o;
    else if (o > 0) { out += doc.slice(at, at + o); at += o; } else at -= o;
  }
  return out;
}
export function opTransform(a, b) {
  const a1 = opBuilder();
  const b1 = opBuilder();
  let i = 0;
  let j = 0;
  let x = a[i++];
  let y = b[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if (opIns(x)) { a1.insert(x); b1.retain(x.length); x = a[i++]; continue; }
    if (opIns(y)) { a1.retain(y.length); b1.insert(y); y = b[j++]; continue; }
    if (x === undefined || y === undefined) throw new Error('operations of different lengths');
    const n = Math.min(Math.abs(x), Math.abs(y));
    if (x > 0 && y > 0) { a1.retain(n); b1.retain(n); } else if (x < 0 && y > 0) a1.del(n); else if (x > 0 && y < 0) b1.del(n);
    x = Math.abs(x) === n ? a[i++] : x > 0 ? x - n : x + n;
    y = Math.abs(y) === n ? b[j++] : y > 0 ? y - n : y + n;
  }
  return [a1.ops, b1.ops];
}
// The lengths of the head and tail two texts share, the tail never overlapping the head.
// Compared a block at a time first: every keystroke diffs the whole document several
// times (session, history, parse, highlight), so this stays native speed on big files.
const BLOCK = 1024;
export function commonEnds(a, b) {
  const max = Math.min(a.length, b.length);
  let head = 0;
  while (head + BLOCK <= max && a.slice(head, head + BLOCK) === b.slice(head, head + BLOCK)) head += BLOCK;
  while (head < max && a.charCodeAt(head) === b.charCodeAt(head)) head += 1;
  const room = max - head;
  let tail = 0;
  while (tail + BLOCK <= room && a.slice(a.length - tail - BLOCK, a.length - tail) === b.slice(b.length - tail - BLOCK, b.length - tail)) tail += BLOCK;
  while (tail < room && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)) tail += 1;
  return { head, tail };
}
// one replace: what changed between two texts, by their common ends
export function opDiff(a, b) {
  const { head: s, tail: e } = commonEnds(a, b);
  const o = opBuilder();
  o.retain(s);
  o.insert(b.slice(s, b.length - e));
  o.del(a.length - s - e);
  o.retain(e);
  return o.ops;
}
// Disjoint replacements retain unchanged spans so undo can preserve peer edits.
export function opEdits(text, edits) {
  const o = opBuilder();
  let at = 0;
  for (const e of [...edits].sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (!Number.isInteger(e.from) || !Number.isInteger(e.to) || e.from < at || e.to < e.from || e.to > text.length || typeof e.text !== 'string') throw new Error('Overlapping or invalid text edits');
    o.retain(e.from - at); o.insert(e.text); o.del(e.to - e.from); at = e.to;
  }
  o.retain(text.length - at);
  return o.ops;
}

export function opInverse(text, ops) {
  const o = opBuilder();
  let at = 0;
  for (const part of ops) {
    if (opIns(part)) o.del(part.length);
    else if (part > 0) { o.retain(part); at += part; }
    else { o.insert(text.slice(at, at - part)); at -= part; }
  }
  return o.ops;
}

// where a place in the text lands after an edit
export function opMap(ops, pos) {
  let i = 0;
  let j = 0;
  for (const o of ops) {
    if (opIns(o)) { j += o.length; continue; }
    const n = Math.abs(o);
    if (pos <= i + n) return o > 0 ? j + (pos - i) : j;
    i += n;
    if (o > 0) j += n;
  }
  return j;
}

