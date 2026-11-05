// an app script's dynamic import() calls wrapped, import(x) as import(__phosMap(x)), so a
// specifier in the app's own scheme loads from the server: the one URL sink a page can't
// patch. A tokenizer, not a parser: strings, templates, comments and regexes skipped whole

// identifier characters by code: letters, _, $, anything past ascii; digits after the first
const isIdStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
const isIdPart = (c: number) => isIdStart(c) || (c >= 48 && c <= 57);
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13 || c === 0xa0 || c === 0xfeff;
// after these words a slash starts a regex
const regexAfterWord = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

export const needsWrap = (src: string) => /\bimport\s*\(/.test(src);

export function wrapImports(src: string, fn = "__phosMap"): string {
  const n = src.length;
  const out: string[] = [];
  let last = 0;
  // the open parens; an import( call's carries where its wrap went in, undone for a
  // method named import, whose parens a body follows
  type Wrap = { open: number; close: number };
  const parens: (Wrap | null)[] = [];
  // template literals: the brace depth their ${ opened at
  const tmpl: number[] = [];
  let braces = 0;
  // what came before, for a slash: "word:<w>", "id", "num", ")", "]", "}", "op"
  let prev = "op";
  let i = 0;
  const readTemplate = (): void => {
    // from inside a template, to its end or a ${
    while (i < n) {
      const c = src[i]!;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        i++;
        prev = "id";
        return;
      }
      if (c === "$" && src[i + 1] === "{") {
        i += 2;
        braces++;
        tmpl.push(braces);
        prev = "op";
        return;
      }
      i++;
    }
  };
  while (i < n) {
    const c = src[i]!;
    const cc = src.charCodeAt(i);
    if (isSpace(cc)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      const e = src.indexOf("\n", i);
      i = e < 0 ? n : e;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c) {
        if (src[i] === "\\") i++;
        else if (src[i] === "\n") break;
        i++;
      }
      i++;
      prev = "id";
      continue;
    }
    if (c === "`") {
      i++;
      readTemplate();
      continue;
    }
    if (c === "/") {
      const regex = prev === "op" || (prev.startsWith("word:") && regexAfterWord.has(prev.slice(5)));
      if (regex) {
        i++;
        let cls = false;
        while (i < n) {
          const d = src[i]!;
          if (d === "\\") {
            i += 2;
            continue;
          }
          if (d === "\n") break;
          if (cls) {
            if (d === "]") cls = false;
          } else if (d === "[") cls = true;
          else if (d === "/") break;
          i++;
        }
        i++;
        while (i < n && isIdPart(src.charCodeAt(i))) i++;
        prev = "id";
        continue;
      }
      i++;
      prev = "op";
      continue;
    }
    if (isIdStart(cc)) {
      const s = i;
      while (i < n && isIdPart(src.charCodeAt(i))) i++;
      const w = src.slice(s, i);
      if (w === "import") {
        // a call, not import.meta, not obj.import(
        let j = i;
        while (j < n && isSpace(src.charCodeAt(j))) j++;
        let k = s - 1;
        while (k >= 0 && isSpace(src.charCodeAt(k))) k--;
        if (src[j] === "(" && src[k] !== ".") {
          out.push(src.slice(last, j + 1), `${fn}(`);
          parens.push({ open: out.length - 1, close: -1 });
          last = j + 1;
          i = j + 1;
          prev = "op";
          continue;
        }
      }
      prev = `word:${w}`;
      continue;
    }
    if (cc >= 48 && cc <= 57) {
      while (i < n && (isIdPart(src.charCodeAt(i)) || src.charCodeAt(i) === 46)) i++;
      prev = "num";
      continue;
    }
    if (c === "(") {
      parens.push(null);
      i++;
      prev = "op";
      continue;
    }
    if (c === ")") {
      const w = parens.pop();
      if (w) {
        let j = i + 1;
        while (j < n && isSpace(src.charCodeAt(j))) j++;
        if (src[j] === "{") {
          out[w.open] = "";
          if (w.close >= 0) out[w.close] = "";
        } else if (w.close < 0) {
          out.push(src.slice(last, i), ")");
          last = i;
        }
      }
      i++;
      prev = ")";
      continue;
    }
    if (c === "{") {
      braces++;
      i++;
      prev = "op";
      continue;
    }
    if (c === "}") {
      if (tmpl.length && tmpl[tmpl.length - 1] === braces) {
        tmpl.pop();
        braces--;
        i++;
        readTemplate();
        continue;
      }
      braces--;
      i++;
      prev = "}";
      continue;
    }
    if (c === "]") {
      i++;
      prev = "]";
      continue;
    }
    // a comma inside import(a, opts): the wrap closes before the options
    const top = parens[parens.length - 1];
    if (c === "," && top && top.close < 0) {
      out.push(src.slice(last, i), ")");
      top.close = out.length - 1;
      last = i;
      i++;
      prev = "op";
      continue;
    }
    i++;
    prev = "op";
  }
  if (!out.length) return src;
  out.push(src.slice(last));
  return out.join("");
}
