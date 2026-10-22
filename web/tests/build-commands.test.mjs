import test from 'node:test';
import assert from 'node:assert/strict';
import { singleFileCommand } from '../src/sulfur/build-commands.js';

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
