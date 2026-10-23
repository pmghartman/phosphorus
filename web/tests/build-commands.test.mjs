import test from 'node:test';
import assert from 'node:assert/strict';
import { singleFileCommand, configsFor } from '../src/sulfur/build-commands.js';

test('CMakeSettings profiles retain the project names and presets retain preset names', () => {
  assert.deepEqual(configsFor({ toolchain: { id: 'cmake-vs' } }, { cmakeSettings: [{ name: 'x64-Debug' }, { name: 'x64-Release' }, { name: 'x64-Shipping' }] }), ['x64-Debug', 'x64-Release', 'x64-Shipping']);
  assert.deepEqual(configsFor({ toolchain: { id: 'cmake-preset' } }, { presets: [{ name: 'linux-release' }] }), ['linux-release']);
});

test('configured CMake trees expose custom configurations and standard build types', () => {
  const cfg = { toolchain: { id: 'cmake-tree', dir: 'build' } };
  assert.deepEqual(configsFor(cfg, { trees: [{ dir: 'build', configs: ['Release', 'RelWithDebugInfo'] }] }), ['Release', 'RelWithDebugInfo']);
  assert.ok(configsFor(cfg, { trees: [{ dir: 'build', type: 'Release' }] }).includes('RelWithDebInfo'));
  assert.ok(configsFor({ toolchain: { id: 'cmake-clang' } }, {}).includes('RelWithDebInfo'));
});

test('POSIX builds use a writable scratch directory and quote the absolute source', () => {
  const command = singleFileCommand('cc -g "{f}" -o "{o}"', "/read-only/O'Brien/test.c", 'test', false, '123');
  assert.ok(command.includes('mktemp -d "${TMPDIR:-/tmp}/sulfur-build.XXXXXXXX"'));
  assert.ok(command.indexOf('cd "$work"') < command.indexOf('cc -g'));
  assert.ok(command.includes("'/read-only/O'\\''Brien/test.c'"));
  assert.ok(command.includes("-o 'test'"));
  assert.ok(command.includes('Build output: %s'));
});

test('MSVC builds put all side products in a unique TEMP working directory', () => {
  const command = singleFileCommand('cl /Zi "{f}" /Fe:"{o}"', 'D:\\Read Only\\test.c', 'test.exe', true, 'abc');
  assert.ok(command.startsWith('mkdir "%TEMP%\\sulfur-build-abc" && cd /d "%TEMP%\\sulfur-build-abc" && cl'));
  assert.ok(command.includes('"D:\\Read Only\\test.c" /Fe:"test.exe"'));
  assert.ok(!command.includes('/Fe:"D:'));
});
