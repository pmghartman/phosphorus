import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { cmakeTargets, targetForFile } from '../src/sulfur/project-targets.js';

function project(name, type = 'Application', extra = '') {
  return `<Project>
  <ItemGroup><ProjectConfiguration Include="Debug|x64"/><ProjectConfiguration Include="Release|x64"/></ItemGroup>
  <PropertyGroup><ProjectName>${name}</ProjectName></PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Debug|x64'"><ConfigurationType>${type}</ConfigurationType></PropertyGroup>
  <PropertyGroup Condition="'$(Configuration)|$(Platform)'=='Release|x64'"><ConfigurationType>${type}</ConfigurationType></PropertyGroup>
  <PropertyGroup>
  <OutDir Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">$(ProjectDir)Debug\\</OutDir>
  <OutDir Condition="'$(Configuration)|$(Platform)'=='Release|x64'">$(ProjectDir)Release\\</OutDir>
  <TargetName Condition="'$(Configuration)|$(Platform)'=='Release|x64'">release-output</TargetName>
  <TargetName Condition="'$(Configuration)|$(Platform)'=='Debug|x64'">debug-output</TargetName>
  <TargetExt>.exe</TargetExt></PropertyGroup>${extra}</Project>`;
}

function fixture() {
  const files = new Map([
    ['D:/project/build/msvc/CMakeCache.txt', 'CMAKE_GENERATOR:INTERNAL=Visual Studio 17 2022\n'],
    ['D:/project/build/msvc/app.sln', 'Project("{id}") = "core", "lib\\core.vcxproj", "{core}"\n'],
    ['D:/project/build/msvc/app.vcxproj', project('app', 'Application', '<ItemGroup><ClCompile Include="D:\\project\\src\\main.cpp"/><ProjectReference Include="lib\\core.vcxproj"/></ItemGroup>')],
    ['D:/project/build/msvc/ALL_BUILD.vcxproj', project('ALL_BUILD', 'Utility')],
    ['D:/project/build/msvc/lib/core.vcxproj', project('core', 'StaticLibrary', '<ItemGroup><ClCompile Include="D:\\project\\src\\core.cpp"/></ItemGroup>')],
  ]);
  const reads = [];
  return {
    files, reads,
    root: 'D:/project/build/msvc', windows: true, configuration: 'Release',
    read: async (p) => { reads.push(p); if (!files.has(p)) throw Error('missing'); return files.get(p); },
    list: async (p) => {
      if (p.includes('.cmake')) throw Error('no File API reply');
      return ['app.sln', 'app.vcxproj', 'ALL_BUILD.vcxproj'].map((name) => ({ name }));
    },
  };
}

test('already generated CMake projects expose the selected executable without configuring or building', async () => {
  const f = fixture();
  const release = await cmakeTargets(f);
  assert.equal(release.available, true);
  assert.equal(release.metadata, 'visual-studio');
  assert.equal(release.items.length, 1, 'libraries and generated utility projects are excluded');
  assert.equal(release.items[0].target, 'app');
  assert.equal(release.items[0].executable, 'D:/project/build/msvc/Release/release-output.exe');
  assert.equal(targetForFile(release, 'D:/project/src/core.cpp', null, 'app', true).target, 'app', 'library source follows project dependencies');
  const debug = await cmakeTargets({ ...f, configuration: 'Debug' });
  assert.equal(debug.items[0].executable, 'D:/project/build/msvc/Debug/debug-output.exe');
  assert.ok(f.reads.includes('D:/project/build/msvc/lib/core.vcxproj'));
});

test('generated metadata does not substitute another configuration or stale projects from another generator', async () => {
  const f = fixture();
  const absent = await cmakeTargets({ ...f, configuration: 'Shipping' });
  assert.equal(absent.configurationMissing, true);
  assert.deepEqual(absent.items, []);
  f.files.set('D:/project/build/msvc/CMakeCache.txt', 'CMAKE_GENERATOR:INTERNAL=Ninja\n');
  assert.deepEqual((await cmakeTargets(f)).items, []);
});

test('XML paths and property conditions select the exact output and reject unresolved MSBuild expressions', async () => {
  const f = fixture();
  f.files.set('D:/project/build/msvc/app.vcxproj', project('app').replace('$(ProjectDir)Release\\', 'D:\\Build &amp; Tools\\$(Configuration)\\'));
  assert.equal((await cmakeTargets(f)).items[0].executable, 'D:/Build & Tools/Release/release-output.exe');
  f.files.set('D:/project/build/msvc/app.vcxproj', project('app').replace('$(ProjectDir)Release\\', '$(UnknownOutputPath)\\'));
  assert.deepEqual((await cmakeTargets(f)).items, []);
});

test('MSVC build commands and File API metadata agree on the same build root', async () => {
  // Exercise the workbench function without initializing a browser or host.
  const source = await fs.readFile(new URL('../src/sulfur/workbench.js', import.meta.url), 'utf8');
  const start = source.indexOf('function tasksFor(cfg, proj) {');
  const end = source.indexOf('// Ctrl+B:', start);
  const tasksFor = vm.runInNewContext(`(${source.slice(start, end).trim()})`);
  for (const configuration of ['Debug', 'Release']) {
    const tasks = tasksFor({ configuration, toolchain: { id: 'cmake-msvc' } }, {});
    assert.equal(tasks.buildRoot, 'build/msvc');
    assert.ok(tasks.find((t) => t.id === 'build').command.includes(`--build ${tasks.buildRoot} --config ${configuration}`));
    assert.ok(tasks.find((t) => t.id === 'configure').command.includes(`-B ${tasks.buildRoot}`));
  }
});
