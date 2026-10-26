// TextMate grammars, as VS Code tokenizes with them: what a converted VS Code
// extension (internal/sulfur/vsx_convert.go) brings for a language the page has no
// Lezer parser for. A line at a time, each line's tokens from the state the line
// before left (the rules open across lines), scopes drawn under the hljs classes
// the themes color. Oniguruma's patterns become JavaScript's: what can't
// (conditionals, absent operators, \K) leaves its rule out, never the grammar.

// --- Oniguruma to JavaScript ---------------------------------------------------------

// \G and \A held as private-use characters until a line's anchor is known
const G_MARK = '', A_MARK = '';
const SYNTAX = new Set('^$\\.*+?()[]{}|/'.split(''));
const POSIX = {
  alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t',
  xdigit: '0-9a-fA-F', word: '\\w', punct: '!-\\/:-@\\[-`{-~', cntrl: '\\x00-\\x1f\\x7f', print: '\\x20-\\x7e', graph: '\\x21-\\x7e', ascii: '\\x00-\\x7f',
};
const PROPS = { Alpha: 'Alphabetic', Alnum: 'Alphabetic}\\p{Nd', Digit: 'Nd', Upper: 'Uppercase', Lower: 'Lowercase', Space: 'White_Space', Punct: 'P', Word: 'L}\\p{N}\\p{Pc', Cntrl: 'Cc', Graph: 'L}\\p{M}\\p{N}\\p{P}\\p{S', Print: 'L}\\p{M}\\p{N}\\p{P}\\p{S}\\p{Zs', XDigit: 'Hex_Digit', Blank: 'Zs' };
const hex2 = (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`;
const lit = (c) => (c.charCodeAt(0) > 0x7f ? c : /[A-Za-z0-9_\s]/.test(c) ? c : SYNTAX.has(c) ? `\\${c}` : hex2(c));
const unicodeProp = (name) => {
  const n = name.replace(/^\^/, '');
  const mapped = PROPS[n] || (/^In_?/.test(n) ? null : n);
  if (!mapped) throw new Error(`\\p{${name}}`);
  const p = mapped.includes('}') ? mapped : /^[A-Z][a-z]+$/.test(mapped) && !['Alphabetic', 'Uppercase', 'Lowercase'].includes(mapped) && mapped.length > 2 ? `Script=${mapped}` : mapped;
  return { neg: name.startsWith('^'), body: `\\p{${p}}` };
};

// an Oniguruma pattern as a JavaScript one: { source, flags, anchored }
export function onigToJS(pattern) {
  const s = String(pattern);
  let out = '', i = 0, flags = '', extended = false, anchored = false;
  // a global flag at the very start, (?i) and (?x)
  for (let m; (m = /^\(\?([imx]+)\)/.exec(s.slice(i)));) {
    if (m[1].includes('i')) flags += 'i';
    if (m[1].includes('x')) extended = true;
    i += m[0].length;
  }
  let quantified = false;
  const escape = (inClass) => {
    const c = s[i + 1];
    i += 2;
    if (c === undefined) return '\\\\';
    switch (c) {
      case 'h': return inClass ? '0-9a-fA-F' : '[0-9a-fA-F]';
      case 'H': return inClass ? '\\x00-\\x2f\\x3a-\\x40\\x47-\\x60\\x67-\\uffff' : '[^0-9a-fA-F]';
      case 'A': if (inClass) throw new Error('\\A in a class'); anchored = true; return A_MARK;
      case 'G': if (inClass) throw new Error('\\G in a class'); anchored = true; return G_MARK;
      case 'z': return '(?![\\s\\S])';
      case 'Z': return '(?=\\n?(?![\\s\\S]))';
      case 'e': return '\\x1b';
      case 'a': return '\\x07';
      case 'R': return '(?:\\r\\n|[\\n\\v\\f\\r\\u0085\\u2028\\u2029])';
      case 'X': return '[\\s\\S]';
      case 'K': case 'g': case 'y': case 'Y': case 'O': case 'N': throw new Error(`\\${c}`);
      case 'x': {
        const m = /^\{([0-9a-fA-F]+)\}/.exec(s.slice(i));
        if (m) { i += m[0].length; return `\\u{${m[1]}}`; }
        const h = /^[0-9a-fA-F]{1,2}/.exec(s.slice(i));
        if (h) { i += h[0].length; return `\\x${h[0].padStart(2, '0')}`; }
        return 'x';
      }
      case 'p': case 'P': {
        const m = /^\{(\^?[\w ]+)\}/.exec(s.slice(i));
        if (!m) return c;
        i += m[0].length;
        const { neg, body } = unicodeProp(m[1].replace(/ /g, '_'));
        const negate = neg !== (c === 'P');
        if (inClass) { if (negate) throw new Error('a negated property in a class'); return body.replace(/^\\p\{/, '\\p{'); }
        return negate ? `[^${body}]` : body.includes('}\\p{') ? `[${body}]` : body;
      }
      case 'Q': {
        const end = s.indexOf('\\E', i);
        const text = end < 0 ? s.slice(i) : s.slice(i, end);
        i = end < 0 ? s.length : end + 2;
        return [...text].map(lit).join('');
      }
      case 'k': {
        const m = /^<(\w+)>/.exec(s.slice(i));
        if (m) { i += m[0].length; return /^\d+$/.test(m[1]) ? `\\${m[1]}` : `\\k<${m[1]}>`; }
        return 'k';
      }
      case '0': {
        const m = /^[0-7]{0,2}/.exec(s.slice(i));
        i += m[0].length;
        return `\\x${parseInt(m[0] || '0', 8).toString(16).padStart(2, '0')}`;
      }
      default:
        if (/[1-9]/.test(c)) {
          // a backreference, or an octal escape Oniguruma reads as one when no group is that big
          const m = /^\d*/.exec(s.slice(i));
          i += m[0].length;
          return `\\${c}${m[0]}`;
        }
        if (/[dDwWsSbBnrtfv]/.test(c)) return c === 'b' && inClass ? '\\x08' : `\\${c}`;
        if (c === '-' && inClass) return '\\-';
        return lit(c);
    }
  };
  const klass = () => {
    // [ ... ] with POSIX brackets, nested classes flattened; && refused
    let body = '';
    i++;
    if (s[i] === '^') { body += '^'; i++; }
    if (s[i] === ']') { body += '\\]'; i++; }
    let depth = 0;
    // what came last: nothing ('start'), a set (\s, [:alpha:], a nested class) or one character;
    // a - is a range only between two characters, else Oniguruma's literal -
    let last = 'start';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\') {
        const e = escape(true);
        body += e;
        last = last === 'range' || (e.length > 2 && !/^\\(x|u)/.test(e)) || /^\\[dDwWsS]$/.test(e) || /^\\p\{/.test(e) ? 'set' : 'char';
        continue;
      }
      if (c === '[') {
        const posix = /^\[:(\^?)(\w+):\]/.exec(s.slice(i));
        if (posix) {
          if (posix[1] || !POSIX[posix[2]]) throw new Error(`[:${posix[2]}:]`);
          body += POSIX[posix[2]]; i += posix[0].length; last = 'set'; continue;
        }
        if (s[i + 1] === '^') throw new Error('a negated nested class');
        depth++; i++; last = 'start'; continue;
      }
      if (c === '&' && s[i + 1] === '&') throw new Error('class intersection');
      if (c === ']') { i++; if (depth === 0) return `[${body}]`; depth--; last = 'set'; continue; }
      if (c === '-') {
        const range = last === 'char' && s[i + 1] !== ']' && s[i + 1] !== '[' && s[i + 1] !== undefined;
        body += range ? '-' : '\\-';
        i++;
        last = range ? 'range' : 'char';
        continue;
      }
      body += c === '/' ? '\\/' : c;
      // the end of a range is no range's start
      last = last === 'range' ? 'set' : 'char';
      i++;
    }
    throw new Error('an unclosed class');
  };
  while (i < s.length) {
    const c = s[i];
    if (extended && /\s/.test(c)) { i++; continue; }
    if (extended && c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    // a possessive quantifier taken as a greedy one
    if (c === '+' && quantified) { quantified = false; i++; continue; }
    quantified = false;
    if (c === '\\') { out += escape(false); continue; }
    if (c === '[') { out += klass(); continue; }
    if (c === '(') {
      if (s[i + 1] !== '?') { out += '('; i++; continue; }
      const rest = s.slice(i + 2);
      if (rest[0] === '#') { const end = s.indexOf(')', i); i = end < 0 ? s.length : end + 1; continue; }
      if (rest[0] === '>') { out += '(?:'; i += 3; continue; }
      if (/^(?:[:=!]|<[=!]|<\w+>|P<\w+>)/.test(rest)) {
        const m = /^(?:[:=!]|<[=!]|<\w+>|P<\w+>)/.exec(rest)[0];
        out += `(?${m.replace(/^P/, '')}`; i += 2 + m.length; continue;
      }
      if (rest[0] === "'") {
        const m = /^'(\w+)'/.exec(rest);
        if (m) { out += `(?<${m[1]}>`; i += 2 + m[0].length; continue; }
      }
      const mod = /^([imx]*)(?:-([imx]*))?(:|\))/.exec(rest);
      if (mod) {
        // inline options: case folding for the rest of the pattern when turned on; others ignored
        if (mod[1].includes('i') && !flags.includes('i')) flags += 'i';
        if (mod[1].includes('x')) extended = true;
        if (mod[2]?.includes('x')) extended = false;
        out += mod[3] === ':' ? '(?:' : '';
        i += 2 + mod[0].length;
        continue;
      }
      throw new Error(`(?${rest.slice(0, 2)}`);
    }
    if (c === '{') {
      const m = /^\{(\d*)(,?)(\d*)\}/.exec(s.slice(i));
      if (m && (m[1] || m[3])) { out += `{${m[1] || '0'}${m[2]}${m[3]}}`; i += m[0].length; quantified = true; continue; }
      out += '\\{'; i++; continue;
    }
    if (c === '}' || c === ']') { out += `\\${c}`; i++; continue; }
    if (c === '*' || c === '+' || c === '?') {
      out += c; i++;
      // a lazy quantifier keeps its ?, a possessive's + is dropped above
      if (s[i] === '?' && c !== '?') { out += '?'; i++; } else if (c === '?' && s[i] === '?') { out += '?'; i++; }
      quantified = true;
      continue;
    }
    if (c === '/') { out += '\\/'; i++; continue; }
    out += c; i++;
  }
  return { source: out, flags, anchored };
}

// a compiled pattern: its RegExp, or its variants for an anchor (\G at the anchor, \A on the first line)
const failed = new Map();
function compile(pattern) {
  if (failed.has(pattern)) return null;
  try {
    const t = onigToJS(pattern);
    const make = (src) => new RegExp(src, `dgmu${t.flags}`);
    if (!t.anchored) return { re: make(t.source) };
    const variants = new Map();
    return {
      anchored: true,
      at(anchor, first) {
        const key = `${anchor}:${first}`;
        let re = variants.get(key);
        if (!re) {
          re = make(t.source.split(G_MARK).join(anchor < 0 ? '(?!)' : `(?<=^[\\s\\S]{${anchor}})`).split(A_MARK).join(first ? '(?<![\\s\\S])' : '(?!)'));
          if (variants.size > 64) variants.clear();
          variants.set(key, re);
        }
        return re;
      },
    };
  } catch (err) {
    failed.set(pattern, String(err?.message || err));
    if (failed.size > 4096) failed.clear();
    return null;
  }
}
export const unsupportedPatterns = () => [...failed];

// --- grammars -----------------------------------------------------------------------------

// a grammar ready to tokenize, its rules compiled as they're first reached. lookup(scopeName)
// is another grammar's json, for includes of other languages (null when there's none)
export function createGrammar(raw, lookup = () => null) {
  const grammars = new Map();
  let nextId = 1;
  const ruleCache = new WeakMap();
  function load(json) {
    if (!json || typeof json !== 'object') return null;
    const scope = json.scopeName || 'source';
    if (grammars.has(scope)) return grammars.get(scope);
    const g = { scopeName: scope, json, root: null };
    grammars.set(scope, g);
    g.root = rule({ patterns: json.patterns || [] }, g, [json.repository || {}]);
    return g;
  }
  // a captures object with each capture's own patterns compiled when first used
  function capturesOf(caps, g, repos) {
    const out = {};
    for (const [k, v] of Object.entries(caps || {})) {
      if (!v || typeof v !== 'object') continue;
      let kids = null;
      out[k] = { name: typeof v.name === 'string' ? v.name : '', rules: Array.isArray(v.patterns) ? () => (kids ||= flatten(v.patterns, g, repos, new Set())) : null };
    }
    return out;
  }
  // a rule: { id, match | begin with endSource or whileSource, name, contentName, captures, children() }
  function rule(json, g, repos) {
    const own = json.repository ? [json.repository, ...repos] : repos;
    const r = { id: nextId++, name: typeof json.name === 'string' ? json.name : '', contentName: typeof json.contentName === 'string' ? json.contentName : '' };
    if (typeof json.match === 'string') r.match = compile(json.match);
    if (typeof json.begin === 'string') {
      r.begin = compile(json.begin);
      if (typeof json.while === 'string') r.whileSource = json.while;
      // a begin without an end runs to the end of the file, as VS Code's does
      else r.endSource = typeof json.end === 'string' ? json.end : '￿';
      r.endLast = !!json.applyEndPatternLast;
    }
    r.captures = capturesOf(json.captures, g, own);
    r.beginCaptures = json.beginCaptures ? capturesOf(json.beginCaptures, g, own) : r.captures;
    r.endCaptures = json.endCaptures ? capturesOf(json.endCaptures, g, own) : r.captures;
    r.whileCaptures = json.whileCaptures ? capturesOf(json.whileCaptures, g, own) : r.captures;
    let kids = null;
    r.children = () => (kids ||= flatten(json.patterns || [], g, own, new Set()));
    return r;
  }
  function ruleOf(json, g, repos) {
    let byG = ruleCache.get(json);
    if (!byG) ruleCache.set(json, byG = new Map());
    if (!byG.has(g)) byG.set(g, rule(json, g, repos));
    return byG.get(g);
  }
  // patterns with their includes expanded: one list of the rules that match
  function flatten(patterns, g, repos, seen) {
    const out = [];
    for (const p of patterns) {
      if (!p || typeof p !== 'object') continue;
      if (typeof p.include === 'string') {
        const target = resolve(p.include, g, repos);
        if (!target || seen.has(target.json)) continue;
        seen.add(target.json);
        if (typeof target.json.match !== 'string' && typeof target.json.begin !== 'string') {
          const inner = target.json.repository ? [target.json.repository, ...target.repos] : target.repos;
          out.push(...flatten(target.json.patterns || [], target.g, inner, seen));
        } else out.push(ruleOf(target.json, target.g, target.repos));
        seen.delete(target.json);
        continue;
      }
      if (typeof p.match !== 'string' && typeof p.begin !== 'string') {
        out.push(...flatten(p.patterns || [], g, p.repository ? [p.repository, ...repos] : repos, seen));
        continue;
      }
      out.push(ruleOf(p, g, repos));
    }
    return out.filter((r) => r.match || r.begin);
  }
  function resolve(include, g, repos) {
    const whole = (x) => ({ json: { patterns: x.json.patterns || [] }, g: x, repos: [x.json.repository || {}] });
    if (include === '$self') return whole(g);
    if (include === '$base') return whole(base);
    if (include.startsWith('#')) {
      const name = include.slice(1);
      for (const repo of repos) if (repo && repo[name] && typeof repo[name] === 'object') return { json: repo[name], g, repos };
      return null;
    }
    const [scope, name] = include.split('#');
    const other = scope === g.scopeName ? g : load(lookup(scope));
    if (!other) return null;
    if (!name) return whole(other);
    const r = other.json.repository?.[name];
    return r && typeof r === 'object' ? { json: r, g: other, repos: [other.json.repository] } : null;
  }
  const base = load(raw);
  return base;
}

// --- tokenizing ----------------------------------------------------------------------------

// a stack frame: the rule open, the scopes over its text and inside it, its end (or while)
// resolved against what its begin matched. Frames are never changed: a line's state is shared
function frame(parent, r, scopes, content, end, { eol = false, enteredAt = -1, anchor = -1 } = {}) {
  return {
    parent, r, scopes, content, end, eol, enteredAt, anchor, isWhile: r.whileSource !== undefined,
    depth: parent ? parent.depth + 1 : 0,
    key: `${parent ? parent.key : ''}/${r.id}${end ? `:${end.src}` : ''}${eol ? '!' : ''}`,
  };
}
export function initialState(g) {
  const scopes = g.scopeName.split(' ');
  return frame(null, g.root, scopes, scopes, null);
}

const reEscape = (s) => s.replace(/[\-\\{}*+?|^$.,[\]()#\s]/g, '\\$&');
// an end or while with \1... the begin's captures, as the text has them
function backrefs(src, line, m) {
  if (!/\\\d/.test(src)) return src;
  return src.replace(/\\(\d+)/g, (all, n) => (m.indices[n] ? reEscape(line.slice(m.indices[n][0], m.indices[n][1])) : ''));
}
const endCache = new Map();
function endPattern(src) {
  let c = endCache.get(src);
  if (c === undefined) { c = compile(src); if (endCache.size > 2048) endCache.clear(); endCache.set(src, c); }
  return c ? { src, c } : null;
}
// a scope name with $1 or ${1:/downcase} its capture's text
function named(name, line, m) {
  if (!name || !name.includes('$')) return name;
  return name.replace(/\$(\d+)|\$\{(\d+):\/(downcase|upcase)\}/g, (all, a, b, how) => {
    const at = m.indices[a || b];
    const text = at ? line.slice(at[0], at[1]).replace(/^\.+|\.+$/g, '') : '';
    return how === 'downcase' ? text.toLowerCase() : how === 'upcase' ? text.toUpperCase() : text;
  });
}
const withName = (scopes, name) => (name ? [...scopes, ...name.split(' ').filter(Boolean)] : scopes);

// a pattern's first match at or after pos, through the line's cache: a match found further
// on still holds for a later search that starts before it
function search(c, line, pos, anchor, first, cache) {
  if (!c) return null;
  if (c.anchored) {
    const re = c.at(anchor, first);
    re.lastIndex = pos;
    return re.exec(line);
  }
  const hit = cache.get(c.re);
  if (hit && hit.from <= pos && (hit.m === null || hit.m.index >= pos)) return hit.m;
  c.re.lastIndex = pos;
  const m = c.re.exec(line);
  cache.set(c.re, { from: pos, m });
  return m;
}

function push(out, from, to, scopes) {
  if (to <= from) return;
  const last = out[out.length - 1];
  if (last && last.to === from && last.scopes === scopes) last.to = to;
  else out.push({ from, to, scopes });
}

// the match's text under its captures' scopes, outermost first; a capture with patterns of
// its own tokenized within its text
function captured(caps, m, scopes, line, out, depth) {
  const [s0, e0] = m.indices[0];
  const ranges = [];
  for (const [k, v] of Object.entries(caps)) {
    const at = m.indices[k];
    if (!at || at[1] < at[0] || at[0] < s0 || at[1] > e0) continue;
    ranges.push({ from: at[0], to: at[1], name: named(v.name, line, m), rules: v.rules, k: +k });
  }
  if (!ranges.length) { push(out, s0, e0, scopes); return; }
  ranges.sort((a, b) => a.from - b.from || b.to - a.to || a.k - b.k);
  const cuts = [...new Set([s0, e0, ...ranges.flatMap((r) => [r.from, r.to])])].sort((a, b) => a - b);
  const nested = ranges.filter((r) => r.rules && r.to > r.from && depth < 4);
  const pieces = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i], b = cuts[i + 1];
    if (nested.some((r) => r.from <= a && b <= r.to)) continue;
    const names = ranges.filter((r) => r.from <= a && b <= r.to && r.name).map((r) => r.name).join(' ');
    pieces.push({ from: a, to: b, scopes: withName(scopes, names) });
  }
  for (const r of nested) {
    const outer = ranges.filter((x) => x !== r && x.from <= r.from && r.to <= x.to && x.name).map((x) => x.name).join(' ');
    const inside = withName(withName(scopes, outer), r.name);
    const holder = frame(null, { id: -1, children: r.rules }, inside, inside, null);
    const sub = [];
    run(line.slice(0, r.to), r.from, holder, sub, depth + 1, -1, false, new Set());
    pieces.push(...sub);
  }
  pieces.sort((a, b) => a.from - b.from);
  for (const p of pieces) push(out, p.from, p.to, p.scopes);
}

// the line's tokens from pos under the frame given, as VS Code's tokenizer goes: the frame
// open at the line's end returned
function run(line, pos, top, out, depth, anchor, first, fresh) {
  const cache = new Map();
  for (let guard = 0; pos < line.length && guard < 4 * line.length + 64; guard++) {
    let best = null, bestRule = null;
    const endM = top.end ? search(top.end.c, line, pos, anchor, first, cache) : null;
    if (endM && !top.r.endLast) best = endM;
    for (const r of top.r.children()) {
      if (best && best.index === pos) break;
      const m = search(r.match || r.begin, line, pos, anchor, first, cache);
      if (m && (!best || m.index < best.index)) { best = m; bestRule = r; }
    }
    if (endM && top.r.endLast && (!best || endM.index < best.index)) { best = endM; bestRule = null; }
    if (!best) break;
    const [s, e] = best.indices[0];
    push(out, pos, s, top.content);
    if (!bestRule) {
      // its end: the end's captures under the rule's name, the frame popped
      captured(top.r.endCaptures, best, top.scopes, line, out, depth);
      // pushed and popped where nothing advanced: the line left as it is
      if (e === s && fresh.has(top) && top.enteredAt === s) { push(out, e, line.length, top.content); return top; }
      anchor = fresh.has(top) ? top.anchor : -1;
      top = top.parent || top;
      pos = e;
      continue;
    }
    const r = bestRule;
    if (r.match) {
      captured(r.captures, best, withName(top.content, named(r.name, line, best)), line, out, depth);
      if (e === s) { push(out, e, line.length, top.content); return top; }
      pos = e;
      continue;
    }
    // a begin: its frame pushed, its end or while resolved against what it matched
    const scopes = withName(top.content, named(r.name, line, best));
    captured(r.beginCaptures, best, scopes, line, out, depth);
    if (e === s && fresh.has(top) && top.r === r && top.enteredAt === s) { push(out, e, line.length, top.content); return top; }
    const content = withName(scopes, named(r.contentName, line, best));
    const end = endPattern(backrefs(r.endSource ?? r.whileSource, line, best));
    if (top.depth > 120) { push(out, e, line.length, content); return top; }
    top = frame(top, r, scopes, content, end, { eol: e === line.length, enteredAt: s, anchor });
    fresh.add(top);
    anchor = e;
    pos = e;
  }
  push(out, pos, line.length, top.content);
  return top;
}

// a line's tokens and the state after it: { tokens: [{from, to, scopes}], state }
export function tokenizeLine(g, text, state = initialState(g), first = false) {
  const line = `${text}\n`;
  const out = [];
  let top = state, pos = 0, anchor = state.eol ? 0 : -1;
  // the open while rules, outermost first: the first whose condition fails closes with all inside it
  const whiles = [];
  for (let f = state; f; f = f.parent) if (f.isWhile) whiles.unshift(f);
  for (const f of whiles) {
    const m = f.end && search(f.end.c, line, pos, anchor, first, new Map());
    if (!m) { top = f.parent; break; }
    push(out, pos, m.index, f.content);
    captured(f.r.whileCaptures, m, f.scopes, line, out, 0);
    if (m.indices[0][1] > pos) pos = m.indices[0][1];
    anchor = m.indices[0][1];
  }
  const end = run(line, pos, top, out, 0, anchor, first, new Set());
  const tokens = [];
  for (const t of out) if (t.from < text.length) tokens.push(t.to > text.length ? { ...t, to: text.length } : t);
  return { tokens, state: end };
}

// --- scopes to the page's classes ---------------------------------------------------------

// scope prefixes, innermost scope first: the first that names one gives its class ('' plain)
const SCOPE_CLASSES = [
  ['comment', 'hljs-comment'], ['punctuation.definition.comment', 'hljs-comment'],
  ['string.regexp', 'hljs-regexp'], ['constant.character.escape', 'hljs-symbol'], ['string', 'hljs-string'], ['punctuation.definition.string', 'hljs-string'],
  ['constant.numeric', 'hljs-number'], ['constant.other.color', 'hljs-number'], ['constant.language', 'hljs-literal'], ['constant.character', 'hljs-string'], ['constant', 'hljs-literal'],
  ['keyword.operator', ''], ['keyword.control.directive', 'hljs-meta'], ['keyword.other.preprocessor', 'hljs-meta'], ['meta.preprocessor', 'hljs-meta'], ['keyword', 'hljs-keyword'],
  ['storage', 'hljs-keyword'],
  ['entity.name.function', 'hljs-title'], ['support.function', 'hljs-title'],
  ['entity.name.type', 'hljs-type'], ['entity.name.class', 'hljs-type'], ['entity.other.inherited-class', 'hljs-type'], ['support.type.property-name', 'hljs-attr'], ['support.type', 'hljs-type'], ['support.class', 'hljs-type'],
  ['entity.name.tag', 'hljs-tag'], ['punctuation.definition.tag', 'hljs-tag'], ['entity.other.attribute-name', 'hljs-attr'],
  ['entity.name.section', 'hljs-section'], ['markup.heading', 'hljs-section'], ['entity.name', 'hljs-title'],
  ['variable.language', 'hljs-built_in'], ['variable.parameter', 'hljs-variable'], ['variable.other.property', 'hljs-attr'], ['variable.other.member', 'hljs-attr'],
  ['meta.object-literal.key', 'hljs-attr'], ['variable', ''],
  ['support.constant', 'hljs-literal'], ['support.variable', 'hljs-built_in'], ['support', 'hljs-built_in'],
  ['markup.bold', 'hljs-strong'], ['markup.italic', 'hljs-emphasis'], ['markup.inserted', 'hljs-addition'], ['markup.deleted', 'hljs-deletion'],
  ['markup.quote', 'hljs-quote'], ['markup.list', 'hljs-bullet'], ['markup.raw', 'hljs-string'], ['markup.inline.raw', 'hljs-string'],
  ['invalid', 'hljs-deletion'],
].sort((a, b) => b[0].length - a[0].length);
const classMemo = new Map();
function classOfScope(scope) {
  let c = classMemo.get(scope);
  if (c === undefined) {
    c = null;
    for (const [k, v] of SCOPE_CLASSES) if (scope === k || scope.startsWith(`${k}.`)) { c = v; break; }
    if (classMemo.size > 8192) classMemo.clear();
    classMemo.set(scope, c);
  }
  return c;
}
export function scopeClass(scopes) {
  for (let i = scopes.length - 1; i >= 0; i--) {
    const c = classOfScope(scopes[i]);
    if (c !== null) return c;
  }
  return '';
}

// --- a text's ranges --------------------------------------------------------------------------

// a text's {from, to, cls} ranges, each line's remembered by the state it began in: an edit
// costs the lines it changed and those after it whose state it changed
export function grammarHighlighter(g, { maxLine = 20000 } = {}) {
  let memo = new Map();
  return function ranges(text) {
    const out = [];
    const seen = new Map();
    let state = initialState(g), offset = 0, n = 0;
    for (const raw of text.split('\n')) {
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
      const key = `${n === 0 ? '1' : '0'}${state.key}\u0000${line}`;
      let hit = memo.get(key) || seen.get(key);
      if (!hit) {
        const r = line.length > maxLine ? { tokens: [], state } : tokenizeLine(g, line, state, n === 0);
        hit = { state: r.state, ranges: [] };
        for (const t of r.tokens) {
          const cls = scopeClass(t.scopes);
          if (!cls) continue;
          const last = hit.ranges[hit.ranges.length - 1];
          if (last && last.cls === cls && last.to === t.from) last.to = t.to; else hit.ranges.push({ from: t.from, to: t.to, cls });
        }
      }
      seen.set(key, hit);
      for (const x of hit.ranges) out.push({ from: x.from + offset, to: x.to + offset, cls: x.cls });
      state = hit.state;
      offset += raw.length + 1;
      n++;
    }
    // what this text's lines needed, kept for the next edit
    memo = seen;
    return out;
  };
}
