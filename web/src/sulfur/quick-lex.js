// The edited lines of a file the page has no parser for, colored at once as VS Code's
// line tokenizer colors them, until the server's highlight (Chroma, a regex lexer
// too) replaces them. Comments, strings, numbers and the language's own words, under
// the classes Chroma's tokens map to (web/md.go), so the server's reply changes nothing
// the user just typed.

const words = (classes) => {
  const out = new Map();
  for (const [cls, list] of Object.entries(classes)) for (const w of list.split(' ')) out.set(w, cls);
  return out;
};
// Chroma's C# lexer: Keyword and KeywordDeclaration, KeywordType, KeywordConstant
const WORDS = {
  csharp: words({
    'hljs-keyword': 'as await base break by case catch checked continue default delegate do else event finally fixed for foreach goto if in init is let lock new on out params readonly ref return sizeof stackalloc switch this throw try typeof unchecked virtual void while get set yield add remove value alias ascending descending from group into orderby select thenby where join equals extern global class struct record interface namespace using abstract async const enum explicit implicit internal operator override partial private protected public static sealed unsafe volatile',
    'hljs-type': 'bool byte char decimal double dynamic float int long object sbyte short string uint ulong ushort var',
    'hljs-literal': 'true false null',
  }),
};

const NUMBER = /0[xX][0-9a-fA-F_]+[uUlL]*|\d[\d_]*(\.\d[\d_]*)?([eE][+-]?\d+)?[fFdDmMuUlL]*/y;
const WORD = /@?[\p{L}_][\p{L}\p{N}_]*/uy;
const PREPROC = /#[ \t]*(if|endif|else|elif|define|undef|line|error|warning|region|endregion|pragma|nullable)\b/y;

// where a range open at from (a block comment, a verbatim string) began, read from
// the colors drawn before the edit: '' when from starts fresh
export function lexStateAt(ranges, index, from) {
  const r = ranges[index];
  if (!r || r.from >= from || r.to <= from) return '';
  return r.cls === 'hljs-comment' ? 'comment' : r.cls === 'hljs-string' ? 'string' : '';
}

// ranges for text from..to, a line comment marker comment ('' for none)
export function quickLex(text, from, to, { lang = '', comment = '//', state = '' } = {}) {
  const table = WORDS[lang];
  const block = comment === '//';
  const out = [];
  const push = (a, b, cls) => { if (b > a) out.push({ from: a, to: b, cls }); };
  const lineEnd = (p) => { const e = text.indexOf('\n', p); return e < 0 || e > to ? to : e; };
  const closeBlock = (p) => { const e = text.indexOf('*/', p); return e < 0 || e + 2 > to ? to : e + 2; };
  // a verbatim string's end: a quote not doubled
  const closeVerbatim = (p) => {
    for (let i = p; i < to; i++) if (text[i] === '"') { if (text[i + 1] === '"') i++; else return i + 1; }
    return to;
  };
  let i = from;
  if (state === 'comment' && block) { const e = closeBlock(i); push(i, e, 'hljs-comment'); i = e; }
  else if (state === 'string' && lang === 'csharp') { const e = closeVerbatim(i); push(i, e, 'hljs-string'); i = e; }
  while (i < to) {
    const ch = text[i];
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (comment && text.startsWith(comment, i)) { const e = lineEnd(i); push(i, e, 'hljs-comment'); i = e; continue; }
    if (block && text.startsWith('/*', i)) { const e = closeBlock(i + 2); push(i, e, 'hljs-comment'); i = e; continue; }
    if (lang === 'csharp') {
      const verbatim = /^(\$@|@\$|@|\$)"/.exec(text.slice(i, i + 3));
      if (verbatim) { const e = closeVerbatim(i + verbatim[0].length); push(i, e, 'hljs-string'); i = e; continue; }
      if (ch === '#' && !text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trim()) {
        PREPROC.lastIndex = i;
        if (PREPROC.test(text)) { const e = lineEnd(i); push(i, e, 'hljs-meta'); i = e; continue; }
      }
    }
    if (ch === '"' || ch === "'" || (ch === '`' && !table)) {
      let e = i + 1;
      while (e < to && text[e] !== ch && text[e] !== '\n') e += text[e] === '\\' ? 2 : 1;
      e = Math.min(to, e < to && text[e] === ch ? e + 1 : e);
      push(i, e, 'hljs-string'); i = e; continue;
    }
    if (ch >= '0' && ch <= '9') {
      NUMBER.lastIndex = i;
      if (NUMBER.test(text)) { const e = Math.min(to, NUMBER.lastIndex); push(i, e, 'hljs-number'); i = e; continue; }
    }
    WORD.lastIndex = i;
    if (WORD.test(text)) {
      const e = Math.min(to, WORD.lastIndex);
      const cls = table?.get(text.slice(i, e));
      if (cls) push(i, e, cls);
      i = e; continue;
    }
    i++;
  }
  return out;
}
