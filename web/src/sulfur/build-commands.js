// Compile in a unique writable directory. The absolute source keeps quoted
// includes relative to the original file; MSVC's object/PDB files stay here too.
export function singleFileCommand(template, source, output, windows, id) {
  const quote = windows ? (s) => `"${s}"` : (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const compile = template.replaceAll('"{f}"', quote(source)).replaceAll('"{o}"', quote(output));
  if (windows) {
    const scratch = `%TEMP%\\sulfur-build-${id}`;
    return `mkdir "${scratch}" && cd /d "${scratch}" && ${compile} && echo Build output: ${scratch}`;
  }
  return `work=$(mktemp -d "\${TMPDIR:-/tmp}/sulfur-build.XXXXXXXX") && cd "$work" && ${compile} && printf '\\nBuild output: %s\\n' "$work"`;
}

export function configsFor(cfg, proj) {
  const tc = cfg.toolchain || {};
  if (tc.id === 'cmake-vs' && proj.cmakeSettings?.length) return proj.cmakeSettings.map((x) => x.name);
  if (tc.id === 'cmake-preset' && proj.presets?.length) return proj.presets.map((x) => x.name);
  if (tc.id === 'cmake-tree') {
    const tree = (proj.trees || []).find((t) => t.dir === tc.dir);
    return tree?.configs?.length ? tree.configs : [...new Set([tree?.type, 'Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel'].filter(Boolean))];
  }
  if (tc.id?.startsWith('cmake-')) return ['Debug', 'Release', 'RelWithDebInfo', 'MinSizeRel'];
  if ((tc.id === 'msbuild' || tc.id === 'dotnet') && proj.slnConfigs?.length) return proj.slnConfigs;
  return ['Debug', 'Release'];
}
