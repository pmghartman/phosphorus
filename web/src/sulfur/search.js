// Keep offsets in the original text: slicing a selection would change ^, $, lookbehind
// and word boundaries. Stop at its end even for a zero-width regular expression.
export function findMatches(text, re, { from = 0, to = text.length, limit = 20000 } = {}) {
  const ranges = [];
  re.lastIndex = from;
  for (let match; ranges.length < limit && (match = re.exec(text));) {
    if (match.index >= to || match.index + match[0].length > to) break;
    if (!match[0].length) {
      const wide = re.unicode && text.codePointAt(re.lastIndex) > 0xffff;
      re.lastIndex += wide ? 2 : 1;
      continue;
    }
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

// Case and whole-word must match the same occurrence, not two different words on
// one line. Unicode marks belong to words too (including decomposed accents).
export function literalSearch(query, { caseSensitive = false, wholeWord = false } = {}) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const word = '[\\p{L}\\p{N}\\p{M}_]';
  return new RegExp(wholeWord ? `(?<!${word})${escaped}(?!${word})` : escaped, caseSensitive ? 'gu' : 'giu');
}
