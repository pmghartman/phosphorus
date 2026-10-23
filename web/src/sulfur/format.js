// Sulfur's own Format Selection, for a file with no language server to ask: JSON printed
// again, brace languages' lines indented by their nesting, trailing spaces trimmed. Strings,
// comments and the text inside lines are never changed, only the lines' leading whitespace.

const BRACES = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hxx', 'cs', 'java', 'go', 'rs', 'php', 'css', 'scss', 'less', 'json', 'jsonc', 'kt', 'kts', 'swift', 'dart', 'scala', 'groovy', 'gradle', 'proto', 'zig', 'hcl', 'tf']);
const OPEN = { '{': 1, '[': 1, '(': 1 };
const CLOSE = { '}': 1, ']': 1, ')': 1 };

// a scanner's state carried line to line: a block comment or a multi-line string open
function scan(line, st) {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (st.comment) { if (ch === '*' && line[i + 1] === '/') { st.comment = false; i++; } continue; }
    if (st.quote) {
      if (ch === '\\') i++;
      else if (ch === st.quote) st.quote = '';
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') { st.comment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { st.quote = ch; continue; }
    if (OPEN[ch]) depth++;
    else if (CLOSE[ch]) depth--;
  }
  // a quote left open at the line's end: only a template literal goes on
  if (st.quote && st.quote !== '`') st.quote = '';
  return depth;
}

// the edits that format the lines from..to touches (the whole text when they're equal)
export function reindent(text, from, to, { ext = '', unit = '  ' } = {}) {
  if (from === to) { from = 0; to = text.length; }
  const start = text.lastIndexOf('\n', from - 1) + 1;
  // a selection ending at a line's start leaves that line alone
  let end = to > from && text[to - 1] === '\n' ? to - 1 : text.indexOf('\n', to);
  if (end < 0) end = text.length;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const strip = (s) => s.replace(/\r$/, '');
  if (ext === 'json' && start === 0 && end === text.length) {
    try { return [{ from: 0, to: text.length, text: JSON.stringify(JSON.parse(text), null, unit).replace(/\n/g, eol) + (/\n$/.test(text) ? eol : '') }]; } catch {}
  }
  // elsewhere only trailing whitespace goes: an indent can mean something there
  const braces = BRACES.has(ext);
  const st = { comment: false, quote: '' };
  let depth = 0;
  if (braces) for (const line of text.slice(0, start).split('\n')) depth += scan(line, st);
  depth = Math.max(0, depth);
  const edits = [];
  let at = start;
  for (const raw of text.slice(start, end).split('\n')) {
    const line = strip(raw);
    const body = line.trim();
    let want;
    // a template literal's lines are its text
    if (st.quote) want = line;
    else if (!braces || st.comment) want = line.trimEnd();
    else if (!body) want = '';
    else {
      const closers = body.match(/^[\]})]+/)?.[0].length || 0;
      want = unit.repeat(Math.max(0, depth - closers)) + body;
    }
    if (braces) depth = Math.max(0, depth + scan(line, st));
    if (want !== line) edits.push({ from: at, to: at + line.length, text: want });
    at += raw.length + 1;
  }
  return edits;
}
