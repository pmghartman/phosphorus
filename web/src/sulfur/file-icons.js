const source = (label, title, hue) => ({ glyph: 'source', label, title, hue });
const kind = (glyph, title, hue = 'n', label = '') => ({ glyph, title, hue, label });
const languages = {};
for (const [extensions, label, title, hue] of [
  ['c', 'C', 'C source', 'b'], ['cc cpp cxx c++', 'C++', 'C++ source', 'p'],
  ['h', 'H', 'C / C++ header', 'b'], ['hh hpp hxx h++', 'H++', 'C++ header', 'p'],
  ['ipp inl tpp', 'INL', 'C++ inline source', 'p'], ['ixx cppm', 'C++', 'C++ module', 'p'],
  ['cs csx', 'C#', 'C# source', 'g'], ['fs fsx fsi', 'F#', 'F# source', 'b'], ['vb', 'VB', 'Visual Basic source', 'b'],
  ['js mjs cjs', 'JS', 'JavaScript source', 'y'], ['jsx', 'JSX', 'JavaScript React source', 'c'],
  ['ts mts cts', 'TS', 'TypeScript source', 'b'], ['tsx', 'TSX', 'TypeScript React source', 'c'],
  ['py pyw pyi', 'PY', 'Python source', 'b'], ['go', 'Go', 'Go source', 'c'], ['rs', 'RS', 'Rust source', 'o'],
  ['java', 'J', 'Java source', 'r'], ['kt kts', 'KT', 'Kotlin source', 'p'], ['swift', 'SW', 'Swift source', 'o'],
  ['rb rake', 'RB', 'Ruby source', 'r'], ['php', 'PHP', 'PHP source', 'p'], ['lua', 'LUA', 'Lua source', 'b'],
  ['sh bash zsh fish', 'SH', 'Shell script', 'g'], ['ps1 psm1 psd1', 'PS', 'PowerShell script', 'b'],
  ['bat cmd', 'CMD', 'Windows command script', 'g'], ['sql', 'SQL', 'SQL source', 'p'],
  ['r rmd', 'R', 'R source', 'b'], ['dart', 'DT', 'Dart source', 'c'], ['zig', 'Z', 'Zig source', 'y'],
  ['ex exs', 'EX', 'Elixir source', 'p'], ['hs lhs', 'HS', 'Haskell source', 'p'], ['scala sc', 'SC', 'Scala source', 'r'],
  ['vue', 'V', 'Vue component', 'g'], ['svelte', 'S', 'Svelte component', 'o'],
  ['html htm xhtml', '<>', 'HTML document', 'o'], ['css', '#', 'CSS stylesheet', 'b'],
  ['scss sass less', '#', 'Stylesheet', 'p'], ['hlsl hlsli glsl vert frag geom comp', 'GPU', 'Shader source', 'p'],
  ['proto', 'PB', 'Protocol Buffers source', 'b'], ['tex sty cls', 'TeX', 'LaTeX source', 'g'],
]) for (const extension of extensions.split(' ')) languages[extension] = source(label, title, hue);

const projects = { csproj: ['C#', 'C# project', 'g'], fsproj: ['F#', 'F# project', 'b'], vbproj: ['VB', 'Visual Basic project', 'b'], vcxproj: ['C++', 'C++ project', 'p'], vcproj: ['C++', 'C++ project', 'p'], proj: ['P', 'Build project', 'p'] };
const images = new Set('png jpg jpeg gif webp bmp ico avif svg tif tiff'.split(' '));
const configs = new Set('ini cfg conf config properties editorconfig props targets ruleset runsettings settings'.split(' '));
const archives = new Set('zip gz tgz xz bz2 zst 7z rar tar jar nupkg vsix'.split(' '));
const binaries = new Set('dll exe so dylib lib a o obj wasm class pyc pdb'.split(' '));

