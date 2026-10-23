import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_NAMES } from '../src/host/contract.js';

// Sulfur and the Phosphorus desktop meet only at '#host' (src/host/contract.js): these hold
// both hosts to the contract and keep either side's code out of the other's.
const src = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const read = (p) => readFileSync(join(src, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const names = (list) => list.split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean);
const exportsOf = (p) => {
  const s = read(p);
  const out = new Set([...s.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([\w$]+)/gm)].map((m) => m[1]));
  for (const m of s.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const n of names(m[1])) out.add(n);
  return out;
};
// static imports of a module: [specifier, imported names or null]
const importsOf = (p) => {
  const s = read(p);
  return [...s.matchAll(/^\s*(?:import|export)\s+(?:([\s\S]*?)\s+from\s+)?'([^']+)'/gm)].map((m) => [m[2], m[1]?.match(/\{([^}]*)\}/) ? names(m[1].match(/\{([^}]*)\}/)[1]) : null]);
};
const resolveFrom = (from, spec) => (spec.startsWith('.') ? relative(src, resolve(dirname(join(src, from)), spec)) : null);
// every module reachable from an entry by static imports, '#host' bound to host
function graph(entry, host) {
  const seen = new Map();
  const walk = (p) => {
    if (seen.has(p) || !p.endsWith('.js')) return;
    const deps = importsOf(p);
    seen.set(p, deps);
    for (const [spec] of deps) {
      const to = spec === '#host' ? host : resolveFrom(p, spec);
      if (to && existsSync(join(src, to))) walk(to);
    }
  };
  walk(entry);
  return seen;
}

test('both hosts export exactly what the contract names', () => {
  const desktop = exportsOf('host/desktop.js');
  assert.deepEqual([...desktop].sort(), [...HOST_NAMES].sort(), 'host/desktop.js re-exports the contract, no more, no less');
  const app = exportsOf('app.js');
  for (const n of HOST_NAMES) assert.ok(app.has(n), `app.js exports ${n} for the desktop host`);
  const alone = exportsOf('sulfur/host.js');
  for (const n of HOST_NAMES) assert.ok(alone.has(n), `sulfur/host.js exports ${n}`);
});

test('Sulfur reaches its host only through #host, and only the contract\'s names', () => {
  const contract = new Set(HOST_NAMES);
  for (const [entry, host] of [['sulfur/main.js', 'sulfur/host.js'], ['sulfur/workbench.js', 'host/desktop.js']]) {
    for (const [p, deps] of graph(entry, host)) {
      if (p === host || p === 'host/desktop.js') continue;
      for (const [spec, imported] of deps) {
        const to = resolveFrom(p, spec);
        assert.notEqual(to, 'app.js', `${p} imports the desktop's app.js; use '#host'`);
        assert.ok(!to?.startsWith('apps/') || to === 'apps/terminal.js', `${p} imports the desktop's ${to}`);
        if (spec === '#host') for (const n of imported || []) assert.ok(contract.has(n), `${p} imports ${n} from '#host', which the contract (src/host/contract.js) lacks`);
      }
    }
  }
});

test('the desktop reaches Sulfur only by loading its workbench', () => {
  const desktop = graph('main.js', 'host/desktop.js');
  for (const p of desktop.keys()) assert.ok(!p.startsWith('sulfur/'), `the desktop statically imports ${p}`);
  assert.match(read('app.js'), /import\('\.\/sulfur\/workbench\.js'\)/);
});
