import { TreeFragment } from '../.vendor/node_modules/@lezer/common/dist/index.js';
import { parser as js } from '../.vendor/node_modules/@lezer/javascript/dist/index.js';
import { parser as cpp } from '../.vendor/node_modules/@lezer/cpp/dist/index.js';
import { parser as py } from '../.vendor/node_modules/@lezer/python/dist/index.js';
import { syntaxRanges, errorPositions } from '../src/lezer.js';
import { rebaseLexical, settleLexical } from '../src/sulfur/stable-highlight.js';
import { createSyntaxCache } from '../src/syntax-cache.js';
const after = 'for (int i = 0; i < 10; i++) { a += i; }\n  return a;\n}\nstruct S { int x; };\nclass K { public: int z; void f(); };\n';
const jsAfter = 'return x.map((y) => y + "s");\n}\nclass B extends C { run() { return 2; } }\nconst z = { a: 1, b: "two" };\n';
const runs = [
  [cpp, `int main() {\n  int a = 1;\n  |\n  ${after}`, 'if (a > 2 && foo(a, '],
  [cpp, `int main() {\n  |\n  ${after}`, 'template <typename T> T f(T a) { if (a'],
  [cpp, `int main() {\n  |\n  ${after}`, 'std::vector<int> v = {1, 2'],
  [cpp, `int main() {\n  |\n  ${after}`, 'auto s = "abc'],
  [js, `function a() {\n  let x = 1;\n  |\n  ${jsAfter}`, 'const q = x.filter(('],
  [js, `function a() {\n  let x = 1;\n  |\n  ${jsAfter}`, 'if (x) { for (const k of '],
  [js, `function a() {\n  let x = 1;\n  |\n  ${jsAfter}`, 'x = a < b'],
  [js, `function a() {\n  let x = 1;\n  |\n  ${jsAfter}`, 'let s = `abc'],
  [py, 'def a():\n    x = 1\n    |\n    return x\n\nclass B:\n    def run(self):\n        return "s"\n', 'if x > (2 and foo(x, '],
];
for (const [parser, tpl, typed] of runs) {
  const at = tpl.indexOf('|'); const base = tpl.replace('|', '');
  const nextLine = (t, p) => t.indexOf('\n', p) + 1;
  const cache = createSyntaxCache(TreeFragment);
  let text = base, tree = cache.parse(parser, text);
  let state = settleLexical(null, syntaxRanges(parser, text, tree), errorPositions(tree, 0, text.length), 0, text.length, text);
  const sig = (r, t, from) => r.filter((x) => x.from >= from).map((x) => `${t.slice(x.from, x.to)}:${x.cls.slice(5)}`).join(' ');
  const baseSig = sig(state.ranges, text, nextLine(text, at));
  let rawChanged = 0, stableChanged = 0;
  for (let n = 1; n <= typed.length; n++) {
    const next = base.slice(0, at) + typed.slice(0, n) + base.slice(at);
    state = rebaseLexical(state, text, next); text = next; tree = cache.parse(parser, text);
    const fresh = syntaxRanges(parser, text, tree);
    state = settleLexical(state, fresh, errorPositions(tree, 0, text.length), 0, text.length, text);
    const from = nextLine(text, at + n);
    if (sig(fresh, text, from) !== baseSig) rawChanged++;
    if (sig(state.ranges, text, from) !== baseSig) stableChanged++;
  }
  console.log(`${JSON.stringify(typed).padEnd(44)} ${typed.length} keys: later lines recolored ${rawChanged}x raw, ${stableChanged}x stabilized`);
}
{
  const [parser, tpl, typed] = runs[1];
  const at = tpl.indexOf('|'); const base = tpl.replace('|', '');
  const cache = createSyntaxCache(TreeFragment);
  let text = base, tree = cache.parse(parser, text);
  let state = settleLexical(null, syntaxRanges(parser, text, tree), errorPositions(tree, 0, text.length), 0, text.length, text);
  const nextLine = (t, p) => t.indexOf('\n', p) + 1;
  const sig = (r, t, from) => r.filter((x) => x.from >= from).map((x) => `${t.slice(x.from, x.to)}:${x.cls.slice(5)}`).join(' ');
  const baseSig = sig(state.ranges, text, nextLine(text, at));
  for (let n = 1; n <= typed.length; n++) {
    const next = base.slice(0, at) + typed.slice(0, n) + base.slice(at);
    state = rebaseLexical(state, text, next); text = next; tree = cache.parse(parser, text);
    const fresh = syntaxRanges(parser, text, tree);
    const errs = errorPositions(tree, 0, text.length);
    state = settleLexical(state, fresh, errs, 0, text.length, text);
    const s2 = sig(state.ranges, text, nextLine(text, at + n));
    if (s2 !== baseSig) { console.log(n, JSON.stringify(typed.slice(0, n)), 'dirty', state.dirty, 'errs', errs, 'known', state.errors); console.log(' base', baseSig); console.log(' got ', s2); break; }
  }
}