export function fileKind(path, { directory = false, open = false, entries = [] } = {}) {
  const name = String(path || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (directory) {
    const project = entries.map((entry) => entry.name).find((name) => /\.(?:cs|fs|vb|vcx?)proj$/i.test(name));
    if (project) { const descriptor = fileKind(project); return { ...descriptor, folder: true, title: descriptor.title + ' folder' }; }
    return kind(open ? 'folderOpen' : 'folder', name === 'properties' ? 'Project properties folder' : 'Folder', 'folder', name === 'properties' ? 'properties' : '');
  }
  const extension = name.includes('.') ? name.split('.').pop() : '';
  if (/^\.(gitignore|gitattributes|gitmodules|gitkeep)$/.test(name)) return kind('git', 'Git configuration', 'o');
  if (name === 'cmakelists.txt' || name === 'cmakecache.txt' || extension === 'cmake') return kind('cmake', 'CMake build file', 'c');
  if (/^cmake(?:user)?(?:presets|settings)\.json$/.test(name)) return kind('config', 'CMake configuration', 'c');
  if (/^(?:dockerfile|containerfile)(?:\.|$)/.test(name) || extension === 'dockerfile') return kind('container', 'Container build file', 'b');
  if (/^(?:gnu)?makefile(?:\.|$)/.test(name) || extension === 'mk') return source('MK', 'Make build file', 'o');
  if (projects[extension]) { const [label, title, hue] = projects[extension]; return kind('project', title, hue, label); }
  if (extension === 'sln' || extension === 'slnx') return kind('solution', 'Visual Studio solution', 'p');
  if (/^(package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.(toml|lock)|go\.(mod|sum)|pyproject\.toml|requirements(?:[.-].*)?\.txt)$/.test(name)) return kind('package', 'Package / dependency manifest', 'o');
  if (configs.has(extension) || name === '.editorconfig' || /^(?:appsettings(?:\..+)?|launchsettings|[tj]sconfig(?:\..+)?|settings)\.json$/.test(name) || /\.(?:cs|fs|vb|vcx)proj\.(?:user|filters)$/.test(name)) return kind('config', 'Configuration file', 'n');
  if (languages[extension]) return languages[extension];
  if (extension === 'json' || extension === 'jsonc') return kind('json', 'JSON document', 'y');
  if (['xml', 'xaml', 'axaml', 'resx', 'cshtml', 'razor'].includes(extension)) return source('<>', extension === 'resx' ? '.NET resource file' : extension === 'razor' || extension === 'cshtml' ? 'Razor view' : 'XML / markup document', 'o');
  if (['yaml', 'yml', 'toml'].includes(extension)) return kind('config', 'Structured configuration', 'p');
  if (['md', 'mdx', 'markdown'].includes(extension)) return kind('markdown', 'Markdown document', 'b');
  if (images.has(extension)) return kind('image', 'Image asset', 'p');
  if (archives.has(extension)) return kind('archive', 'Archive / package', 'o');
  if (binaries.has(extension)) return kind('binary', 'Compiled binary / library', 'b');
  if (['mp3', 'wav', 'flac', 'ogg', 'mp4', 'webm', 'mov'].includes(extension)) return kind('media', 'Audio / video asset', 'p');
  if (['db', 'sqlite', 'sqlite3'].includes(extension)) return kind('database', 'Database', 'y');
  if (['txt', 'log', 'csv', 'tsv'].includes(extension) || /^(?:readme|licen[cs]e|notice|copying|authors)(?:[.-]|$)/.test(name)) return kind('text', 'Text document', 'n');
  return kind('file', 'File');
}

const glyphs = {
  file: 'M3 1h6l4 4v10H3zM9 1v4h4', text: 'M3 1h6l4 4v10H3zM9 1v4h4M5 8h6M5 10h6M5 12h4',
  folder: 'M1 3h5l1 2h8v9H1z', folderOpen: 'M1 3h5l1 2h7v2M1 3v11h11l3-7H4l-3 7',
  git: 'M8 1l7 7-7 7-7-7zM6 5v6M6 6l4 3M6 4.5h.01M6 11h.01M10 9h.01',
  config: 'M6 1h4v2l2 1 2-1 1 3-2 1v2l2 1-1 3-2-1-2 1v2H6v-2l-2-1-2 1-1-3 2-1V7L1 6l1-3 2 1 2-1zM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  json: 'M6 2H4v4L2 8l2 2v4h2M10 2h2v4l2 2-2 2v4h-2M7 6h2M7 10h2',
  markdown: 'M1 3h14v10H1zM3 10V6l2 2 2-2v4M10 6v4M8.5 8.5L10 10l1.5-1.5',
  cmake: 'M8 1l7 14H1zM8 1v10l7 4M1 15l7-4', container: 'M1 7h14v6H1zM3 3h4v4M7 3h4v4M5 7v6M10 7v6',
  project: 'M1 2h14v12H1zM1 5h14M3 3.5h.01M5 3.5h.01', solution: 'M1 4l4-3 4 3-4 3zM7 10l4-3 4 3-4 3zM1 4v6l4 3 2-1M5 7v6M11 13v2M15 10v5l-4 0',
  package: 'M8 1l7 4v7l-7 3-7-3V5zM1 5l7 3 7-3M8 8v7M4.5 3l7 4',
  image: 'M1 2h14v12H1zM2 12l4-4 3 3 2-2 4 4M10 5h.01',
  archive: 'M3 1h10v14H3zM7 2h2M7 4h2M7 6h2M7 8h2M7 10h2v3H7z',
  binary: 'M4 3h8v10H4zM6 1v2M10 1v2M6 13v2M10 13v2M2 5h2M2 10h2M12 5h2M12 10h2M6 6h4v4H6z',
  media: 'M2 2h12v12H2zM6 5l5 3-5 3z', database: 'M2 4c0-3 12-3 12 0v8c0 3-12 3-12 0zM2 4c0 3 12 3 12 0M2 8c0 3 12 3 12 0',
};

// Inline SVGs share the app's native icon sizing and never fetch an icon font,
// extension asset or one network resource per file.
export function renderFileIcon(document, descriptor) {
  const svg = (tag, attrs) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value); return node; };
  const node = svg('svg', { viewBox: '0 0 16 16', class: `ic ide-ic ide-fi ide-file-icon ide-hue-${descriptor.hue}${descriptor.hue === 'folder' ? ' ide-fi-dir' : ''}`, 'aria-hidden': 'true', 'data-file-kind': descriptor.title });
  const title = svg('title', {}); title.textContent = descriptor.title; node.append(title);
  const source = descriptor.glyph === 'source';
  const path = source ? 'M1 3h14v10H1z' : glyphs[descriptor.glyph] || glyphs.file;
  node.append(svg('path', { d: path, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.1', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  if ((source || descriptor.glyph === 'project') && descriptor.label) {
    const label = svg('text', { x: 8, y: descriptor.glyph === 'project' ? 11.8 : 10.6, 'text-anchor': 'middle', fill: 'currentColor', stroke: 'none', 'font-family': 'Consolas, monospace', 'font-size': descriptor.label.length > 2 ? 6.3 : 7.5, 'font-weight': 700, 'letter-spacing': '-0.4' });
    label.textContent = descriptor.label; node.append(label);
  }
  if (descriptor.label === 'properties') node.append(svg('path', { d: 'M11.5 8.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4M11.5 7v1.5M11.5 12.5V14M8 10.5h1.5M13.5 10.5H15', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2 }));
  return node;
}
