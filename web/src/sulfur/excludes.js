// files.exclude and search.exclude patterns as people write them, VS Code's included:
//   node_modules      a file or folder with that name
//   *.o, test_?.py    a name glob; {a,b} alternatives
//   .meta             a dotted name: that file or folder, and files ending in it (*.meta)
//   **/*.meta, out/   VS Code's forms: the leading **/ and a trailing / or /** read as the name
//   build/out         a path: those segments together, anywhere in a path
// A trailing / matches folders only.

// wildcards held as placeholders while braces expand, so neither rewrites the other's regex
const toRegex = (glob) => glob
  .replace(/[.+^$()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '\u0000').replace(/\*/g, '\u0001').replace(/\?/g, '\u0002')
  .replace(/\{([^{}]*)\}/g, (_, alts) => `(?:${alts.split(',').join('|')})`)
  .replace(/\u0000/g, '.*').replace(/\u0001/g, '[^/]*').replace(/\u0002/g, '[^/]');

function compile(raw) {
  let g = raw.trim();
  if (!g || g.startsWith('!')) return null;
  g = g.replace(/^(\*\*\/)+/, '').replace(/^\.\//, '');
  const dirOnly = /\/(\*\*)?$/.test(g);
  g = g.replace(/\/(\*\*)?$/, '');
  if (!g) return null;
  if (g.includes('/')) {
    const re = new RegExp(`(^|/)${toRegex(g)}($|/)`);
    return { path: (p) => re.test(p) };
  }
  const re = new RegExp(`^${toRegex(g)}$`);
  // .meta, .pyc: a bare dotted extension also matches files ending in it
  const ext = /^\.[^.*?{}[\]]+$/.test(g) ? g : '';
  return { name: (n, dir) => (!dirOnly || dir) && (re.test(n) || (!dir && !!ext && n.length > ext.length && n.endsWith(ext))) };
}

// test(name, dir) whether a file or folder of that name is excluded; test.path(rel) whether
// a relative path is, by any of its folders, its name, or a path pattern
export function excludeMatcher(raw) {
  // split on the commas between patterns, not those inside {a,b}
  const parts = [];
  let depth = 0, at = 0;
  const text = String(raw || '');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth = Math.max(0, depth - 1);
    else if (text[i] === ',' && !depth) { parts.push(text.slice(at, i)); at = i + 1; }
  }
  parts.push(text.slice(at));
  const rules = parts.map(compile).filter(Boolean);
  const names = rules.filter((r) => r.name), paths = rules.filter((r) => r.path);
  const test = (name, dir = false) => names.some((r) => r.name(name, dir));
  test.path = (rel) => {
    const segs = String(rel).replace(/\/$/, '').split('/');
    return segs.some((s, i) => test(s, i < segs.length - 1)) || paths.some((r) => r.path(segs.join('/')));
  };
  return test;
}
