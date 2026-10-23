// One cache per editor. Highlighting, diagnostics and navigation share its tree.
export function createSyntaxCache(TreeFragment) {
  let previous = '', tree = null, grammar = null;
  return {
    parse(parser, text) {
      if (tree && grammar === parser && previous === text) return tree;
      let fragments = [];
      if (tree && grammar === parser) {
        let from = 0, tail = 0;
        while (from < previous.length && from < text.length && previous[from] === text[from]) from++;
        while (tail < previous.length - from && tail < text.length - from && previous[previous.length - 1 - tail] === text[text.length - 1 - tail]) tail++;
        fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [{ fromA: from, toA: previous.length - tail, fromB: from, toB: text.length - tail }]);
      }
      tree = parser.parse(text, fragments); previous = text; grammar = parser;
      return tree;
    },
    clear() { tree = null; grammar = null; previous = ''; },
  };
}
