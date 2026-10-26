import { absolutePath, joinPath } from './project-paths.js';
import { cmakeVisualStudioTargets } from './cmake-visual-studio.js';
export { absolutePath, joinPath } from './project-paths.js';
const slash = (s) => String(s || '').replace(/\\/g, '/');
const basename = (s) => slash(s).split('/').pop();
const normalized = (s, windows) => windows ? slash(s).toLowerCase() : slash(s);

export function cmakeConfiguration(cfg, project) {
  const name = cfg.configuration || 'Debug';
  if (cfg.toolchain?.id === 'cmake-vs') return project.cmakeSettings?.find((s) => s.name === name)?.configurationType || name;
  if (cfg.toolchain?.id === 'cmake-preset') {
    return project.buildPresets?.find((p) => p.configurePreset === name)?.configuration || project.presets?.find((p) => p.name === name)?.configurationType || '';
  }
  return name;
}

// Read only reply files referenced by the current CMake File API index.
// Paths in artifacts are relative to the top-level build directory, not the
// target's source directory. Names need not match OUTPUT_NAME on disk.
export async function cmakeTargets({ read, list, root, configuration, windows = false }) {
  const reply = joinPath(root, '.cmake/api/v1/reply');
  const names = await list(reply).catch(() => []);
  const indexName = names.map((e) => e.name).filter((n) => /^index-.*\.json$/.test(n)).sort().at(-1);
  if (!indexName) return windows ? cmakeVisualStudioTargets({ read, list, root, configuration }) : { available: false, items: [] };
  const readJSON = async (name) => {
    if (!name || /[\\/]/.test(name)) throw new Error('Invalid CMake reply filename');
    return JSON.parse(await read(joinPath(reply, name)));
  };
  const index = await readJSON(indexName);
  const ref = index.objects?.find((o) => o.kind === 'codemodel' && o.version?.major === 2);
  if (!ref) return { available: false, items: [] };
  const model = await readJSON(ref.jsonFile);
  const configs = model.configurations || [];
  // Never substitute Debug for a selected Release configuration.
  const config = configs.find((c) => c.name === configuration) || (configs.length === 1 && (!configuration || !configs[0].name) ? configs[0] : null);
  if (!config) return { available: true, items: [], configurationMissing: true };
  const targets = await Promise.all((config.targets || []).map(async (r) => ({ ...await readJSON(r.jsonFile), refId: r.id })));
  const items = targets.filter((t) => t.type === 'EXECUTABLE' && !t.isGeneratorProvided && !t.imported).flatMap((target) => {
    const artifact = target.artifacts?.find((a) => basename(a.path) === target.nameOnDisk) || target.artifacts?.find((a) => windows ? /\.exe$/i.test(a.path) : !/\.(?:pdb|lib|a|dSYM|wasm)$/i.test(a.path));
    if (!artifact) return [];
    const executable = joinPath(root, artifact.path);
    return [{ target: target.name, targetId: target.id || target.refId, label: basename(artifact.path).replace(/\.exe$/i, ''), executable, configuration: config.name, build: true, kind: 'cmake' }];
  });
  return { available: true, items, targets, sourceRoot: model.paths?.source, configuration: config.name };
}

export function targetForFile(model, file, preferred, projectName, windows = false) {
  const items = model.items || [];
  const owners = new Set((model.targets || []).filter((t) => t.sources?.some((s) => normalized(joinPath(model.sourceRoot || '', s.path), windows) === normalized(file, windows))).map((t) => t.id || t.refId));
  const byId = new Map((model.targets || []).map((t) => [t.id || t.refId, t]));
  const dependsOnFile = (id, seen = new Set()) => {
    if (owners.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return byId.get(id)?.dependencies?.some((d) => dependsOnFile(d.id, seen)) || false;
  };
  const associated = items.filter((t) => dependsOnFile(t.targetId));
  const candidates = associated.length ? associated : items;
  const kept = candidates.find((t) => t.target === preferred?.target);
  if (kept) return kept;
  const norm = (s) => String(s || '').replace(/\.exe$/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  const named = candidates.find((t) => norm(t.label) === norm(projectName));
  if (named) return named;
  const applications = candidates.filter((t) => !/(^|[\\/_.-])(tests?|gtest|benchmarks?)([\\/_.-]|$)/i.test(t.executable) && !/(Tests?|Benchmark)$/i.test(t.target));
  return applications.length === 1 ? applications[0] : candidates.length === 1 ? candidates[0] : null;
}

export function executableCommand(executable, windows = false) {
  const path = slash(executable);
  if (windows) return `"${path.replace(/\//g, '\\')}"`;
  return `'${(absolutePath(path) ? path : `./${path}`).replace(/'/g, "'\\''")}'`;
}
