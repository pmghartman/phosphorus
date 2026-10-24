import { commonEnds } from '../text-operations.js';

// Completion as VS Code does it: a provider's items filtered and ranked on the client by
// a fuzzy score as typing goes on, a language server first and words from the open
// documents when it has nothing, snippets expanded to their text and first tab stop.

const WORD = /[\p{L}\p{N}_$]/u;
// ASCII answered without a regex: typing asks this for nearly every character
const asciiWord = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
export const isWordChar = (ch) => {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return c < 128 ? asciiWord(c) : WORD.test(ch);
};
// the code point ending at i (its length 1 or 2), as the u flag reads it
function charBefore(text, i) {
  const lo = text.charCodeAt(i - 1);
  if (lo >= 0xDC00 && lo <= 0xDFFF && i > 1) { const hi = text.charCodeAt(i - 2); if (hi >= 0xD800 && hi <= 0xDBFF) return text.slice(i - 2, i); }
  return text[i - 1];
}
// where the word the caret ends starts. Walked back from the caret: a regex anchored at the
// end of text.slice(0, caret) is tried from every position, quadratic in a long file
export function wordStart(text, caret) {
  let i = caret;
  while (i > 0) {
    const c = text.charCodeAt(i - 1);
    if (c < 128) { if (!asciiWord(c)) break; i--; continue; }
    const ch = charBefore(text, i);
    if (!WORD.test(ch)) break;
    i -= ch.length;
  }
  return i;
}
// where the word the caret is in ends
export function wordEnd(text, caret) {
  let i = caret;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c < 128) { if (!asciiWord(c)) break; i++; continue; }
    const ch = String.fromCodePoint(text.codePointAt(i));
    if (!WORD.test(ch)) break;
    i += ch.length;
  }
  return i;
}
// the word the caret ends, from its start
export const wordBefore = (text, caret) => text.slice(wordStart(text, caret), caret);

// Reuse a provider result only while the same word is being typed. Edits by
// collaborators elsewhere in the document cannot be rebased by a caret delta.
export function sameCompletionWord(was, wasCaret, from, text, caret) {
  return caret >= from && text.slice(0, from) === was.slice(0, from)
    && text.slice(caret) === was.slice(wasCaret)
    && !/[^\p{L}\p{N}_$]/u.test(text.slice(from, caret));
}

// where a match may start: the word's first character, after a separator, or a capital after a lower
const boundary = (word, i) => i === 0 || !isWordChar(word[i - 1]) || word[i - 1] === '_' || word[i - 1] === '$'
  || (word[i] !== word[i].toLowerCase() && word[i - 1] === word[i - 1].toLowerCase());

// pattern's characters in order in word, the first at a boundary, as VS Code's fuzzyScore;
// a higher score for a start, boundaries, runs and exact case; null when it doesn't match
export function fuzzyScore(pattern, word) {
  if (!pattern) return { score: 0, matches: [] };
  if (pattern.length > word.length) return null;
  const p = pattern.toLowerCase();
  const w = word.toLowerCase();
  let best = null;
  // each boundary the first character could take, its best greedy run kept
  for (let start = 0; start <= w.length - p.length; start++) {
    if (w[start] !== p[0] || !boundary(word, start)) continue;
    const matches = [start];
    let score = (start === 0 ? 8 : 5) + (word[start] === pattern[0] ? 1 : 0);
    let at = start + 1;
    for (let n = 1; n < p.length; n++) {
      // a boundary or the next character before any other match further on
      let hit = -1;
      for (let i = at; i < w.length; i++) {
        if (w[i] !== p[n]) continue;
        if (i === at || boundary(word, i)) { hit = i; break; }
        if (hit < 0) hit = i;
      }
      if (hit < 0) { score = null; break; }
      score += (hit === at ? 4 : boundary(word, hit) ? 3 : 0) + (word[hit] === pattern[n] ? 1 : 0) - Math.min(3, hit - at);
      matches.push(hit);
      at = hit + 1;
    }
    if (score !== null && (!best || score > best.score)) best = { score, matches };
  }
  return best;
}

