// What enabled converted VS Code extensions declare (internal/sulfur/vsx_convert.go writes
// them): their languages and grammars for the editor, snippets for completion, color and
// file icon themes. The workbench puts each extension's files in when it's enabled and
// takes them out when it's not; the editor and its completion only ask.

import { createGrammar, grammarHighlighter } from './textmate.js';

const exts = new Map();
let version = 0;
export const contributionsVersion = () => version;

const lower = (s) => String(s || '').toLowerCase();
const baseName = (p) => lower(String(p || '').replace(/\\/g, '/').split('/').pop());

// an extension's contributions, its files read by load(path) as text (null when missing)
export function setContributions(id, manifest, load) {
  const c = manifest?.contributes || {};
  const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
  const json = (path) => load(path).then((t) => { if (t === null) throw new Error(`${path} is missing`); return JSON.parse(t); });
  const once = (f) => { let p = null; return () => (p ||= f().catch((err) => { p = null; throw err; })); };
  exts.set(id, {
    id,
    name: manifest.displayName || manifest.name || id,
    languages: list(c.languages).map((l) => ({ ...l, extensions: (l.extensions || []).map(lower), filenames: (l.filenames || []).map(lower) })),
    grammars: list(c.grammars).filter((g) => g.scopeName && g.path).map((g) => ({ ...g, json: once(() => json(g.path)) })),
    snippets: list(c.snippets).filter((s) => s.path).map((s) => ({ ...s, extensions: (s.extensions || []).map(lower), filenames: (s.filenames || []).map(lower), items: once(() => json(s.path)), loaded: null })),
    themes: list(c.themes).filter((t) => t.path).map((t) => ({ ...t, key: `${id}/${t.id || t.label}`, ext: id, data: once(() => json(t.path)) })),
    iconThemes: list(c.iconThemes).filter((t) => t.path).map((t) => ({ ...t, key: `${id}/${t.id || t.label}`, ext: id, data: once(() => json(t.path)) })),
    servers: list(c.languageServers),
  });
  version++;
  compiled.clear();
}
export function removeContributions(id) {
  if (exts.delete(id)) { version++; compiled.clear(); }
}
export const contributedThemes = () => [...exts.values()].flatMap((x) => x.themes.map((t) => ({ ...t, extName: x.name })));
// converted extensions' language servers, by the id the language host knows them: vsx.<extension id>
export const contributedServers = () => [...exts.values()].flatMap((x) => x.servers.map((s) => ({ ...s, id: `vsx.${x.id}`, ext: x.id })));
export const contributedIconThemes = () => [...exts.values()].flatMap((x) => x.iconThemes.map((t) => ({ ...t, extName: x.name })));

// --- languages and grammars --------------------------------------------------------------

// the converted language a file is, by its name or longest matching extension
export function languageOf(path) {
  const name = baseName(path);
  let best = null, bestLen = -1;
  for (const x of exts.values()) {
    for (const l of x.languages) {
      if (l.filenames.includes(name) && bestLen < Infinity) { best = l; bestLen = Infinity; }
      for (const e of l.extensions) if (e && (name === e || name.endsWith(`.${e}`)) && e.length > bestLen) { best = l; bestLen = e.length; }
    }
  }
  return best;
}
// a converted language's name, as VS Code shows it
export function languageName(id) {
  for (const x of exts.values()) for (const l of x.languages) if (l.id === id && Array.isArray(l.aliases) && l.aliases[0]) return String(l.aliases[0]);
  return '';
}
const grammarFor = (language) => {
  for (const x of exts.values()) for (const g of x.grammars) if (g.language === language) return g;
  return null;
};

// grammars compiled once, each with every enabled grammar to include by scope
const compiled = new Map();
async function compiledGrammar(entry) {
  if (compiled.has(entry.scopeName)) return compiled.get(entry.scopeName);
  const all = [...exts.values()].flatMap((x) => x.grammars);
  const byScope = new Map();
  await Promise.all(all.map(async (g) => { try { byScope.set(g.scopeName, await g.json()); } catch {} }));
  const raw = byScope.get(entry.scopeName);
  const g = raw ? createGrammar(raw, (scope) => byScope.get(scope) || null) : null;
  compiled.set(entry.scopeName, g);
  return g;
}

