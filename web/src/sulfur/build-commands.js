// Compile in a unique writable directory. The absolute source keeps quoted
// includes relative to the original file; MSVC's object/PDB files stay here too.
export function singleFileCommand(template, source, output, windows, id) {
  const quote = windows ? (s) => `"${s}"` : (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const compile = template.replaceAll('"{f}"', quote(source)).replaceAll('"{o}"', quote(output));
  if (windows) {
    const scratch = `%TEMP%\\sulfur-build-${id}`;
    return `mkdir "${scratch}" && cd /d "${scratch}" && ${compile} && echo Build output: ${scratch}`;
  }
  return `work=$(mktemp -d "\u0024{TMPDIR:-/tmp}/sulfur-build.XXXXXXXX") && cd "$work" && ${compile} && printf '\\nBuild output: %s\\n' "$work"`;
}