// items scored against the typed word, best first, then the provider's own order
export function rankCompletions(items, typed, limit = 200) {
  const ranked = [];
  for (const item of items) {
    const m = fuzzyScore(typed, String(item.filterText || item.label));
    if (m) ranked.push({ item, ...m });
  }
  ranked.sort((a, b) => b.score - a.score || String(a.item.sortText || a.item.label).localeCompare(String(b.item.sortText || b.item.label)) || String(a.item.label).localeCompare(String(b.item.label)));
  return ranked.slice(0, limit);
}

// VS Code's word-based suggestions: every word in the documents, the one at the caret left
// out, as plain text items. The document being typed in is indexed once, as a count of each
// word, and the index moved with each edit by the words of its span alone, so a keystroke
// costs the same in a file of any length; the others' words are kept per text, as they
// rarely change meanwhile.
const WORDS = /[\p{L}_$][\p{L}\p{N}_$]*/gu;
const wordCache = new Map();
function wordsOf(text) {
  let words = wordCache.get(text);
  if (words) { wordCache.delete(text); wordCache.set(text, words); return words; }
  words = new Set();
  for (const [word] of text.matchAll(WORDS)) if (word.length >= 2) words.add(word);
  words = [...words];
  wordCache.set(text, words);
  if (wordCache.size > 16) wordCache.delete(wordCache.keys().next().value);
  return words;
}
const count = (counts, text, d) => { for (const [word] of text.matchAll(WORDS)) if (word.length >= 2) { const n = (counts.get(word) || 0) + d; if (n > 0) counts.set(word, n); else counts.delete(word); } };
// the documents' indexes, the most recently used first
const indexes = [];
const INDEX_EDIT = 256 * 1024;
function indexOf(text) {
  let at = indexes.findIndex((x) => x.text === text);
  if (at < 0) {
    // the index of a text this one was edited from: moved by the edit's words
    at = indexes.findIndex((x) => { const { head, tail } = commonEnds(x.text, text); return Math.max(x.text.length, text.length) - head - tail < INDEX_EDIT; });
    if (at >= 0) {
      const x = indexes[at], { head, tail } = commonEnds(x.text, text);
      const a = wordStart(x.text, head);
      count(x.counts, x.text.slice(a, wordEnd(x.text, x.text.length - tail)), -1);
      count(x.counts, text.slice(a, wordEnd(text, text.length - tail)), 1);
      x.text = text; x.items = null;
    } else {
      const counts = new Map();
      count(counts, text, 1);
      indexes.unshift({ text, counts, items: null, skip: null, docs: [] });
      if (indexes.length > 4) indexes.pop();
      return indexes[0];
    }
  }
  const [x] = indexes.splice(at, 1);
  indexes.unshift(x);
  return x;
}
export function wordCompletions(documents, current, caret, max = 5000) {
  const skip = current.slice(wordStart(current, caret), wordEnd(current, caret));
  const index = indexOf(current);
  // the same list again while the same word's typed and the other documents are as they were
  if (index.items && index.skip === skip && index.docs.length === documents.length && index.docs.every((d, i) => d === documents[i])) return index.items;
  const seen = new Set();
  const add = (word) => { if (word !== skip) seen.add(word); return seen.size >= max; };
  for (const word of index.counts.keys()) if (add(word)) break;
  for (const text of documents) {
    if (seen.size >= max) break;
    for (const word of wordsOf(text)) if (add(word)) break;
  }
  const items = [...seen].map((label) => ({ label, kind: 'word' }));
  Object.assign(index, { items, skip, docs: [...documents] });
  return items;
}

