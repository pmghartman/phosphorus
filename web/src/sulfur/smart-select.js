// Expand and Shrink Selection, as VS Code's smart select: from the caret the word, then
// each syntax node around it (a string's contents before the string), the line's text, the
// whole line, the document. Pure: the editor gives its text, selection and syntax tree.
import { wordStart, wordEnd } from './completion.js';

// every range around [from, to], smallest first, each strictly larger than the last
export function selectionRanges(text, from, to, tree = null) {
  const out = [];
  const add = (a, b) => {
    if (a > from || b < to || (a === from && b === to) || a < 0 || b > text.length || b < a) return;
    if (!out.some((r) => r[0] === a && r[1] === b)) out.push([a, b]);
  };
  const ws = wordStart(text, from), we = wordEnd(text, to);
  if (we > ws) add(ws, we);
  if (tree) {
    for (let node = tree.resolveInner(from, 1); node; node = node.parent) {
      if (node.from > from || node.to < to) continue;
      // inside a string's quotes before the whole string
      if (/String|Template/.test(node.name) && node.to - node.from >= 2) {
        const q = text[node.from];
        if (q === text[node.to - 1] && `"'\``.includes(q)) add(node.from + 1, node.to - 1);
      }
      // a bracketed node's inside before the node
      const first = text[node.from], last = text[node.to - 1];
      if ((first === '(' && last === ')') || (first === '[' && last === ']') || (first === '{' && last === '}')) {
        let a = node.from + 1, b = node.to - 1;
        while (a < b && /\s/.test(text[a])) a++;
        while (b > a && /\s/.test(text[b - 1])) b--;
        add(a, b);
      }
      add(node.from, node.to);
    }
  }
  const ls = text.lastIndexOf('\n', from - 1) + 1;
  const le0 = text.indexOf('\n', to);
  const le = le0 < 0 ? text.length : le0;
  const lineText = text.slice(ls, le);
  const lead = lineText.length - lineText.trimStart().length;
  const trail = lineText.length - lineText.trimEnd().length;
  add(ls + lead, le - trail);
  add(ls, le0 < 0 ? le : le + 1);
  add(0, text.length);
  return out.sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
}

// the next larger range, or null at the document
export function expandSelection(text, from, to, tree = null) {
  return selectionRanges(text, from, to, tree)[0] || null;
}
