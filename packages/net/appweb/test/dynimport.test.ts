import { expect, test } from "bun:test";
import { wrapImports } from "../src/dynimport.ts";

test("dynamic imports wrapped, the rest left alone", () => {
  expect(wrapImports("await import(e)")).toBe("await import(__phosMap(e))");
  expect(wrapImports("import(a, { with: x })")).toBe("import(__phosMap(a), { with: x })");
  expect(wrapImports("import(f(1, 2))")).toBe("import(__phosMap(f(1, 2)))");
  expect(wrapImports("x.import(a); import.meta.url")).toBe("x.import(a); import.meta.url");
  expect(wrapImports('"import(a)"; `${b}`; // import(c)')).toBe('"import(a)"; `${b}`; // import(c)');
  expect(wrapImports("a = /import(x)/.test(s); import(y)")).toBe("a = /import(x)/.test(s); import(__phosMap(y))");
  expect(wrapImports("a = b / 2; c = d / 3; import(z)")).toBe("a = b / 2; c = d / 3; import(__phosMap(z))");
  expect(wrapImports("`${x}`;import(q)")).toBe("`${x}`;import(__phosMap(q))");
  expect(wrapImports("`a${`b${import(u)}`}`")).toBe("`a${`b${import(__phosMap(u))}`}`");
});

test("a method named import left as it is", () => {
  expect(wrapImports("class A{async import(o,e,t){return import(o)}}")).toBe(
    "class A{async import(o,e,t){return import(__phosMap(o))}}",
  );
  expect(wrapImports("x={import(a) {}}")).toBe("x={import(a) {}}");
});
