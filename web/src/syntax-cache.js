import { commonEnds } from './text-operations.js';

// One cache per editor. Highlighting, diagnostics and navigation share its tree.
export function createSyntaxCache(TreeFragment) {
  let previous = '', tree = null, grammar = null;
  return {
    parse(parser, text) {
      if (tree && grammar === parser && previous === text) return tree;
      let fragments = [];
      if (tree && grammar === parser) {
        const { head: from, tail } = commonEnds(previous, text);
        fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: previous.length - tail, fromB: from, toB: text.length - tail }]);
      }
      tree = parser.parse(text, fragments); previous = text; grammar = parser;
      return tree;
    },
    // the tree when it's already been parsed for this text, else null: never parses
    current(parser, text) { return tree && grammar === parser && previous === text ? tree : null; },
    clear() { tree = null; grammar = null; previous = ''; },
  };
}