// a snippet as plain text: its placeholders' defaults in, the first tab stop (else $0, else
// the end) the selection; variables left as their defaults or nothing
export function expandSnippet(snippet) {
  let text = '';
  const stops = new Map();
  let i = 0;
  const read = (until) => {
    while (i < snippet.length) {
      const ch = snippet[i];
      if (ch === '\\' && i + 1 < snippet.length && '$}\\,|'.includes(snippet[i + 1])) { text += snippet[i + 1]; i += 2; continue; }
      if (until && ch === until) return;
      if (ch === '$') {
        const simple = snippet.slice(i + 1).match(/^(\d+|[A-Za-z_][A-Za-z0-9_]*)/);
        if (simple) {
          i += 1 + simple[1].length;
          if (/^\d/.test(simple[1])) {
            const prior = stops.get(+simple[1]);
            if (prior) text += text.slice(...prior);
            else stops.set(+simple[1], [text.length, text.length]);
          }
          continue;
        }
        const braced = snippet.slice(i + 1).match(/^\{(\d+|[A-Za-z_][A-Za-z0-9_]*)([:|}])/);
        if (braced) {
          i += 2 + braced[1].length;
          const from = text.length;
          if (braced[2] === ':') { i += 1; read('}'); i += 1; }
          else if (braced[2] === '|') {
            const close = snippet.indexOf('|}', i + 1);
            const choices = snippet.slice(i + 1, close < 0 ? snippet.length : close);
            text += choices.split(',')[0];
            i = close < 0 ? snippet.length : close + 2;
          } else {
            const prior = stops.get(+braced[1]);
            if (/^\d/.test(braced[1]) && prior) text += text.slice(...prior);
            i += 1;
          }
          if (/^\d/.test(braced[1]) && !stops.has(+braced[1])) stops.set(+braced[1], [from, text.length]);
          continue;
        }
      }
      text += ch;
      i += 1;
    }
  };
  read('');
  const first = [...stops.keys()].filter((n) => n > 0).sort((a, b) => a - b)[0];
  const selection = stops.get(first ?? 0) || [text.length, text.length];
  return { text, selection };
}

// whether offset is in a line comment or an unclosed string on its own line, read from the
// text alone (the highlight lags the line being typed); a block comment is the highlight's
const HASH = new Set(['py', 'pyi', 'sh', 'bash', 'zsh', 'rb', 'r', 'pl', 'ps1', 'yml', 'yaml', 'toml', 'conf', 'cfg', 'ini', 'env', 'cmake', 'nix', 'jl', 'ex', 'exs', 'tf', 'hcl', 'makefile', 'dockerfile']);
const DASH = new Set(['lua', 'sql', 'hs']);
export function inCommentOrString(text, offset, ext = '') {
  const line = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
  const comment = HASH.has(ext) ? '#' : DASH.has(ext) ? '--' : '//';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (line.startsWith(comment, i)) return true;
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
  }
  return !!quote;
}

// LSP CompletionItemKind, as a short glyph and a name for its colour
const KINDS = [, 'text', 'method', 'function', 'constructor', 'field', 'variable', 'class', 'interface', 'module', 'property', 'unit', 'value', 'enum', 'keyword', 'snippet', 'color', 'file', 'reference', 'folder', 'enum-member', 'constant', 'struct', 'event', 'operator', 'type-parameter'];
const GLYPHS = { text: 'abc', word: 'abc', method: 'ƒ', function: 'ƒ', constructor: 'ƒ', field: '◇', variable: 'x', class: 'C', interface: 'I', module: '{}', property: '◇', unit: 'u', value: 'v', enum: 'E', keyword: 'k', snippet: '…', color: '◐', file: '▤', reference: '↗', folder: '▸', 'enum-member': 'e', constant: 'π', struct: 'S', event: '⚡', operator: '±', 'type-parameter': 'T' };
export function kindOf(item) {
  const kind = typeof item.kind === 'string' ? item.kind : KINDS[item.kind] || 'text';
  return { kind, glyph: GLYPHS[kind] || 'abc' };
}
