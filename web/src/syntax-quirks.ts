// Errors a grammar reports in valid code: gaps in the grammar, not in the code. Each is
// known by the tree it leaves, and answered with the offset up to which errors are its
// own (the rest of its statement, where recovery may stumble again); the syntax check
// leaves those out. Found by parsing large bodies of valid code (Go's standard library,
// Python's, npm packages); web/tests/syntax-quirks.test.mjs keeps them.
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common';

// a grammar's gap test: the offset its errors run to, -1 when the node is a real error
export type Quirk = (node: SyntaxNode, text: string) => number;

// the end of the statement holding a node: its errors are the quirk's cascade
function statementEnd(node: SyntaxNode): number {
  let n = node;
  while (n.parent && !/^(Script|SourceFile|Block|Body|ClassBody|StyleSheet|StatementGroup)$/.test(n.parent.name)) n = n.parent;
  return n.to;
}
const lineEnd = (text: string, p: number) => { const e = text.indexOf('\n', p); return e < 0 ? text.length : e; };
// the bracket closing the one at open, strings and comments passed over
function closingOf(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; }
    else if (c === '/' && text[i + 1] === '/') i = lineEnd(text, i);
    else if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 1; }
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return i;
  }
  return text.length;
}
const only = (node: SyntaxNode, name: string) => node.firstChild?.name === name && !node.firstChild.nextSibling;
const textOf = (node: SyntaxNode, text: string) => text.slice(node.from, node.to);

// a parenthesized arrow's parameters with a destructured default, ({ a } = {}) =>, taken
// for a parenthesized assignment
function patternDefault(paren: SyntaxNode | null): boolean {
  for (let c = paren?.firstChild; c; c = c.nextSibling) {
    const list = c.name === 'SequenceExpression' ? [...children(c)] : [c];
    if (list.some((x) => x.name === 'AssignmentExpression' && /Pattern$/.test(x.firstChild?.name || ''))) return true;
  }
  return false;
}
function* children(node: SyntaxNode): Generator<SyntaxNode> { for (let c = node.firstChild; c; c = c.nextSibling) yield c; }
// whether an expression can be assigned to as a destructuring target: names, members, and
// arrays and objects of them (defaults and rest included); [1, 2] = x stays an error
function assignable(node: SyntaxNode | null): boolean {
  switch (node?.name) {
    case 'VariableName': case 'MemberExpression': return true;
    case 'ParenthesizedExpression': return [...children(node)].filter((c) => !/^[()]$/.test(c.name)).every(assignable);
    case 'AssignmentExpression': return assignable(node.firstChild);
    case 'Spread': return assignable(node.lastChild);
    case 'ArrayExpression': return [...children(node)].every((c) => /^([[\],]|Spread)$/.test(c.name) || assignable(c));
    case 'ObjectExpression': return [...children(node)].every((c) => /^[{},]$/.test(c.name) || (c.name === 'Property' && (
      c.lastChild?.name === 'PropertyDefinition' || c.firstChild?.name === 'Spread' || assignable(c.lastChild))));
    default: return false;
  }
}

const javascript: Quirk = (node, text) => {
  const prev = node.prevSibling;
  // [a.b, c[0]] = …: an array (or object) destructured into members
  if (only(node, 'Equals') && /^(ArrayExpression|ObjectExpression)$/.test(prev?.name || '') && assignable(prev)) return statementEnd(node);
  // ({ a } = {}) => …, the arrow's body then taken apart by recovery: its errors to the end of
  // the line where the bracket holding the arrow (or its own block body) closes
  if (only(node, 'Arrow') && prev?.name === 'ParenthesizedExpression' && patternDefault(prev)) {
    const body = node.to + text.slice(node.to).search(/\S|$/);
    if (/^[)\]},;]?$/.test(text[body] || '')) return -1;
    const holder = node.parent && /^(ArgList|ArrayExpression|ObjectExpression|ParenthesizedExpression)$/.test(node.parent.name) ? node.parent.from : text[body] === '{' ? body : -1;
    const close = holder >= 0 ? closingOf(text, holder) : node.to;
    return Math.max(statementEnd(node), lineEnd(text, close));
  }
  // TypeScript's declare module "name" { … }
  if (node.from === node.to && prev?.name === 'module' && node.parent?.name === 'NamespaceDeclaration' && /^["']/.test(text.slice(node.from).trimStart())) {
    let end = statementEnd(node);
    for (let s = node.parent.parent?.nextSibling; s && /^(ExpressionStatement|Block)$/.test(s.name); s = s.nextSibling) { end = s.to; if (s.name === 'Block') break; }
    return end;
  }
  // TypeScript's export { a, type B }
  if (node.parent?.name === 'ExportGroup' && prev?.name === 'VariableName' && textOf(prev, text) === 'type') return node.to;
  return -1;
};

const go: Quirk = (node, text) => {
  const prev = node.prevSibling;
  // for range n { … } (Go 1.22), no variables before range: its block may be taken for a
  // composite literal's (range b.N { … }), the for then missing one where the next line starts
  if (only(node, 'range') && prev?.name === 'for') {
    const loop = node.parent!;
    if (loop?.lastChild?.name === 'Block') return loop.to;
    const next = text.slice(loop.to).search(/\S/);
    return next < 0 ? text.length : loop.to + next + 1;
  }
  // _64bit: a name read as a number with a digit separator
  if (only(node, 'Number') && textOf(node, text).startsWith('_')) return node.to;
  return -1;
};

const python: Quirk = (node, text) => {
  const prev = node.prevSibling;
  // yield on its own
  if (node.from === node.to && prev?.name === 'yield' && node.parent?.name === 'YieldStatement') return node.to;
  // 20. : a float ending at its point
  if (node.from === node.to && prev?.name === '.' && node.parent?.name === 'MemberExpression' && /\d\.$/.test(text.slice(0, node.from)) && prev.prevSibling?.name === 'Number' && prev.prevSibling.to === prev.from) return node.to;
  // case Point(): a class pattern with no arguments
  if (node.from === node.to && node.parent?.name === 'LiteralPattern' && node.parent.parent?.name === 'PatternArgList' && text[node.from] === ')') return node.to;
  return -1;
};

const css: Quirk = (node) => {
  // a pseudo-class's own argument syntax, :nth-child(2n of .item), :is(…)
  for (let n = node.parent; n; n = n.parent) if (n.name === 'ArgList' && n.parent?.name === 'PseudoClassSelector') return n.to;
  return -1;
};

const QUIRKS: Record<string, Quirk> = { javascript, go, python, css };

// each error node of from..to in document order, those a quirk owns left out
export function eachSyntaxError(quirk: Quirk | null | undefined, text: string, tree: Tree, from: number, to: number, fn: (n: SyntaxNodeRef) => void): void {
  let skip = -1;
  tree.iterate({ from, to, enter: (n) => {
    if (!n.type.isError || n.from < skip) return;
    const own = quirk ? quirk(n.node, text) : -1;
    if (own >= 0) { skip = Math.max(own, n.to); return; }
    fn(n);
  } });
}

// the grammar's quirk test for a check name (javascript:ts → javascript's), null if none
export function quirksFor(check: string | null | undefined): Quirk | null {
  return QUIRKS[String(check || '').split(':')[0]!] || null;
}
