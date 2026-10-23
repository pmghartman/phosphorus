export const diagnosticSeverity = (d) => [1, 2, 3, 4].includes(d.severity) ? d.severity : 1;
export const diagnosticDelay = (value) => Math.max(300, Math.min(5000, Number(value) || 1000));
export function diagnosticCounts(items) {
  return items.reduce((out, item) => { out[diagnosticSeverity(item) === 1 ? 'errors' : diagnosticSeverity(item) === 2 ? 'warnings' : 'info']++; return out; }, { errors: 0, warnings: 0, info: 0 });
}
export function diagnosticText(item) {
  const kind = diagnosticSeverity(item) === 1 ? 'Error' : diagnosticSeverity(item) === 2 ? 'Warning' : 'Info';
  return `${kind}${item.code != null ? ` ${typeof item.code === 'object' ? item.code.value : item.code}` : ''}${item.source ? ` (${item.source})` : ''}: ${item.what || item.message}`;
}
// Mouse columns are visual columns; document offsets remain UTF-16 for LSP.
export function offsetAtColumn(text, line, column, tabSize = 4) {
  if (line < 0 || column < 0) return null;
  let start = 0;
  for (let n = 0; n < line; n++) { const end = text.indexOf('\n', start); if (end < 0) return null; start = end + 1; }
  let at = start, visual = 0;
  while (at < text.length && !'\r\n'.includes(text[at])) {
    const ch = String.fromCodePoint(text.codePointAt(at));
    const width = ch === '\t' ? tabSize - visual % tabSize : 1;
    if (column < visual + width) return at;
    visual += width; at += ch.length;
  }
  return column === visual ? at : null;
}
// Diagnostics moved with an edit, as VS Code's markers move: kept until the next report
// replaces them, so squiggles don't blink off on every keystroke. One inside the
// edited span is stretched over what replaced it.
export function rebaseDiagnostics(items, change, delta) {
  const { head, tail, before } = change;
  const end = before - tail, endNew = end + delta;
  const at = (p, side) => p < head || (side < 0 && p === head) ? p : p >= end ? p + delta : side < 0 ? head : endNew;
  return items.map((d) => ({ ...d, from: at(d.from, -1), to: Math.max(at(d.from, -1), at(d.to, 1)) }));
}
export function diagnosticsAt(items, offset) {
  return offset == null ? [] : items.filter((d) => offset >= d.from && offset < Math.max(d.to, d.from + 1)).sort((a, b) => diagnosticSeverity(a) - diagnosticSeverity(b));
}