// the host's language for a file with what converted extensions add: their grammar where the
// page has no parser, their language where the page knows none. base is codeLang's answer
export function contributedLang(path, base) {
  if (base?.check) return base;
  const l = languageOf(path);
  const id = l?.id || base?.hl;
  const entry = id && grammarFor(id);
  if (!l && !entry) return base;
  const out = base ? { ...base } : { hl: l.id, check: '', comment: l.comments?.lineComment || '' };
  if (l && !base) out.blockComment = Array.isArray(l.comments?.blockComment) ? l.comments.blockComment : null;
  if (entry) {
    out.scopeName = entry.scopeName;
    // a highlighter of the editor's own: each remembers its text's lines
    out.grammar = async () => { const g = await compiledGrammar(entry); return g ? grammarHighlighter(g) : null; };
  }
  return out;
}

// --- snippets -----------------------------------------------------------------------------------

// completion items of the snippets for a file: each prefix an item, its body a snippet
export async function snippetItems(path) {
  const name = baseName(path);
  const ext = name.includes('.') ? name.split('.').slice(1) : [];
  const ours = [];
  for (const x of exts.values()) {
    for (const s of x.snippets) {
      const hit = s.filenames.includes(name) || s.extensions.some((e) => ext.length && (name === e || name.endsWith(`.${e}`)));
      if (!hit) continue;
      try { s.loaded ||= await s.items(); } catch { continue; }
      for (const sn of Array.isArray(s.loaded) ? s.loaded : []) {
        for (const prefix of sn.prefix || []) {
          ours.push({ label: prefix, kind: 15, insertText: sn.body, insertTextFormat: 2, detail: sn.name, documentation: sn.description || sn.body, sortText: `~${prefix}`, snippetOf: x.name });
        }
      }
    }
  }
  return ours;
}

// --- color themes -------------------------------------------------------------------------------

const CSS_VALUE = /^(#[0-9a-fA-F]{3,8}|0 0 8px 2px #[0-9a-fA-F]{3,8}|italic|normal)$/;
// a converted theme's tokens as a rule over the workbench's, at more than the library's weight
export function themeCss(data, sel = ':root .ide-win.ide-ext-theme') {
  const vars = Object.entries(data?.vars || {}).filter(([k, v]) => /^--(ide|hl)-[\w-]+$/.test(k) && CSS_VALUE.test(String(v)));
  const scheme = /light/.test(data?.type) ? 'light' : 'dark';
  return `${sel} { color-scheme: ${scheme}; ${vars.map(([k, v]) => `${k}: ${v};`).join(' ')} }\n`;
}

// --- file icon themes -------------------------------------------------------------------------

// the icon a theme gives a path: its definition ({src} or {char, font, color, size}), null for none
export function iconOf(theme, path, { directory = false, open = false, root = false, light = false } = {}) {
  if (!theme) return null;
  const name = baseName(path);
  const sets = light && theme.light ? [theme.light, theme] : [theme];
  const pick = (k, key) => { for (const s of sets) { const v = s[k]?.[key]; if (v && theme.defs?.[v]) return v; } return null; };
  const single = (k) => { for (const s of sets) if (s[k] && theme.defs?.[s[k]]) return s[k]; return null; };
  let id = null;
  if (directory) {
    id = (root && pick(open ? 'rootFolderNamesExpanded' : 'rootFolderNames', name)) || pick(open ? 'folderNamesExpanded' : 'folderNames', name)
      || (root && single(open ? 'rootFolderExpanded' : 'rootFolder')) || single(open ? 'folderExpanded' : 'folder') || single('folder');
  } else {
    id = pick('fileNames', name);
    // the longest extension first: d.ts before ts
    const parts = name.split('.');
    for (let i = 1; !id && i < parts.length; i++) id = pick('fileExtensions', parts.slice(i).join('.'));
    if (!id) id = pick('languageFileNames', name);
    for (let i = 1; !id && i < parts.length; i++) id = pick('languageExtensions', parts.slice(i).join('.'));
    if (!id) {
      const l = languageOf(path);
      if (l) id = pick('languageExtensions', l.extensions[0] || '');
    }
    id ||= single('file');
  }
  return id ? theme.defs[id] : null;
}

// an icon theme's fonts as @font-face rules, each family named for the theme
export function iconFontCss(theme, family) {
  return Object.entries(theme?.fonts || {}).filter(([, f]) => /^data:font\/[\w-]+;base64,[A-Za-z0-9+/=]+$/.test(f.src || ''))
    .map(([id, f]) => `@font-face { font-family: "${family(id)}"; src: url("${f.src}"); font-weight: ${/^(normal|bold|[1-9]00)$/.test(f.weight || '') ? f.weight : 'normal'}; font-style: ${/^(normal|italic|oblique)$/.test(f.style || '') ? f.style : 'normal'}; }`).join('\n');
}
