// shared code and text, one live session per file, edits as text operations
// rebased in arrival order. Positions count UTF-16 units, as the browsers'
// strings do: a JS string is one already, so the document is a string

// Op a retain (N > 0), a delete (N < 0) or an insert (a string); the JSON shape as is
export type Op = number | string;

const isInsert = (o: Op): o is string => typeof o === "string";
const isRetain = (o: Op) => typeof o === "number" && o > 0;
const isDelete = (o: Op) => typeof o === "number" && o < 0;

// an op list built with neighbours merged, inserts kept ahead of deletes
export class Builder {
  ops: Op[] = [];
  add(o: Op) {
    if (o === 0 || o === "") return;
    const n = this.ops.length;
    if (n > 0) {
      const last = this.ops[n - 1]!;
      if (isInsert(o) && isDelete(last)) {
        if (n >= 2 && isInsert(this.ops[n - 2]!)) this.ops[n - 2] = (this.ops[n - 2] as string) + o;
        else this.ops.splice(n - 1, 1, o, last);
        return;
      }
      if (isInsert(o) && isInsert(last)) {
        this.ops[n - 1] = last + o;
        return;
      }
      if (!isInsert(o) && !isInsert(last) && o > 0 === last > 0) {
        this.ops[n - 1] = (last as number) + o;
        return;
      }
    }
    this.ops.push(o);
  }
  retain = (n: number) => this.add(n);
  insert = (s: string) => this.add(s);
  del = (n: number) => this.add(-n);
}

function baseLength(ops: Op[]): number {
  let n = 0;
  for (const o of ops) if (!isInsert(o)) n += Math.abs(o);
  return n;
}

// Parse ops from JSON, undefined when not valid
export function Parse(raw: unknown): Op[] | undefined {
  if (!Array.isArray(raw) || raw.length > 10000) return;
  const out: Op[] = [];
  for (const x of raw) {
    if (typeof x === "string") {
      if (x === "") return;
      out.push(x);
    } else if (typeof x === "number") {
      if (x === 0 || !Number.isInteger(x) || Math.abs(x) > Number.MAX_SAFE_INTEGER) return;
      out.push(x);
    } else return;
  }
  return out;
}

// Apply ops to doc, undefined when they don't fit the text
export function Apply(doc: string, ops: Op[]): string | undefined {
  if (baseLength(ops) !== doc.length) return;
  let out = "";
  let at = 0;
  for (const o of ops) {
    if (isInsert(o)) out += o;
    else if (o > 0) {
      out += doc.slice(at, at + o);
      at += o;
    } else at -= o;
  }
  return out;
}

// Transform a and b from the same text: a' after b and b' after a; undefined
// when they are of different lengths
export function Transform(a: Op[], b: Op[]): [Op[], Op[]] | undefined {
  const a1 = new Builder(), b1 = new Builder();
  let i = 0, j = 0;
  let x: Op | undefined = a[i++], y: Op | undefined = b[j++];
  for (;;) {
    if (x === undefined && y === undefined) break;
    if (x !== undefined && isInsert(x)) {
      a1.insert(x);
      b1.retain(x.length);
      x = a[i++];
      continue;
    }
    if (y !== undefined && isInsert(y)) {
      a1.retain(y.length);
      b1.insert(y);
      y = b[j++];
      continue;
    }
    if (x === undefined || y === undefined) return;
    const xn = x as number, yn = y as number;
    const n = Math.min(Math.abs(xn), Math.abs(yn));
    if (xn > 0 && yn > 0) {
      a1.retain(n);
      b1.retain(n);
    } else if (xn < 0 && yn > 0) a1.del(n);
    else if (xn > 0 && yn < 0) b1.del(n);
    x = Math.abs(xn) === n ? a[i++] : xn > 0 ? xn - n : xn + n;
    y = Math.abs(yn) === n ? b[j++] : yn > 0 ? yn - n : yn + n;
  }
  return [a1.ops, b1.ops];
}

// MapPos where a place in the text lands after an edit
export function MapPos(ops: Op[], pos: number): number {
  let i = 0, j = 0;
  for (const o of ops) {
    if (isInsert(o)) {
      j += o.length;
      continue;
    }
    const n = Math.abs(o);
    if (pos <= i + n) return o > 0 ? j + (pos - i) : j;
    i += n;
    if (o > 0) j += n;
  }
  return j;
}
