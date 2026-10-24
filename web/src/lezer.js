// the editor's parsers: syntax errors by a parse alone and highlighting off the
// same tree, under highlight.js's class names the stylesheet already colours;
// each grammar its own chunk, fetched on first use

import { highlightTree, tagHighlighter, tags as t } from '@lezer/highlight';
import { TreeFragment } from '@lezer/common';
import { createSyntaxCache } from './syntax-cache.js';
import { highlightRanges } from './highlight-ranges.js';
import { quirksFor, eachSyntaxError } from './syntax-quirks.js';
export const syntaxCache = () => createSyntaxCache(TreeFragment);

const GRAMMARS = {
  javascript: () => import('@lezer/javascript'),
  python: () => import('@lezer/python'),
  json: () => import('@lezer/json'),
  css: () => import('@lezer/css'),
  html: () => import('@lezer/html'),
  xml: () => import('@lezer/xml'),
  rust: () => import('@lezer/rust'),
  cpp: () => import('@lezer/cpp'),
  java: () => import('@lezer/java'),
  go: () => import('@lezer/go'),
  php: () => import('@lezer/php'),
  yaml: () => import('@lezer/yaml'),
};

const parsers = new Map();
const ready = new Map();
// a parser's grammar gaps (syntax-quirks.js), and the grammars whose errors aren't reported,
// valid code too often read as wrong: C and C++ through a preprocessor a grammar can't see,
// and TypeScript, whose grammar here lacks much of the language (call and index signatures,
// type predicates, declare global); their language servers report them instead
const quirkOf = new WeakMap();
const unchecked = new WeakSet();
const UNCHECKED = /^cpp$|^javascript:(.* )?ts$/;

// the parser for a check name (javascript:jsx ts), null when there's none
export function parserFor(check) {
  if (!check) return Promise.resolve(null);
  const [mod, dialect] = check.split(':');
  if (!parsers.has(check)) {
    const load = GRAMMARS[mod];
    parsers.set(check, (load ? load() : Promise.resolve(null))
      .then((m) => {
        const p = m ? (dialect ? m.parser.configure({ dialect }) : m.parser) : null;
        if (p && quirksFor(check)) quirkOf.set(p, quirksFor(check));
        if (p && UNCHECKED.test(check)) unchecked.add(p);
        ready.set(check, p);
        return p;
      }).catch(() => null));
  }
  return parsers.get(check);
}

// already loaded, else null (and the load started)
export function parserNow(check) {
  if (!check) return null;
  if (ready.has(check)) return ready.get(check);
  parserFor(check);
  return null;
}

const highlighter = tagHighlighter([
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], class: 'hljs-keyword' },
  { tag: [t.string, t.special(t.string), t.character, t.docString], class: 'hljs-string' },
  { tag: t.regexp, class: 'hljs-regexp' },
  { tag: [t.number, t.integer, t.float], class: 'hljs-number' },
  { tag: [t.bool, t.null, t.atom, t.unit], class: 'hljs-literal' },
  { tag: [t.lineComment, t.blockComment, t.comment, t.docComment], class: 'hljs-comment' },
  { tag: [t.function(t.variableName), t.function(t.definition(t.variableName)), t.definition(t.function(t.variableName))], class: 'hljs-title' },
  { tag: [t.className, t.definition(t.className), t.namespace], class: 'hljs-title' },
  { tag: [t.typeName, t.standard(t.typeName)], class: 'hljs-type' },
  { tag: [t.standard(t.variableName), t.self, t.special(t.variableName)], class: 'hljs-built_in' },
  { tag: [t.propertyName, t.attributeName, t.labelName], class: 'hljs-attr' },
  { tag: [t.tagName, t.angleBracket], class: 'hljs-tag' },
  { tag: [t.meta, t.processingInstruction, t.annotation], class: 'hljs-meta' },
  { tag: t.heading, class: 'hljs-section' },
  { tag: t.emphasis, class: 'hljs-emphasis' },
  { tag: t.strong, class: 'hljs-strong' },
  { tag: t.inserted, class: 'hljs-addition' },
  { tag: t.deleted, class: 'hljs-deletion' },
]);

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

// the tree's highlight classes as ranges, of from..to only when given: the editor
// asks for what's on screen, so a keystroke costs the same in any size of file
export function syntaxRanges(parser, text, tree = parser.parse(text), from = 0, to = text.length) {
  const ranges = [];
  highlightTree(tree, highlighter, (a, b, cls) => ranges.push({ from: a, to: b, cls }), from, to);
  return ranges;
}
// where the tree's error nodes start within from..to
export function errorPositions(tree, from, to, parser = null, text = '') {
  const out = [];
  eachSyntaxError(parser && quirkOf.get(parser), text, tree, from, to, (n) => { if (out.length < ERR_MAX * 4) out.push(n.from); });
  return out;
}
export function highlight(parser, text, tree = parser.parse(text), semantic = []) {
  if (semantic.length) {
    const ranges = [];
    highlightTree(tree, highlighter, (from, to, cls) => ranges.push({ from, to, cls }));
    return highlightRanges(text, ranges, semantic);
  }
  let out = '';
  let at = 0;
  highlightTree(tree, highlighter, (from, to, cls) => {
    if (from > at) out += escape(text.slice(at, from));
    out += `<span class="${cls}">${escape(text.slice(from, to))}</span>`;
    at = to;
  });
  if (at < text.length) out += escape(text.slice(at));
  return out;
}

export const ERR_MAX = 50;
export function syntaxErrors(parser, text, tree = parser.parse(text)) {
  const out = [];
  if (unchecked.has(parser)) return out;
  eachSyntaxError(quirkOf.get(parser), text, tree, 0, text.length, (n) => {
    if (out.length >= ERR_MAX) return;
    const near = n.to > n.from ? text.slice(n.from, n.to) : (text.slice(n.from).match(/^\s*(\S{1,16})/) || [])[1];
    const what = near ? `unexpected ${near.trim().slice(0, 24)}` : 'unexpected end of file';
    if (!out.some((e) => e.from === n.from)) out.push({ from: n.from, to: n.to, what });
  });
  return out;
}
