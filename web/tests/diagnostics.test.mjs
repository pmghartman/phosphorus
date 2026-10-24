import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticCounts, diagnosticSeverity, diagnosticText, diagnosticsAt, offsetAtColumn, diagnosticDelay } from '../src/sulfur/diagnostics.js';
import { createBuildProblemMatcher } from '../src/sulfur/build-problems.js';

test('warnings, hints and missing severity stay distinct across counts and hover text', () => {
  const warning = { severity: 2, from: 2, to: 5, code: 'CS0649', source: 'csharp', what: 'Field is never assigned' };
  assert.deepEqual(diagnosticCounts([warning, { severity: 4 }, {}]), { errors: 1, warnings: 1, info: 1 });
  assert.equal(diagnosticSeverity({}), 1);
  assert.equal(diagnosticText(warning), 'Warning CS0649 (csharp): Field is never assigned');
  assert.deepEqual(diagnosticsAt([warning], 3), [warning]);
  assert.deepEqual(diagnosticsAt([warning], 5), []);
  assert.deepEqual(diagnosticsAt([warning], null), []);
});

test('hover hit testing handles tabs, CRLF, UTF-16 offsets and empty diagnostics', () => {
  const text = 'x\r\n\t😀name';
  assert.equal(offsetAtColumn(text, 1, 2), 3);
  assert.equal(offsetAtColumn(text, 1, 4), 4);
  assert.equal(offsetAtColumn(text, 1, 5), 6);
  assert.equal(offsetAtColumn(text, 1, 99), null);
  assert.equal(offsetAtColumn(text, 99, 0), null);
  assert.equal(diagnosticsAt([{ from: 1, to: 1, what: 'missing token' }], 1).length, 1);
});

test('the syntax check waits half a second by default and is bounded independently of suggestion timing', () => {
  assert.equal(diagnosticDelay(), 500);
  assert.equal(diagnosticDelay(1500),1500);
  assert.equal(diagnosticDelay(-1),300);
  assert.equal(diagnosticDelay(99999),5000);
});

test('MSBuild warning output and a success summary never become errors, including split chunks', () => {
  const a = createBuildProblemMatcher({ host: 'd6', absRoot: 'C:\\Projects\\game', root: 'game', windows: true });
  a.feed('\x1b[33mC:\\Projects\\game\\scripts\\Camera.cs(15,20): war');
  a.feed("ning CS0649: Field 'Camera.y' is never assigned\x1b[0m\r\nBuild succeeded with 184 warning(s) in 2.5s\r\n"); a.end();
  assert.equal(a.problems.length, 1); assert.equal(a.problems[0].sev, 'warning');
  assert.equal(a.problems[0].code, 'CS0649'); assert.equal(a.problems[0].rel, 'game/scripts/Camera.cs');
  const b = createBuildProblemMatcher({ host: 'd6', absRoot: 'C:\\Projects\\game', root: 'game', windows: true });
  b.feed('C:\\Projects\\game\\A.cs(2,3): error CS0246: Missing type\n'); b.end();
  assert.equal(b.problems[0].sev, 'error'); assert.equal(a.problems.filter(x => x.sev === 'error').length, 0);
});
