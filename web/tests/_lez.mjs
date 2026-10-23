import { highlightTree, tagHighlighter, tags as t } from '../.vendor/node_modules/@lezer/highlight/dist/index.js';
const highlighter = tagHighlighter([{ tag: t.keyword, class: 'k' }, { tag: t.string, class: 's' }, { tag: t.lineComment, class: 'c' }, { tag: t.propertyName, class: 'p' }, { tag: t.number, class: 'n' }, {tag: t.variableName, class: 'v'}]);
export function syntaxRanges(parser, text, tree, from, to) { const r = []; highlightTree(tree, highlighter, (a, b, c) => r.push({ from: a, to: b, cls: c }), from, to); return r; }
