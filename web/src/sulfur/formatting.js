import { opApply, opEdits } from '../text-operations.js';

const LANGUAGES = new Set(['csharp', 'c', 'cpp', 'java', 'javascript', 'typescript', 'rust', 'css', 'scss', 'json']);

// This pass changes whitespace only. Language servers handle syntax-specific
// formatting first; literal/comment contents are kept byte for byte here.
function literalEnd(text, at) {
  const start = text.slice(at).match(/^(?:\$*@?\$?|@\$)?("{3,}|"|')/);
  if (!start) return null;
  const quote = start[1], verbatim = start[0].includes('@'), interpolated = start[0].includes('$');
  let i = at + start[0].length;
  while (i < text.length) {
    if (text.startsWith(quote, i)) {
      if (quote.length === 1 && verbatim && text[i + 1] === '"') { i += 2; continue; }
      return i + quote.length;
    }
    if (quote.length === 1 && !verbatim && text[i] === '\\') { i += 2; continue; }
    if (quote.length === 1 && interpolated && text[i] === '{') {
      if (text[i + 1] === '{') { i += 2; continue; }
      let depth = 1; i++;
      while (i < text.length && depth) {
        const literal = literalEnd(text, i);
        if (literal !== null) { i = literal; continue; }
        if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
        if (text.startsWith('//', i)) { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end; continue; }
        if (text[i] === '{') depth++; else if (text[i] === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return text.length;
}
function protectedSpans(text, tree) {
  const spans = [];
  if (tree) {
    tree.iterate({ enter(node) {
      if (/String|Comment|Character|RegExp|Template|JSX/.test(node.name)) { spans.push({ from: node.from, to: node.to }); return false; }
    } });
    return spans;
  }
  // C# has no bundled Lezer grammar. Recognize its regular, verbatim,
  // interpolated and raw literals without interpreting their contents.
  for (let i = 0; i < text.length;) {
    const from = i;
    if (text.startsWith('//', i) || (text[i] === '#' && !text.slice(text.lastIndexOf('\n', i - 1) + 1, i).trim())) {
      const end = text.indexOf('\n', i); i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2;
    } else {
      const end = literalEnd(text, i);
      if (end === null) { i++; continue; }
      i = end;
    }
    spans.push({ from, to: Math.min(i, text.length) });
  }
  return spans;
}

function scan(text, tree) {
  const spans = protectedSpans(text, tree), braces = [];
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    while (at < spans.length && spans[at].to <= i) at++;
    if (spans[at]?.from <= i) { i = spans[at].to - 1; continue; }
    if ('{}[]'.includes(text[i])) braces.push(i);
  }
  return { spans, braces };
}

export function formatWhitespace(text, language, options, tree, parse) {
  const original = text;
  if (!LANGUAGES.has(language)) return text;
  // A preprocessor can make an apparently balanced brace syntactically
  // inactive. Leave these files to the project-aware formatter.
  if (/^\s*#(?:if|elif|else|endif|define)\b/m.test(text)) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let { spans, braces } = scan(text, tree);
  if (options.braceStyle !== 'preserve' && (language === 'csharp' || parse)) {
    const patches = new Map();
    const spanEnds = new Map(spans.map((s) => [s.to, s]));
    const put = (from, to, value) => patches.set(`${from}:${to}`, { from, to, text: value });
    for (const at of braces) {
      if (text[at] !== '{' && text[at] !== '}') continue;
      const open = text[at] === '{';
      let from = at, to = at + 1;
      while (from > 0 && /\s/.test(text[from - 1])) from--;
      while (to < text.length && /\s/.test(text[to])) to++;
      const prior = text.slice(Math.max(0, from - 30), from);
      let tokenEnd = from;
      for (;;) {
        while (tokenEnd > 0 && /\s/.test(text[tokenEnd - 1])) tokenEnd--;
        const comment = spanEnds.get(tokenEnd);
        if (!comment || !/^\/[/\*]/.test(text.slice(comment.from, comment.from + 2))) break;
        tokenEnd = comment.from;
      }
      const priorSpan = spanEnds.get(from);
      const lineComment = priorSpan && (text.slice(priorSpan.from, priorSpan.from + 2) === '//' || text[priorSpan.from] === '#');
      if (open) {
        // Moving a JS return value across a newline changes program behavior.
        const restricted = /\b(?:return|throw|yield|break|continue)$/.test(text.slice(Math.max(0, tokenEnd - 20), tokenEnd));
        if (from && !lineComment && !restricted && !/[{[(,:]$/.test(prior)) put(from, at, options.braceStyle === 'nextLine' ? eol : ' ');
        if (to < text.length && text[to] !== '}') put(at + 1, to, eol);
      } else if (from && text[from - 1] !== '{') put(from, at, eol);
    }
    text = opApply(text, opEdits(text, [...patches.values()]));
    // Newline positions changed; rescan literals before touching indentation.
    ({ spans, braces } = scan(text, parse?.(text)));
  }
  const unit = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
  let offset = 0, depth = 0, braceAt = 0, spanAt = 0;
  const formatted = text.split(/\r?\n/).map((line) => {
    const start = offset, end = start + line.length;
    offset = end + eol.length;
    while (spanAt < spans.length && spans[spanAt].to <= start) spanAt++;
    const insideLiteral = spans[spanAt]?.from < start && spans[spanAt].to > start;
    const leadingClose = (line.trimStart().match(/^[}\]]+/) || [''])[0].length;
    const structuralDepth = Math.max(0, depth - leadingClose);
    const indent = options.indentBlocks ? structuralDepth : 0;
    const columns = [...(line.match(/^[\t ]*/) || [''])[0]].reduce((n, ch) => ch === '\t' ? n + options.tabSize - n % options.tabSize : n + 1, 0);
    const continuation = options.preserveContinuation ? Math.max(0, columns - structuralDepth * options.tabSize) : 0;
    while (braceAt < braces.length && braces[braceAt] < end) { depth = Math.max(0, depth + ('{['.includes(text[braces[braceAt++]]) ? 1 : -1)); }
    if (insideLiteral || !line.trim()) return line;
    return unit.repeat(indent) + (options.insertSpaces ? ' '.repeat(continuation) : '\t'.repeat(Math.floor(continuation / options.tabSize)) + ' '.repeat(continuation % options.tabSize)) + line.replace(/^[\t ]*/, '');
  }).join(eol);
  // Whitespace can carry meaning (notably JS automatic semicolon insertion).
  // Keep the server's/source text if a local style would change its syntax tree.
  return tree && parse && tree.toString() !== parse(formatted).toString() ? original : formatted;
}

export function formattingEdits(before, after) {
  const edits = [];
  let a = 0, b = 0;
  while (a < before.length || b < after.length) {
    if (before[a] === after[b]) { a++; b++; continue; }
    const from = a, start = b;
    while (a < before.length && /\s/.test(before[a])) a++;
    while (b < after.length && /\s/.test(after[b])) b++;
    if (a === from && b === start || before[a] !== after[b]) {
      // A formatter occasionally normalizes a token too. Retain common ends.
      let tail = 0;
      while (tail < before.length - from && tail < after.length - start && before[before.length - tail - 1] === after[after.length - tail - 1]) tail++;
      edits.push({ from, to: before.length - tail, text: after.slice(start, after.length - tail) });
      return edits;
    }
    edits.push({ from, to: a, text: after.slice(start, b) });
  }
  return edits;
}
