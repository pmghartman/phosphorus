import { commonEnds } from './text-operations.js';

// One cache per editor. Highlighting, diagnostics and navigation share its tree.
// The tree may cover only the text's start (parseTo: what's on screen first, the rest in
// slices while the page is idle, as CodeMirror parses); parse() always finishes it.
export function createSyntaxCache(TreeFragment) {
  // the text the tree was made for, how far into it the tree reaches, and the tree's pieces
  // kept for the next parse to reuse
  let previous = '', tree = null, grammar = null, reach = 0, fragments = [];
  // the pieces of the last parse moved onto text, through what changed since
  const carried = (parser, text) => {
    if (!tree || grammar !== parser) return [];
    if (previous === text) return fragments;
    const { head: from, tail } = commonEnds(previous, text);
    return TreeFragment.applyChanges(fragments, [{ fromA: from, toA: previous.length - tail, fromB: from, toB: text.length - tail }]);
  };
  const keep = (parser, text, next, upto, carry) => {
    tree = next; previous = text; grammar = parser; reach = upto;
    fragments = TreeFragment.addTree(next, carry, upto < text.length);
    return next;
  };
  return {
    parse(parser, text) {
      if (tree && grammar === parser && previous === text && reach >= text.length) return tree;
      const carry = carried(parser, text);
      return keep(parser, text, parser.parse(text, carry), text.length, carry);
    },
    // a tree reaching at least upto, parsed further while within budget milliseconds (upto 0:
    // a slice of budget alone); complete when it covers the whole text
    parseTo(parser, text, upto, budget) {
      upto = Math.min(upto, text.length);
      if (tree && grammar === parser && previous === text && (reach >= text.length || (reach >= upto && upto > 0))) return { tree, complete: reach >= text.length };
      const carry = carried(parser, text);
      const p = parser.startParse(text, carry);
      const end = performance.now() + budget;
      let done = null;
      // the clock read every few dozen steps: a step is far shorter than a read of it
      for (let n = 0; !(done = p.advance()); n++) if (p.stoppedAt == null && (n & 63) === 0 && p.parsedPos >= upto && performance.now() > end) p.stopAt(p.parsedPos);
      const covered = p.stoppedAt == null ? text.length : Math.min(text.length, p.stoppedAt);
      keep(parser, text, done, covered, carry);
      return { tree, complete: covered >= text.length };
    },
    // the whole tree when it's already been parsed for this text, else null: never parses
    current(parser, text) { return tree && grammar === parser && previous === text && reach >= text.length ? tree : null; },
    clear() { tree = null; grammar = null; previous = ''; reach = 0; fragments = []; },
  };
}
