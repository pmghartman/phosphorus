import test from 'node:test';
import assert from 'node:assert/strict';
import { quirksFor, eachSyntaxError } from '../src/syntax-quirks.js';

// the errors the syntax check reports: the grammar's, its gaps left out. The grammars come
// from web/.vendor, with cmd/webbuild/patches.go's fixes put in
async function errors(check, text) {
  const [mod, dialect] = check.split(':');
  const { parser } = await import(`../.vendor/node_modules/@lezer/${mod}/dist/index.js`);
  const p = dialect ? parser.configure({ dialect }) : parser;
  const out = [];
  eachSyntaxError(quirksFor(check), text, p.parse(text), 0, text.length, (n) => out.push(n.from));
  return out;
}

const valid = {
  javascript: [
    // 32+ shorthand properties, then key: value (@lezer/lr's pruning, patched)
    `Object.assign(I, { ${Array.from({ length: 40 }, (_, i) => `p${i}`).join(', ')}, views: new Map(), more: x });`,
    '[a[i], a[j]] = [a[j], a[i]];',
    'x; [a.b, c] = f(1);',
    'if (y) [inflight.ops, r] = g(a, r);',
    '[a, ...b.rest] = list;',
    'const f = ({ a } = {}) => a;',
    'items.map(({ a, b = 2 } = {}) => { return a + b; }).filter(Boolean);',
    'g(([x] = []) => x * 2);',
  ],
  go: [
    'package a\nfunc f() {\n\tx = true\n\ty = false\n\treturn\n}\n',
    'package a\nfunc f() {\n\tif ok, err := g(); err == nil {\n\t\tm["entry"], m["external"] = ok, true\n\t\treturn\n\t}\n}\n',
    'package a\nconst (\n\tNREG = 32 /* number of registers */\n\tNFREG = 32\n)\nfunc f() {\n\tg() /* done */\n\th()\n}\n',
    'package a\nconst _64bit = 1\nvar _386ops = 2\nfunc f() { if _64bit { x = _1 + _x } }\ntype T struct { _1 uint16 }\n',
    'package a\nfunc f() {\n\tfor range 10 {\n\t\tx()\n\t}\n\tfor range b.N {\n\t\ty()\n\t}\n\treturn\n}\n',
  ],
  python: [
    'def f():\n    yield\n    x = 1\n',
    'x = 20.\ny = (24.*3600.)\n',
    'match p:\n    case Point():\n        pass\n',
  ],
  css: [
    'a { box-shadow: 0 5px 20px #0005; color: #abcd; font: 13px/22px var(--font, monospace); }',
    '.list .item:nth-child(even of .item) { color: red }',
  ],
};
for (const [check, list] of Object.entries(valid)) {
  for (const text of list) {
    test(`${check}: no errors in valid ${JSON.stringify(text.slice(0, 50))}`, async () => {
      assert.deepEqual(await errors(check, text), []);
    });
  }
}

const invalid = {
  javascript: ['[1, 2] = x;', 'const = 1;', 'f(({ a } = {}) =>);', 'x = {a: 1, b: };'],
  go: ['package a\nfunc f() {\n\tx := range\n}\n', 'package a\nfunc f() {\n\tx = \n}\n'],
  python: ['def f(:\n    pass\n', 'x = (1,\n'],
  css: ['a { color: #12345; }', 'a { color: red'],
};
for (const [check, list] of Object.entries(invalid)) {
  for (const text of list) {
    test(`${check}: errors still reported in ${JSON.stringify(text.slice(0, 50))}`, async () => {
      assert.ok((await errors(check, text)).length > 0);
    });
  }
}
