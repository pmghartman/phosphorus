import test from 'node:test';
import assert from 'node:assert/strict';
import { setContributions, removeContributions, contributedLang, languageOf, languageName, snippetItems, iconOf, themeCss, iconFontCss, contributedThemes, contributedServers } from '../src/sulfur/vsx-contributions.js';

// a converted extension as vsx_convert.go writes one, its files in memory
function install(id, contributes, files = {}) {
  setContributions(id, { name: id, displayName: id, contributes }, async (p) => (p in files ? files[p] : null));
}

test('a converted language and grammar where the page has no parser, never over one it has', async () => {
  install('pub.demo', {
    languages: [{ id: 'jinja', aliases: ['Jinja'], extensions: ['j2', 'jinja'], filenames: ['jinjafile'], comments: { lineComment: '##', blockComment: ['{#', '#}'] } },
      { id: 'jinja-html', extensions: ['html.j2'] }],
    grammars: [{ language: 'jinja', scopeName: 'source.jinja', path: 'syntaxes/jinja.json' }, { language: 'lua', scopeName: 'source.lua', path: 'syntaxes/lua.json' },
      { language: 'javascript', scopeName: 'source.js', path: 'syntaxes/js.json' }],
  }, {
    'syntaxes/jinja.json': JSON.stringify({ scopeName: 'source.jinja', patterns: [{ match: '\\b(for|in)\\b', name: 'keyword.control.jinja' }, { include: 'source.lua' }] }),
    'syntaxes/lua.json': JSON.stringify({ scopeName: 'source.lua', patterns: [{ match: '--.*$', name: 'comment.line.lua' }] }),
  });
  assert.equal(languageOf('templates/page.html.j2').id, 'jinja-html');
  assert.equal(languageOf('a/JinjaFile').id, 'jinja');
  assert.equal(languageName('jinja'), 'Jinja');
  // a file the host doesn't know: the converted language, its comment marker
  const j2 = contributedLang('x/site.j2', null);
  assert.equal(j2.hl, 'jinja'); assert.equal(j2.check, ''); assert.equal(j2.comment, '##');
  const ranges = (await j2.grammar())('for x in y -- note');
  assert.deepEqual(ranges.map((r) => r.cls), ['hljs-keyword', 'hljs-keyword', 'hljs-comment']);
  // a file the host colors on the server: the grammar, the host's language kept
  const lua = contributedLang('init.lua', { hl: 'lua', check: '', comment: '--' });
  assert.equal(lua.hl, 'lua'); assert.equal(lua.scopeName, 'source.lua');
  // a file the page parses: the host's alone
  const js = { hl: 'javascript', check: 'javascript', comment: '//' };
  assert.equal(contributedLang('a.js', js), js);
  assert.equal(contributedLang('a.txt', null), null);
  removeContributions('pub.demo');
  assert.equal(contributedLang('x/site.j2', null), null);
});

test('snippets for a file: each prefix an item, its body a snippet', async () => {
  install('pub.snips', { snippets: [{ language: 'javascript', languages: ['javascript', 'typescript'], path: 'snippets/js.json', extensions: ['js', 'ts'], filenames: [] }] }, {
    'snippets/js.json': JSON.stringify([{ name: 'Log', prefix: ['log', 'clg'], body: 'console.log($1)', description: 'log it' }]),
  });
  const items = await snippetItems('src/app.ts');
  assert.deepEqual(items.map((i) => i.label), ['log', 'clg']);
  assert.equal(items[0].insertTextFormat, 2); assert.equal(items[0].insertText, 'console.log($1)'); assert.equal(items[0].kind, 15);
  assert.deepEqual(await snippetItems('src/app.py'), []);
  removeContributions('pub.snips');
});

test('a file icon theme picks names, then the longest extension, then the language, then the default', () => {
  install('pub.langs', { languages: [{ id: 'demo', extensions: ['dm'], filenames: [] }] });
  const theme = {
    defs: { file: { src: 'data:image/svg+xml;base64,AA' }, ts: { src: 'ts' }, dts: { src: 'dts' }, mk: { char: 'M', font: 'f' }, folder: { src: 'dir' }, open: { src: 'open' }, src: { src: 'srcdir' }, lightTs: { src: 'light' }, lang: { src: 'lang' } },
    file: 'file', folder: 'folder', folderExpanded: 'open',
    fileExtensions: { ts: 'ts', 'd.ts': 'dts' }, fileNames: { makefile: 'mk' }, folderNames: { src: 'src' }, languageExtensions: { dm: 'lang' },
    light: { fileExtensions: { ts: 'lightTs' } },
  };
  assert.equal(iconOf(theme, 'a/b.ts').src, 'ts');
  assert.equal(iconOf(theme, 'a/types.d.ts').src, 'dts');
  assert.equal(iconOf(theme, 'Makefile').char, 'M');
  assert.equal(iconOf(theme, 'x.dm').src, 'lang');
  assert.equal(iconOf(theme, 'readme').src, 'data:image/svg+xml;base64,AA');
  assert.equal(iconOf(theme, 'a/src', { directory: true }).src, 'srcdir');
  assert.equal(iconOf(theme, 'a/lib', { directory: true, open: true }).src, 'open');
  assert.equal(iconOf(theme, 'a/b.ts', { light: true }).src, 'light');
  assert.equal(iconOf(null, 'a.ts'), null);
  removeContributions('pub.langs');
});

test('theme css carries only tokens and colors, fonts only data urls', () => {
  const css = themeCss({ type: 'light', vars: { '--ide-bg': '#ffffff', '--hl-kw': '#a00', '--hl-cmt-style': 'italic', '--ide-fg': 'red; } body { x', 'color': '#000', '--ide-shadow': '0 0 8px 2px #00000080' } });
  assert.match(css, /color-scheme: light;/);
  assert.match(css, /--ide-bg: #ffffff;/); assert.match(css, /--hl-kw: #a00;/); assert.match(css, /--hl-cmt-style: italic;/); assert.match(css, /--ide-shadow: 0 0 8px 2px #00000080;/);
  assert.doesNotMatch(css, /body|red|color: #000/);
  const fonts = iconFontCss({ fonts: { f: { src: 'data:font/woff;base64,d09GRg==', weight: 'bold' }, bad: { src: 'https://evil.example/x.woff' } } }, (id) => `fam-${id}`);
  assert.match(fonts, /font-family: "fam-f"; src: url\("data:font\/woff;base64,d09GRg=="\); font-weight: bold;/);
  assert.doesNotMatch(fonts, /evil/);
});

test('themes and servers are listed by extension, keyed for the settings', () => {
  install('pub.theme', { themes: [{ id: 'night', label: 'Night', uiTheme: 'dark', path: 'themes/night.json' }], languageServers: [{ name: 'LS', runtime: 'node', entry: 'extension/s.js', extensions: ['x'] }] });
  assert.deepEqual(contributedThemes().map((t) => t.key), ['pub.theme/night']);
  assert.deepEqual(contributedServers().map((s) => s.id), ['vsx.pub.theme']);
  removeContributions('pub.theme');
  assert.deepEqual(contributedThemes(), []);
});
