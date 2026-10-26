import test from 'node:test';
import assert from 'node:assert/strict';
import { isSQLiteFile, quoteSQLiteIdentifier, sqliteTableQuery, sqliteProjectPath, createSQLiteClient } from '../src/sulfur/sqlite.js';

test('SQLite identifiers remain identifiers, including SQL punctuation and quotes', () => {
  assert.equal(quoteSQLiteIdentifier('a"; DROP TABLE users;--'), '"a""; DROP TABLE users;--"');
  assert.equal(sqliteTableQuery('odd table', 400), 'SELECT * FROM "odd table" LIMIT 201 OFFSET 400');
  for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => sqliteTableQuery('t', offset));
});

test('database creation stays inside the selected project', () => {
  assert.equal(sqliteProjectPath('rpm/project', 'data/app.sqlite'), 'rpm/project/data/app.sqlite');
  assert.equal(sqliteProjectPath('', 'app.sqlite'), 'app.sqlite');
  assert.equal(sqliteProjectPath('rpm/project', 'data\\app.sqlite'), 'rpm/project/data/app.sqlite');
  for (const p of ['', '/other.db', '../other.db', 'x/../../other.db', 'C:\\outside.db', './a.db', 'a//b.db', 'a\x00.db']) assert.equal(sqliteProjectPath('project', p), null);
});

test('native SQLite associations include common extensions only', () => {
  for (const p of ['app.db', 'app.DB3', 'app.sqlite', 'app.SQLITE3']) assert.equal(isSQLiteFile(p), true);
  for (const p of ['app.db-wal', 'app.db-shm', 'app.sql', 'sqlite.js']) assert.equal(isSQLiteFile(p), false);
});

test('a late database response cannot replace a newer result or update a closed view', async () => {
  const calls = [];
  const client = createSQLiteClient((body, signal) => new Promise((resolve) => calls.push({ body, signal, resolve })));
  const first = client.run('query', 'SELECT 1');
  const second = client.run('schema');
  assert.equal(calls[0].signal.aborted, true);
  calls[0].resolve({ rows: [[1]] });
  await assert.rejects(first, { name: 'AbortError' });
  calls[1].resolve({ rows: [] });
  assert.deepEqual(await second, { rows: [] });
  const last = client.run('execute', 'CREATE TABLE example(id)');
  client.dispose();
  assert.equal(calls[2].signal.aborted, true);
  calls[2].resolve({ changes: 0 });
  await assert.rejects(last, { name: 'AbortError' });
  await assert.rejects(client.run('query'), { name: 'AbortError' });
});
