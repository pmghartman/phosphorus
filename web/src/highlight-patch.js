// an editor's highlight kept across an edit: the lines it didn't touch drawn as they were

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// highlighted html cut at its newlines: a span open across one closed at the line's end
// and opened again on the next, so every line stands alone
export function htmlLines(html) {
  const out = [];
  const open = [];
  let line = '';
  for (const [, tag, text] of html.matchAll(/(<[^>]*>)|([^<]+)/g)) {
    if (tag) {
      if (tag[1] === '/') open.pop(); else if (!tag.endsWith('/>')) open.push(tag);
      line += tag;
      continue;
    }
    const parts = text.split('\n');
    line += parts[0];
    for (const part of parts.slice(1)) {
      out.push(line + '</span>'.repeat(open.length));
      line = open.join('') + part;
    }
  }
  out.push(line + '</span>'.repeat(open.length));
  return out;
}

// text drawn with an older highlight's lines wherever they're unchanged and the edited
// ones plain, so a keystroke never drops a whole file's colours while a new highlight
// is on its way; null when the old one can't be cut into its text's lines
export function patchHighlight(old, text) {
  old.was ||= old.text.split('\n');
  old.lines ||= htmlLines(old.html);
  const { was, lines } = old;
  if (lines.length !== was.length) return null;
  const now = text.split('\n');
  let head = 0;
  while (head < now.length && head < was.length && now[head] === was[head]) head += 1;
  let tail = 0;
  while (tail < now.length - head && tail < was.length - head && now[now.length - 1 - tail] === was[was.length - 1 - tail]) tail += 1;
  return [...lines.slice(0, head), ...now.slice(head, now.length - tail).map(escape), ...lines.slice(was.length - tail)].join('\n');
}
