import { expect, test } from "bun:test";
import { Apply, Builder, type Op, Transform } from "../src/ot.ts";

// a seeded generator, the run the same each time as Go's rand.NewSource(1) was
function rng(seed: number) {
  let a = seed >>> 0;
  return (n: number) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

function randOp(r: (n: number) => number, n: number): Op[] {
  const b = new Builder();
  let left = n;
  while (left > 0 || r(4) === 0) {
    const k = r(3);
    if (k === 0) {
      let ins = "";
      const m = r(4);
      for (let i = 0; i <= m; i++) ins += ["a", "b", "\n", "😀", "é"][r(5)];
      b.insert(ins);
    } else if (left > 0 && k === 1) {
      const d = 1 + r(left);
      b.del(d);
      left -= d;
    } else if (left > 0) {
      const d = 1 + r(left);
      b.retain(d);
      left -= d;
    }
    if (left === 0 && r(2) === 0) break;
  }
  return b.ops;
}

test("transform converges", () => {
  const r = rng(1);
  for (let i = 0; i < 5000; i++) {
    const doc = ["", "hello world", "a😀b\nc", "line one\nline two\n"][r(4)]!;
    const a = randOp(r, doc.length),
      b = randOp(r, doc.length);
    const t = Transform(a, b);
    expect(t).toBeDefined();
    const [a1, b1] = t!;
    const da = Apply(doc, a)!,
      db = Apply(doc, b)!;
    const x = Apply(da, b1),
      y = Apply(db, a1);
    expect(x).toBeDefined();
    expect(y).toBeDefined();
    if (x !== y) throw new Error(`diverged: ${JSON.stringify(x)} ${JSON.stringify(y)}`);
  }
});
