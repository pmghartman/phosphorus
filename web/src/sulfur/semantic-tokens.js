export const TOKEN_TYPES = ['namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter', 'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method', 'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator', 'decorator'];
export const TOKEN_MODIFIERS = ['declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract', 'async', 'modification', 'documentation', 'defaultLibrary'];
const classes = {
  namespace: 'hljs-type', type: 'hljs-type', class: 'hljs-type', enum: 'hljs-type', interface: 'hljs-type', struct: 'hljs-type', typeParameter: 'hljs-type',
  parameter: 'hljs-variable', variable: 'hljs-variable', property: 'hljs-attr', enumMember: 'hljs-literal', event: 'hljs-attr',
  field: 'hljs-variable', constant: 'hljs-literal', stringEscapeCharacter: 'hljs-string',
  function: 'hljs-title', method: 'hljs-title', macro: 'hljs-meta', keyword: 'hljs-keyword', modifier: 'hljs-keyword', comment: 'hljs-comment',
  string: 'hljs-string', number: 'hljs-number', regexp: 'hljs-regexp', operator: 'hljs-operator', decorator: 'hljs-meta',
};
export function semanticRanges(text, data, legend) {
  if (!Array.isArray(data) || data.length % 5) throw new Error('Invalid semantic token data');
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  const ranges = [];
  let line = 0, character = 0, last = 0;
  for (let i = 0; i < data.length; i += 5) {
    const [dl, dc, length, type, modifiers] = data.slice(i, i + 5);
    if (![dl, dc, length, type, modifiers].every((x) => Number.isInteger(x) && x >= 0)) throw new Error('Invalid semantic token');
    line += dl; character = dl ? dc : character + dc;
    if (line >= starts.length) throw new Error('Semantic token outside document');
    const from = starts[line] + character, to = from + length;
    let end = line + 1 < starts.length ? starts[line + 1] - 1 : text.length;
    if (text[end - 1] === '\r') end--;
    if (from < last || to > end) throw new Error('Invalid semantic token range');
    const token = legend.tokenTypes[type];
    const cls = classes[token] || (token?.startsWith('regex') ? 'hljs-regexp' : token?.startsWith('json') ? /String/.test(token) ? 'hljs-string' : /Number/.test(token) ? 'hljs-number' : 'hljs-attr' : '');
    if (cls && length) ranges.push({ from, to, cls });
    last = to;
  }
  return ranges;
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
// Chroma emits only escaped text and flat hljs spans. Decode that restricted
// format into ranges so fallback syntax and semantic tokens can coexist and
// survive edits. Reject anything that does not reproduce the exact document.
export function rangesFromHighlight(html, text) {
  const ranges = [];
  let at = 0, cls = '', start = 0;
  for (const [part] of html.matchAll(/<[^>]*>|[^<]+/g)) {
    if (part.startsWith('<')) {
      if (part === '</span>' && cls) { ranges.push({ from: start, to: at, cls }); cls = ''; }
      else {
        const match = /^<span class="(hljs-[a-z_-]+)">$/.exec(part);
        if (!match || cls) return null;
        cls = match[1]; start = at;
      }
    } else {
      const decoded = part.replace(/&(amp|lt|gt|quot|apos|#34|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#34': '"', '#39': "'" })[entity]);
      if (text.slice(at, at + decoded.length) !== decoded) return null;
      at += decoded.length;
    }
  }
  return !cls && at === text.length ? ranges : null;
}
// Keep classifications for unchanged text while a newer parse/server response is
// pending. Only an edited token is invalidated; identifier typing keeps its color.
export function rebaseHighlightRanges(before, after, ranges) {
  if (before === after || !ranges.length) return ranges;
  let from = 0, tail = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  while (tail < before.length - from && tail < after.length - from && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
  const end = before.length - tail, added = after.slice(from, after.length - tail), delta = after.length - before.length;
  const identifier = /^@?[$\p{L}_][$\p{L}\p{N}\p{M}_]*$/u;
  const continuation = /^[$\p{L}\p{N}\p{M}_]*$/u.test(added);
  const out = [];
  for (const range of ranges) {
    const inside = from >= range.from && end <= range.to;
    const joined = inside && continuation && identifier.test(before.slice(range.from, range.to));
    if (joined && /hljs-(type|variable|title|attr|literal)/.test(range.cls)) {
      if (range.to + delta > range.from) out.push({ ...range, to: range.to + delta });
    } else if (range.to <= from && !(joined && added)) out.push(range);
    else if (range.from >= end && !(joined && added)) out.push({ ...range, from: range.from + delta, to: range.to + delta });
  }
  return out;
}
export function highlightRanges(text, syntax = [], semantic = []) {
  const html = [];
  let a = 0, b = 0, from = 0, start = 0, active = '';
  const emit = (to) => {
    if (to > start) {
      const content = escape(text.slice(start, to));
      html.push(active ? `<span class="${active}">${content}</span>` : content);
    }
    start = to;
  };
  while (from < text.length) {
    while (a < syntax.length && syntax[a].to <= from) a++;
    while (b < semantic.length && semantic[b].to <= from) b++;
    const sa = syntax[a], sb = semantic[b];
    const to = Math.min(text.length, sa ? sa.from > from ? sa.from : sa.to : text.length, sb ? sb.from > from ? sb.from : sb.to : text.length);
    const lexical = sa?.from <= from ? sa.cls : '';
    const cls = /hljs-(comment|string|regexp)/.test(lexical) ? lexical : sb?.from <= from ? sb.cls : lexical;
    if (cls !== active) { emit(from); active = cls; }
    from = to;
  }
  emit(text.length);
  return html.join('');
}
