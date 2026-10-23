import test from 'node:test';
import assert from 'node:assert/strict';
import { cmakeTargets, cmakeConfiguration, targetForFile, executableCommand } from '../src/sulfur/project-targets.js';

function fixture(configurations) {
  const files = new Map([
    ['index-1.json', { objects: [{ kind: 'codemodel', version: { major: 2 }, jsonFile: 'model.json' }] }],
    ['model.json', { paths: { source: 'D:/src/claymore' }, configurations }],
    ['editor.json', { id: 'editor', name: 'ClaymoreEditor.exe', type: 'EXECUTABLE', nameOnDisk: 'Claymore.exe', artifacts: [{ path: 'Release/Claymore.pdb' }, { path: 'Release/Claymore.exe' }], dependencies: [{ id: 'core' }] }],
    ['runtime.json', { id: 'runtime', name: 'ClaymoreRuntime', type: 'EXECUTABLE', nameOnDisk: 'GameRuntime.exe', artifacts: [{ path: 'runtime/Release/GameRuntime.exe' }], sources: [{ path: 'src/runtime.cpp' }], dependencies: [{ id: 'core' }] }],
    ['core.json', { id: 'core', name: 'Core', type: 'STATIC_LIBRARY', artifacts: [{ path: 'Core.lib' }], sources: [{ path: 'src/engine.cpp' }] }],
  ]);
  return {
    root: 'Projects/claymore/build', windows: true,
    list: async () => [{ name: 'index-1.json' }],
    read: async (path) => JSON.stringify(files.get(path.split('/').pop())),
  };
}
const targets = [{ id: 'editor', jsonFile: 'editor.json' }, { id: 'runtime', jsonFile: 'runtime.json' }, { id: 'core', jsonFile: 'core.json' }];

test('CMake target names map to the selected configuration executable, excluding PDBs and libraries', async () => {
  const result = await cmakeTargets({ ...fixture([{ name: 'Release', targets }]), configuration: 'Release' });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].target, 'ClaymoreEditor.exe');
  assert.equal(result.items[0].executable, 'Projects/claymore/build/Release/Claymore.exe');
  assert.ok(result.items.every((x) => x.executable.endsWith('.exe')));
});

test('a missing Release configuration never selects a Debug executable', async () => {
  const result = await cmakeTargets({ ...fixture([{ name: 'Debug', targets }]), configuration: 'Release' });
  assert.equal(result.configurationMissing, true);
  assert.deepEqual(result.items, []);
});

test('engine source follows dependencies to its project application and runtime source chooses runtime', async () => {
  const result = await cmakeTargets({ ...fixture([{ name: 'Release', targets }]), configuration: 'Release' });
  assert.equal(targetForFile(result, 'D:/src/claymore/src/engine.cpp', null, 'claymore', true).target, 'ClaymoreEditor.exe');
  assert.equal(targetForFile(result, 'D:/src/claymore/src/runtime.cpp', null, 'claymore', true).target, 'ClaymoreRuntime');
  assert.equal(targetForFile(result, 'D:/src/claymore/src/runtime.cpp', { target: 'ClaymoreEditor.exe' }, 'claymore', true).target, 'ClaymoreRuntime', 'the active source target takes precedence over an unrelated remembered startup target');
  assert.equal(targetForFile(result, 'D:/src/claymore/src/engine.cpp', { target: 'ClaymoreRuntime' }, 'claymore', true).target, 'ClaymoreRuntime');
});

test('Visual Studio profile names resolve to their CMake configuration and executable paths are quoted', () => {
  assert.equal(cmakeConfiguration({ configuration: 'x64-Release', toolchain: { id: 'cmake-vs' } }, { cmakeSettings: [{ name: 'x64-Release', configurationType: 'RelWithDebInfo' }] }), 'RelWithDebInfo');
  assert.equal(executableCommand('out/build/Release/Claymore.exe', true), '"out\\build\\Release\\Claymore.exe"');
  assert.equal(executableCommand('build/release/my app'), "'./build/release/my app'");
});
