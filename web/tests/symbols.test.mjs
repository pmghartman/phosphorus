import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSymbols, enclosingSymbol, identifierAt } from '../src/symbols.js';

async function analyze(lang, text) {
  const { parser } = await import(`../.vendor/node_modules/@lezer/${lang}/dist/index.js`);
  return analyzeSymbols(parser, text);
}

for (const [lang, source, type, method, field] of [
  ['cpp', 'class Cat { int age; public: void run(int n) { int x = n; } }; int main() {}', 'Cat', 'run', 'age'],
  ['javascript', 'class Cat { age = 2; run(n) { let x = n; } } function main() {}', 'Cat', 'run', 'age'],
  ['java', 'class Cat { int age; void run(int n) { int x = n; } }', 'Cat', 'run', 'age'],
  ['python', 'class Cat:\n    age = 2\n    def run(self, n):\n        x = n\n', 'Cat', 'run', 'age'],
  ['go', 'package main; type Cat struct { Age int }; func (c *Cat) Run(n int) { x := n }', 'Cat', 'Run', 'Age'],
  ['rust', 'struct Cat { age: i32 } impl Cat { fn run(&self, n: i32) { let x = n; } }', 'Cat', 'run', 'age'],
]) {
  test(`${lang}: types, methods and fields have source ranges`, async () => {
    const data = await analyze(lang, source);
    for (const [name, kind] of [[type, 'type'], [method, 'method'], [field, 'field']]) {
      const symbol = data.symbols.find((s) => s.name === name && s.kind === kind);
      assert.ok(symbol, `${name} (${kind}): ${JSON.stringify(data.symbols.map((s) => [s.name, s.kind]))}`);
      assert.equal(source.slice(symbol.from, symbol.to), name);
    }
    assert.ok(!data.symbols.some((s) => s.name === 'n'), 'parameters are not navigation entries');
  });
}

test('identifier matches exclude comments, strings and partial names', async () => {
  const source = 'int count; // count\nconst char* s = "count"; int counter; int f() { return count; }';
  const data = await analyze('cpp', source);
  assert.equal(data.tokens.filter((t) => t.name === 'count').length, 2);
});

test('the current method and type follow the caret, with locals scoped to methods', async () => {
  const source = 'class Cat { int age; void run() { int x; x = age; } };';
  const { symbols } = await analyze('cpp', source);
  const at = source.indexOf('x =');
  assert.equal(enclosingSymbol(symbols, at, 'type').name, 'Cat');
  assert.equal(enclosingSymbol(symbols, at).name, 'run');
  assert.equal(symbols.find((s) => s.name === 'x').owner.name, 'run');
});

test('identifier selection includes underscores and Unicode, and handles EOF', () => {
  assert.deepEqual(identifierAt('x café_name', 7), { name: 'café_name', from: 2, to: 11 });
  assert.equal(identifierAt('count', 5).name, 'count');
  assert.equal(identifierAt('123', 1), null);
  assert.equal(identifierAt('()', 0), null);
});
