import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseGitLog, layoutGitGraph, parseGitChanges } from '../src/sulfur/git-graph.js';

test('raw Git logs preserve full messages, merge parents, refs and author details', () => {
  const hash = 'a'.repeat(40), parent = 'b'.repeat(40), second = 'c'.repeat(40);
  const commits = parseGitLog(`commit ${hash} (HEAD -> main, tag: v1, origin/main)\ntree ${parent}\nparent ${parent}\nparent ${second}\nauthor Example Person <a@example.test> 1700000000 -0600\ncommitter Other Person <b@example.test> 1700000001 +0000\n\n    Summary\n    \n    Body with <html> and tabs\tintact\n    commit ${parent}\n`);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].parents, [parent, second]);
  assert.deepEqual(commits[0].refs, ['HEAD -> main', 'tag: v1', 'origin/main']);
  assert.equal(commits[0].author, 'Example Person');
  assert.equal(commits[0].committer, 'Other Person');
  assert.equal(commits[0].time, 1700000000000);
  assert.equal(commits[0].message, `Summary\n\nBody with <html> and tabs\tintact\ncommit ${parent}`);
});

test('graph lanes split on merges, join shared parents and terminate at roots', () => {
  const graph = layoutGitGraph([
    { hash: 'merge', parents: ['left', 'right'] },
    { hash: 'left', parents: ['base'] },
    { hash: 'right', parents: ['base'] },
    { hash: 'base', parents: [] },
    { hash: 'separate', parents: [] },
  ]);
  assert.equal(graph.columns, 2);
  assert.equal(graph.rows[0].edges.length, 2);
  assert.equal(graph.rows[2].column, 1);
  assert.equal(graph.rows[2].edges.find((e) => e.node).to, 0);
  assert.equal(graph.rows[3].after.length, 0);
  assert.equal(graph.rows[4].incoming, false);
  for (const row of graph.rows) for (const edge of row.edges) assert.ok(edge.to >= 0 && edge.to < row.after.length);
});

test('NUL-delimited changes preserve rename paths, tabs, newlines and binary stats', () => {
  const files = parseGitChanges('R100\0old name\0new\tname\0A\0new\nfile\0M\0asset.bin\0', ['0\t0\t', 'old name', 'new\tname', '3\t0\tnew\nfile', '-\t-\tasset.bin', ''].join('\0'));
  assert.deepEqual(files.map((f) => [f.path, f.from, f.added, f.removed]), [['new\tname', 'old name', '0', '0'], ['new\nfile', '', '3', '0'], ['asset.bin', '', '-', '-']]);
});

test('history and changed-file commands work against real Git, including initial and merge commits', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sulfur-git-graph-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'Graph Test'); git('config', 'user.email', 'graph@example.test'); git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'original.txt'), 'original\n'); git('add', '.'); git('commit', '-m', 'Initial commit', '-m', 'Full commit body.');
  const root = git('rev-parse', 'HEAD').trim();
  git('switch', '-c', 'feature'); renameSync(join(dir, 'original.txt'), join(dir, 'renamed file.txt')); git('add', '-A'); git('commit', '-m', 'Rename file');
  git('switch', 'main'); writeFileSync(join(dir, 'main.txt'), 'main\n'); git('add', '.'); git('commit', '-m', 'Main work'); git('merge', '--no-ff', 'feature', '-m', 'Merge feature');
  const commits = parseGitLog(git('log', '--topo-order', '--decorate=short', '--format=raw', '--no-color', '-n', '101', '--all'));
  assert.equal(commits.length, 4); assert.equal(commits[0].parents.length, 2);
  assert.ok(commits.find((c) => c.hash === root).message.includes('Full commit body.'));
  const merge = commits[0];
  const changes = parseGitChanges(git('diff', '--find-renames', merge.parents[0], merge.hash, '--name-status', '-z', '--'), git('diff', '--find-renames', merge.parents[0], merge.hash, '--numstat', '-z', '--'));
  assert.equal(changes[0].code, 'R'); assert.equal(changes[0].path, 'renamed file.txt'); assert.equal(changes[0].added, '0');
  const first = parseGitChanges(git('show', '--format=', '--find-renames', root, '--name-status', '-z', '--'));
  assert.equal(first[0].path, 'original.txt'); assert.equal(first[0].code, 'A');
  assert.equal(layoutGitGraph(commits).rows.at(-1).after.length, 0);
});
