// diffs: old and new as lines, the shortest edit between, 3 lines of context
import { el } from '../../lib/dom.ts';

export const lines = (s: unknown) => (s ? String(s).replace(/\n$/, '').split('\n') : []);

export function lineDiff(a: string[], b: string[]): [string, string][] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const mid: [string, string][] = [];
  if (A.length * B.length > 600000) {
    for (const l of A) mid.push(['-', l]);
    for (const l of B) mid.push(['+', l]);
  } else {
    const n = A.length;
    const m = B.length;
    const L = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        L[i * (m + 1) + j] = A[i] === B[j] ? L[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(L[(i + 1) * (m + 1) + j]!, L[i * (m + 1) + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) { mid.push([' ', A[i]!]); i++; j++; }
      else if (j < m && (i >= n || L[i * (m + 1) + j + 1]! >= L[(i + 1) * (m + 1) + j]!)) { mid.push(['+', B[j]!]); j++; }
      else { mid.push(['-', A[i]!]); i++; }
    }
  }
  return [...a.slice(0, p).map((l): [string, string] => [' ', l]), ...mid, ...a.slice(a.length - s).map((l): [string, string] => [' ', l])];
}

export function countDiff(a: unknown, b: unknown): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const [k] of lineDiff(lines(a), lines(b))) { if (k === '+') add++; else if (k === '-') del++; }
  return { add, del };
}

export function diffView(a: unknown, b: unknown): HTMLElement {
  const ops = lineDiff(lines(a), lines(b));
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach(([k], i) => { if (k !== ' ') for (let j = Math.max(0, i - 3); j <= Math.min(ops.length - 1, i + 3); j++) keep[j] = true; });
  const box = el('div', 'cd-diff');
  let gap = false;
  let shown = 0;
  ops.forEach(([k, l], i) => {
    if (!keep[i]) { gap = true; return; }
    if (gap) { box.append(el('div', 'cd-dl gap', '⋯')); gap = false; }
    if (++shown > 600) return;
    const r = el('div', `cd-dl${k === '+' ? ' add' : k === '-' ? ' del' : ''}`);
    r.append(el('span', 'cd-dm', k), el('span', 'cd-dt', l || ' '));
    box.append(r);
  });
  if (shown > 600) box.append(el('div', 'cd-dl gap', `… ${shown - 600} more lines`));
  if (!ops.length) box.append(el('div', 'cd-dl gap', '(empty)'));
  return box;
}
