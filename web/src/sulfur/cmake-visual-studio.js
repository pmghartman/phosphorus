// Read CMake's already generated Visual Studio projects when no File API query
// was present at configure time. This inspects metadata; it never invokes MSBuild.
import { joinPath } from './project-paths.js';

const slash = (s) => String(s || '').replaceAll('\\', '/');
const parent = (s) => slash(s).split('/').slice(0, -1).join('/');
const base = (s) => slash(s).split('/').pop();
const id = (s) => slash(s).toLowerCase();
const xml = (s) => String(s || '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, name) => {
  const n = name.toLowerCase();
  if (n.startsWith('#')) {
    const code = n[1] === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  }
  return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[n];
});
const attr = (s, name) => xml(s.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i'))?.[2]);

function projectTarget(text, file, configuration, root) {
  const requested = configuration.split('|');
  const configurations = [...text.matchAll(/<ProjectConfiguration\b([^>]*)>/gi)].map((m) => attr(m[1], 'Include'));
  const selected = configurations.find((c) => c === configuration) || configurations.find((c) => c.split('|')[0] === requested[0] && (!requested[1] || c.split('|')[1] === requested[1]));
  if (!selected) return null;
  const [name, platform] = selected.split('|');
  const props = { configuration: name, platform, projectdir: parent(file) + '/', solutiondir: root + '/', projectname: base(file).replace(/\.vcxproj$/i, ''), targetext: '.exe' };
  const expand = (s) => xml(s).replace(/\$\(([^)]+)\)/g, (m, key) => props[key.toLowerCase()] ?? m);
  const applies = (attributes) => {
    const condition = attr(attributes, 'Condition');
    if (!condition) return true;
    const m = expand(condition).match(/^\s*(['"])(.*?)\1\s*==\s*(['"])(.*?)\3\s*$/);
    return !!m && m[2].toLowerCase() === m[4].toLowerCase();
  };
  for (const group of text.matchAll(/<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi)) {
    if (!applies(group[1])) continue;
    for (const property of group[2].matchAll(/<([\w]+)\b([^>]*)>([^<]*)<\/\1>/g)) {
      if (applies(property[2])) props[property[1].toLowerCase()] = expand(property[3].trim());
    }
  }
  const sources = [...text.matchAll(/<Cl(?:Compile|Include)\b([^>]*)>/gi)].filter((m) => applies(m[1])).map((m) => ({ path: joinPath(parent(file), expand(attr(m[1], 'Include'))) })).filter((s) => !s.path.includes('$('));
  const dependencies = [...text.matchAll(/<ProjectReference\b([^>]*)>/gi)].filter((m) => applies(m[1])).map((m) => ({ id: id(joinPath(parent(file), expand(attr(m[1], 'Include')))) }));
  const target = { id: id(file), name: props.projectname, sources, dependencies, type: props.configurationtype === 'Application' ? 'EXECUTABLE' : 'LIBRARY' };
  if (target.type !== 'EXECUTABLE') return { target };
  const output = props.targetpath || (props.outdir ? props.outdir.replace(/[\\/]?$/, '/') + (props.targetname || props.projectname) + props.targetext : '');
  if (!output || output.includes('$(')) return { target };
  const executable = joinPath(parent(file), output);
  return { target, item: { target: target.name, targetId: target.id, label: base(executable).replace(/\.exe$/i, ''), executable, configuration: name, build: true, kind: 'cmake' } };
}

export async function cmakeVisualStudioTargets({ read, list, root, configuration }) {
  const missing = { available: false, items: [] };
  const cache = await read(joinPath(root, 'CMakeCache.txt')).catch(() => '');
  if (!/^CMAKE_GENERATOR:INTERNAL=Visual Studio /m.test(cache)) return missing;
  const entries = await list(root).catch(() => []);
  const projects = new Set(entries.filter((e) => !e.dir && /\.vcxproj$/i.test(e.name)).map((e) => joinPath(root, e.name)));
  for (const e of entries.filter((e) => !e.dir && /\.sln$/i.test(e.name))) {
    const solution = await read(joinPath(root, e.name)).catch(() => '');
    for (const m of solution.matchAll(/^Project\("\{[^}]+\}"\)\s*=\s*"[^"]+",\s*"([^"]+\.vcxproj)"/gmi)) projects.add(joinPath(root, m[1]));
  }
  const files = [...projects];
  if (!files.length) return missing;
  // Keep network reads bounded even for large generated solutions.
  let next = 0;
  const results = new Array(files.length);
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const text = await read(files[i]).catch(() => '');
      results[i] = projectTarget(text, files[i], configuration, root);
    }
  }));
  const targets = results.filter(Boolean).map((r) => r.target);
  return { available: true, items: results.flatMap((r) => r?.item ? [r.item] : []), targets, sourceRoot: '', configuration, configurationMissing: !targets.length, metadata: 'visual-studio' };
}
