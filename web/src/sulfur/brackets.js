// Brackets as VS Code pairs them: the bracket beside the caret (after it first, then
// before) and its partner, nesting counted and anything in a string or comment skipped.
// Pure, for the editor's highlight and Go to Bracket alike.

const OPEN = { '(': ')', '[': ']', '{': '}' };
const CLOSE = { ')': '(', ']': '[', '}': '{' };
// how far a partner is looked for either way, so a stray bracket in a long file stays cheap
export const BRACKET_SCAN = 40000;

// the partner of the bracket at at, or -1; code(i) false where i is in a string or comment
export function partnerOf(text, at, code = () => true, limit = BRACKET_SCAN) {
  const ch = text[at];
  if (OPEN[ch]) {
    const want = OPEN[ch];
    let depth = 0;
    for (let i = at + 1, end = Math.min(text.length, at + limit); i < end; i++) {
      const c = text[i];
      if (c !== ch && c !== want) continue;
      if (!code(i)) continue;
      if (c === ch) depth++;
      else if (depth) depth--;
      else return i;
    }
  } else if (CLOSE[ch]) {
    const want = CLOSE[ch];
    let depth = 0;
    for (let i = at - 1, end = Math.max(0, at - limit); i >= end; i--) {
      const c = text[i];
      if (c !== ch && c !== want) continue;
      if (!code(i)) continue;
      if (c === ch) depth++;
      else if (depth) depth--;
      else return i;
    }
  }
  return -1;
}

// the pair the caret touches: { open, close } as offsets, or null
export function bracketPair(text, caret, code = () => true, limit = BRACKET_SCAN) {
  for (const at of [caret, caret - 1]) {
    if (at < 0 || at >= text.length || !(OPEN[text[at]] || CLOSE[text[at]]) || !code(at)) continue;
    const other = partnerOf(text, at, code, limit);
    if (other >= 0) return { open: Math.min(at, other), close: Math.max(at, other) };
  }
  return null;
}

// the innermost pair around the caret, for Go to Bracket from inside one: { open, close } or null
export function enclosingPair(text, caret, code = () => true, limit = BRACKET_SCAN) {
  const depth = { ')': 0, ']': 0, '}': 0 };
  for (let i = caret - 1, end = Math.max(0, caret - limit); i >= end; i--) {
    const c = text[i];
    if (!(OPEN[c] || CLOSE[c]) || !code(i)) continue;
    if (CLOSE[c]) { depth[c]++; continue; }
    if (depth[OPEN[c]]) { depth[OPEN[c]]--; continue; }
    const close = partnerOf(text, i, code, limit);
    return close >= 0 ? { open: i, close } : null;
  }
  return null;
}

// the line's leading whitespace for a closer typed at caret on a line of only whitespace:
// the indentation of the line its partner opens, as VS Code outdents a typed } or ]; null
// when there's nothing to change
export function outdentFor(text, caret, closer, code = () => true) {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const before = text.slice(lineStart, caret);
  if (!CLOSE[closer] || !/^[ \t]*$/.test(before)) return null;
  // the closer as if typed: its partner sought from just before it
  const probe = text.slice(0, caret) + closer + text.slice(caret);
  const open = partnerOf(probe, caret, (i) => i === caret || code(i < caret ? i : i - 1));
  if (open < 0) return null;
  const openLine = probe.lastIndexOf('\n', open - 1) + 1;
  const indent = probe.slice(openLine).match(/^[ \t]*/)[0];
  return indent === before ? null : { from: lineStart, to: caret, indent };
}
