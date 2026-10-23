// Comments as VS Code toggles them: a line comment per line, a block comment around the
// selection (or the language's only kind, as CSS and HTML have), and a doc comment kept
// going on Enter. Pure: each returns the edit, the editor applies it.

// block comment delimiters by highlight language
const BLOCK = {
  javascript: ['/*', '*/'], typescript: ['/*', '*/'], c: ['/*', '*/'], cpp: ['/*', '*/'], csharp: ['/*', '*/'],
  java: ['/*', '*/'], go: ['/*', '*/'], rust: ['/*', '*/'], kotlin: ['/*', '*/'], swift: ['/*', '*/'], scala: ['/*', '*/'],
  dart: ['/*', '*/'], php: ['/*', '*/'], css: ['/*', '*/'], scss: ['/*', '*/'], sql: ['/*', '*/'], protobuf: ['/*', '*/'],
  xml: ['<!--', '-->'], html: ['<!--', '-->'], markdown: ['<!--', '-->'], lua: ['--[[', ']]'], haskell: ['{-', '-}'],
  python: ['"""', '"""'], ruby: ['=begin', '=end'], powershell: ['<#', '#>'], julia: ['#=', '=#'], r: null,
};
export const blockCommentFor = (hl) => BLOCK[hl] || null;
// languages whose documentation comments run /** … */ with a * per line
const DOC = new Set(['javascript', 'typescript', 'c', 'cpp', 'csharp', 'java', 'go', 'rust', 'kotlin', 'swift', 'scala', 'dart', 'php']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// lines a..b with the line comment toggled: off when every non-blank line has it
export function toggleLineComment(text, from, to, token) {
  const a = text.lastIndexOf('\n', from - 1) + 1;
  const endAt = to > from && text[to - 1] === '\n' ? to - 1 : to;
  const e = text.indexOf('\n', endAt);
  const b = e < 0 ? text.length : e;
  const lines = text.slice(a, b).split('\n');
  const used = lines.filter((l) => l.trim());
  const on = used.length > 0 && used.every((l) => l.trimStart().startsWith(token));
  // the comment at the shallowest indentation, as VS Code lines them up
  const indent = Math.min(...used.map((l) => l.match(/^[ \t]*/)[0].length));
  const next = lines.map((l) => {
    if (!l.trim()) return l;
    if (on) return l.replace(new RegExp(`^(\\s*)${escapeRe(token)} ?`), '$1');
    return `${l.slice(0, indent)}${token} ${l.slice(indent)}`;
  }).join('\n');
  return { from: a, to: b, text: next };
}

// the selection wrapped in a block comment, or unwrapped when it is one (or sits inside one
// on its line); with nothing selected, the line's text
export function toggleBlockComment(text, from, to, [open, close]) {
  if (from === to) {
    const a = text.lastIndexOf('\n', from - 1) + 1;
    const e = text.indexOf('\n', from);
    const line = text.slice(a, e < 0 ? text.length : e);
    const lead = line.length - line.trimStart().length;
    from = a + lead; to = a + line.trimEnd().length;
  }
  const inner = text.slice(from, to);
  const trimmed = inner.trim();
  if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length >= open.length + close.length) {
    const s = from + inner.indexOf(open);
    const e = from + inner.lastIndexOf(close);
    const body = text.slice(s + open.length, e).replace(/^ /, '').replace(/ $/, '');
    return { from: s, to: e + close.length, text: body, select: [s, s + body.length] };
  }
  // the selection just inside a comment's delimiters: those removed
  if (text.slice(from - open.length - 1, from) === `${open} ` && text.slice(to, to + close.length + 1) === ` ${close}`)
    return { from: from - open.length - 1, to: to + close.length + 1, text: inner, select: [from - open.length - 1, to - open.length - 1] };
  if (text.slice(from - open.length, from) === open && text.slice(to, to + close.length) === close)
    return { from: from - open.length, to: to + close.length, text: inner, select: [from - open.length, to - open.length] };
  const put = `${open} ${inner} ${close}`;
  return { from, to, text: put, select: [from + open.length + 1, from + open.length + 1 + inner.length] };
}

// Enter in a doc comment: { text to insert, caret offset within it } or null. Right after
// /** a closing line is added; on a * line the * carries on.
export function docCommentEnter(text, caret, hl) {
  if (!DOC.has(hl)) return null;
  const a = text.lastIndexOf('\n', caret - 1) + 1;
  const before = text.slice(a, caret);
  const after = text.slice(caret, (text.indexOf('\n', caret) + 1 || text.length + 1) - 1);
  const ind = before.match(/^[ \t]*/)[0];
  // after /** with text still after the caret: that text carried onto a * line
  if (/^[ \t]*\/\*\*(?!\/)([^*]|\*(?!\/))*$/.test(before) && after.trim() && !/^\s*\*\//.test(after)) return { text: `\n${ind} * `, caret: ind.length + 4 };
  if (/^[ \t]*\/\*\*\s*$/.test(before) && (!after.trim() || /^\s*\*\/\s*$/.test(after))) {
    // between /** and */ on one line: the */ goes down a line of its own
    if (after.trim()) return { text: `\n${ind} * \n${ind}`, caret: ind.length + 4 };
    // closed already further on (before another one opens): only the * line
    const rest = text.slice(caret);
    const close = rest.indexOf('*/'), reopen = rest.indexOf('/*');
    if (close >= 0 && (reopen < 0 || close < reopen)) return { text: `\n${ind} * `, caret: ind.length + 4 };
    return { text: `\n${ind} * \n${ind} */`, caret: ind.length + 4 };
  }
  const star = before.match(/^([ \t]*)\*(?!\/)( ?)/);
  if (star && !before.includes('*/')) {
    // inside a block comment: an opening /* above with no closing */ between
    const above = text.lastIndexOf('/*', a);
    const shut = text.lastIndexOf('*/', a);
    if (above >= 0 && shut < above) return { text: `\n${star[1]}* `, caret: star[1].length + 3 };
  }
  return null;
}
