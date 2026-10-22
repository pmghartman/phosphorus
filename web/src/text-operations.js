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
// one replace: what changed between two texts, by their common ends
export function opDiff(a, b) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s += 1;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e += 1;
  const o = opBuilder();
  o.retain(s);
  o.insert(b.slice(s, b.length - e));
  o.del(a.length - s - e);
  o.retain(e);
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

