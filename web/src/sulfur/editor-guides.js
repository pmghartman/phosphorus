function indentation(line, tabSize) {
  let column = 0;
  for (const ch of line) {
    if (ch === ' ') column++;
    else if (ch === '\t') column += tabSize - column % tabSize;
    else break;
  }
  return column;
}

// Only visible lines and columns produce decorations, independent of file size.
export function editorDecorations(text, starts, { first = 0, last = starts.length - 1, left = 0, right = Infinity, tabSize = 4, whitespace = 'none', guides = true } = {}) {
  const out = [];
  const line = (index) => text.slice(starts[index], index + 1 < starts.length ? starts[index + 1] - 1 : text.length).replace(/\r$/, '');
  const widths = new Map();
  let blankStart = -1, blankEnd = -1, blankDepth = 0;
  const indent = (index) => {
    if (!widths.has(index)) { const value = line(index); widths.set(index, /\S/.test(value) ? indentation(value, tabSize) : null); }
    return widths.get(index);
  };
  for (let index = Math.max(0, first); index <= Math.min(last, starts.length - 1); index++) {
    const value = line(index), markers = [];
    let depth = guides ? indent(index) : 0;
    if (depth === null) {
      if (index < blankStart || index > blankEnd) {
        let before = index - 1, after = index + 1;
        // Bound context even in generated files with enormous blank runs.
        const low = Math.max(0, first - 200), high = Math.min(starts.length - 1, last + 200);
        while (before >= low && indent(before) === null) before--;
        while (after <= high && indent(after) === null) after++;
        blankStart = before + 1; blankEnd = after - 1;
        blankDepth = Math.min(before >= low ? indent(before) : 0, after <= high ? indent(after) : 0);
      }
      depth = blankDepth;
    }
    if (whitespace !== 'none') {
      let column = 0;
      const leading = value.search(/[^ \t]/), trailing = value.search(/[ \t]+$/);
      for (let at = 0; at < value.length && column <= right;) {
        const ch = String.fromCodePoint(value.codePointAt(at));
        if (ch === ' ' || ch === '\t') {
          let end = at;
          while (value[end] === ch) end++;
          const start = column;
          const width = ch === '\t' ? tabSize - column % tabSize + (end - at - 1) * tabSize : end - at;
          column += width;
          const boundary = leading < 0 || at < leading || trailing >= 0 && at >= trailing || end - at > 1 || ch === '\t';
          if (column > left && start <= right && (whitespace === 'all' || boundary)) {
            if (ch === ' ') {
              const a = Math.max(start, left), b = Math.min(column, right + 1);
              markers.push({ column: a, text: '·'.repeat(Math.max(0, b - a)) });
            } else for (let c = start; c < column && c <= right; c += tabSize - c % tabSize) if (c >= left) markers.push({ column: c, text: '→' });
          }
          at = end;
        } else { column++; at += ch.length; }
      }
    }
    if (depth || markers.length) out.push({ line: index, indent: depth || 0, markers });
  }
  return out;
}
