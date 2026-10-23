import test from 'node:test';
import assert from 'node:assert/strict';
import { fileKind, renderFileIcon } from '../src/sulfur/file-icons.js';

test('source icons distinguish language, headers, React files and project files across path styles', () => {
  const cpp = fileKind('C:\\engine\\Runtime.CPP');
  const header = fileKind('include/Runtime.hpp');
  const cs = fileKind('scripts/Player.cs');
  const project = fileKind('src/Game.csproj');
  assert.equal(cpp.label, 'C++'); assert.equal(header.label, 'H++');
  assert.equal(cs.label, 'C#'); assert.equal(project.label, 'C#');
  assert.equal(cs.glyph, 'source'); assert.equal(project.glyph, 'project');
  assert.equal(fileKind('ui/View.tsx').label, 'TSX');
  assert.equal(fileKind('ui/View.jsx').label, 'JSX');
  assert.equal(fileKind('game.slnx').glyph, 'solution');
});

test('specific build and config filenames override their generic extensions', () => {
  for (const name of ['CMakeLists.txt', 'toolchain.cmake']) assert.equal(fileKind(name).glyph, 'cmake');
  for (const name of ['CMakeSettings.json', 'CMakeUserPresets.json', 'appsettings.Development.json', 'launchSettings.json', 'app.config', 'game.vcxproj.filters']) assert.equal(fileKind(name).glyph, 'config', name);
  for (const name of ['.gitignore', '.gitattributes', '.gitmodules']) assert.equal(fileKind(name).glyph, 'git');
  assert.equal(fileKind('settingsdata.json').glyph, 'json');
  assert.equal(fileKind('NOTICE').glyph, 'text');
  assert.equal(fileKind('Permissions.md').glyph, 'markdown');
  assert.equal(fileKind('pnpm-lock.yaml').glyph, 'package');
  assert.equal(fileKind('Dockerfile.release').glyph, 'container');
  assert.equal(fileKind('mystery.custom').glyph, 'file');
});

test('project folder icons use already-listed project files and preserve ordinary folder state', () => {
  assert.equal(fileKind('src', { directory: true, open: true }).glyph, 'folderOpen');
  const folder = fileKind('Game', { directory: true, entries: [{ name: 'Game.csproj' }] });
  assert.equal(folder.folder, true); assert.equal(folder.label, 'C#');
  assert.equal(fileKind('Properties', { directory: true }).title, 'Project properties folder');
});

test('file glyphs are self-contained SVGs with readable badges and a descriptive title', () => {
  const document = { createElementNS(ns, tag) { return { tag, ns, attributes: {}, children: [], setAttribute(k, v) { this.attributes[k] = v; }, append(...children) { this.children.push(...children); } }; } };
  const icon = renderFileIcon(document, fileKind('script.cs'));
  assert.equal(icon.tag, 'svg');
  assert.equal(icon.attributes['aria-hidden'], 'true');
  assert.equal(icon.children.find((x) => x.tag === 'title').textContent, 'C# source');
  assert.equal(icon.children.find((x) => x.tag === 'text').textContent, 'C#');
  assert.ok(icon.children.every((x) => !['image', 'use', 'script'].includes(x.tag)));
});
