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
export function highlightRanges(text, syntax = [], semantic = []) {
  const cuts = [...new Set([0, text.length, ...syntax.flatMap((r) => [r.from, r.to]), ...semantic.flatMap((r) => [r.from, r.to])])].sort((a, b) => a - b);
  let html = '', a = 0, b = 0;
  for (let i = 0; i < cuts.length - 1; i++) {
    const from = cuts[i], to = cuts[i + 1];
    while (a < syntax.length && syntax[a].to <= from) a++;
    while (b < semantic.length && semantic[b].to <= from) b++;
    const cls = semantic[b]?.from <= from ? semantic[b].cls : syntax[a]?.from <= from ? syntax[a].cls : '';
    const content = escape(text.slice(from, to));
    html += cls ? `<span class="${cls}">${content}</span>` : content;
  }
  return html;
}
