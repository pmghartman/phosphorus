// Highlighted ranges drawn as html: sorted, disjoint {from, to, cls} ranges over a text.
// Shared by the desktop's highlighter (lezer.ts) and the editor, so neither reaches
// into the other's code.

export interface Range { from: number; to: number; cls: string; stale?: boolean }

const escape = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
// the first range ending after offset, by bisection: ranges are sorted and disjoint
export function rangeIndex(ranges: Range[], offset: number): number {
  let lo = 0, hi = ranges.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (ranges[mid]!.to <= offset) lo = mid + 1; else hi = mid; }
  return lo;
}
// the class drawn at offset, '' where nothing is
export function classAt(ranges: Range[], offset: number): string {
  const range = ranges[rangeIndex(ranges, offset)];
  return range && range.from <= offset ? range.cls : '';
}
// text from..to as highlighted html: semantic classes over syntax ones, except inside
// comments, strings and regexps, whose lexical class always wins
export function highlightRanges(text: string, syntax: Range[] = [], semantic: Range[] = [], start = 0, end = text.length): string {
  const html: string[] = [];
  let a = rangeIndex(syntax, start), b = rangeIndex(semantic, start), from = start, active = '';
  const emit = (to: number) => {
    if (to > start) {
      const content = escape(text.slice(start, to));
      html.push(active ? `<span class="${active}">${content}</span>` : content);
    }
    start = to;
  };
  while (from < end) {
    while (a < syntax.length && syntax[a]!.to <= from) a++;
    while (b < semantic.length && semantic[b]!.to <= from) b++;
    const sa = syntax[a], sb = semantic[b];
    const to = Math.min(end, sa ? sa.from > from ? sa.from : sa.to : end, sb ? sb.from > from ? sb.from : sb.to : end);
    const lexical = sa && sa.from <= from ? sa.cls : '';
    const cls = /hljs-(comment|string|regexp)/.test(lexical) || (sb?.stale && /hljs-(keyword|literal|type|number)/.test(lexical)) ? lexical : sb && sb.from <= from ? sb.cls : lexical;
    if (cls !== active) { emit(from); active = cls; }
    from = to;
  }
  emit(end);
  return html.join('');
}
