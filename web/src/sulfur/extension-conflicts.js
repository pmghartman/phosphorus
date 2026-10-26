// Shared by installation previews and the live extension registry. Theme and
// snippet alternatives deliberately coexist; only competing handlers are listed.
export const NATIVE_EXTENSIONS = [{
  id: 'sulfur.sqlite', native: true, active: true,
  manifest: { name: 'sqlite', displayName: 'SQLite', contributes: {
    customEditors: [{ viewType: 'sulfur.sqlite', filenamePatterns: ['*.sqlite', '*.sqlite3', '*.db', '*.db3'] }],
  } },
}];

const list = (value) => Array.isArray(value) ? value : [];
const records = (value) => list(value).filter((item) => item && typeof item === 'object');
const name = (x) => x.manifest?.displayName || x.id;
const identity = (id) => String(id).toLowerCase();
const extensionID = (x) => identity(x.manifest?.sulfur?.vscode?.id || x.id);
const keyOf = (key) => String(key || '').toLowerCase().trim().split(/\s+/).map((part) => {
  const bits = part.replace(/meta/g, 'cmd').split('+');
  return [...bits.slice(0, -1).sort(), bits.at(-1)].join('+');
}).join(' ');

export function createExtensionConflictIndex(extensions, { native = NATIVE_EXTENSIONS, commands = [], mac = false } = {}) {
  const all = [...native, ...extensions], byID = new Map(all.map((x) => [extensionID(x), x]));
  const issues = new Map(all.map((x) => [x.id, []]));
  const owners = new Map();
  let destination = issues, seen = new Set(), recording = true;
  const add = (x, other, kind, key, detail) => {
    const token = [x.id, other?.id || '', kind, key].join('\n');
    if (seen.has(token)) return;
    seen.add(token);
    destination.get(x.id).push({ kind, key, other: other?.id, native: !!other?.native, detail });
  };
  const claim = (x, kind, key, value = '', context = '') => {
    if (!key) return;
    const token = `${kind}\n${key}`;
    for (const prev of owners.get(token) || []) {
      if (prev.x.id === x.id || kind === 'language association' && prev.value === value || kind === 'keybinding' && prev.value === value) continue;
      const detail = (a, b) => `${kind} “${key}” also belongs to ${name(b)}${b.native ? ' (built into Sulfur)' : ''}${kind === 'keybinding' ? `; commands: ${a}, ${b === x ? value : prev.value}` : ''}.`;
      add(x, prev.x, kind, key, detail(value, prev.x));
      if (recording) add(prev.x, x, kind, key, detail(prev.value, x));
    }
    if (!recording) return;
    if (!owners.has(token)) owners.set(token, []);
    owners.get(token).push({ x, value, context });
  };
  const builtin = { id: 'sulfur:core', native: true, manifest: { displayName: 'Sulfur' } };
  issues.set(builtin.id, []);
  for (const cmd of commands) {
    claim(builtin, 'command', typeof cmd === 'string' ? cmd : cmd.id);
    if (typeof cmd === 'object') for (const key of [cmd.key, ...(cmd.alt || [])]) claim(builtin, 'keybinding', keyOf(key), cmd.id);
  }
  const inspect = (x) => {
    const c = x.manifest?.contributes || {};
    const reserved = native.find((n) => n !== x && n.id === x.id);
    if (reserved) add(x, reserved, 'extension identity', x.id, `${x.id} is reserved for ${name(reserved)}, a native Sulfur extension.`);
    for (const dep of list(x.manifest?.extensionDependencies)) {
      const target = byID.get(identity(dep));
      if (!target || target.active === false) add(x, target, 'dependency', dep, `${dep} is ${target ? 'disabled' : 'not installed'}; this extension may not activate correctly.`);
    }
    if (x.active === false) return;
    for (const cmd of records(c.commands)) if (typeof cmd.command === 'string') claim(x, 'command', cmd.command);
    for (const [ext] of Object.entries(c.runners || {})) claim(x, 'runner', ext.replace(/^\./, '').toLowerCase());
    for (const key of records(c.keybindings)) {
      if (typeof key.command !== 'string' || !key.command || key.command.startsWith('-')) continue;
      claim(x, 'keybinding', keyOf(mac && key.mac ? key.mac : key.key), key.command, String(key.when || '').trim());
    }
    for (const view of records(c.views)) if (typeof view.id === 'string') claim(x, 'view', view.id);
    for (const editor of records(c.customEditors)) {
      claim(x, 'custom editor', editor.viewType);
      if (editor.priority === 'option') continue;
      for (const pattern of list(editor.filenamePatterns)) if (typeof pattern === 'string') claim(x, 'file editor', pattern.replace(/^\*\*\//, '').toLowerCase());
    }
    for (const server of records(c.languageServers)) {
      for (const ext of list(server.extensions)) if (typeof ext === 'string') claim(x, 'language server', ext.replace(/^\./, '').toLowerCase());
    }
    for (const lang of records(c.languages)) {
      for (const ext of list(lang.extensions)) if (typeof ext === 'string') claim(x, 'language association', ext.replace(/^\./, '').toLowerCase(), lang.id);
    }
  };
  for (const x of all) inspect(x);
  return { issues, inspect(candidate) {
    destination = new Map([[candidate.id, []]]); seen = new Set(); recording = false;
    inspect(candidate);
    return destination.get(candidate.id);
  } };
}

export function extensionConflicts(extensions, options) {
  return createExtensionConflictIndex(extensions, options).issues;
}
