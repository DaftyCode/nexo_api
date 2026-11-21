// Contract tests of comparing and synchronizing databases (DB-24) on SQLite files: two
// schemas with known differences give exactly those and the script makes them alike; two
// tables of 50 000 rows with known changes give the exact counts and, synchronized, none.
// Two engines side by side are in db-compare-engines.test.mjs.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';
import { compareClient } from './db-compare-client.mjs';

const environment = process.env;
let server;
let folder;
const { save, connect, run, call, ok } = compareClient(() => server);

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-compare-'));
  for (const name of ['a', 'b'])
    await save(`lite-${name}`, {
      driver: 'sqlite',
      database: join(folder, `${name}.db`),
      params: { create: 'true' },
    });
  await save('lite-b-read', { driver: 'sqlite', database: join(folder, 'b.db'), readOnly: true });
  await connect('lite-a', 'a');
  await connect('lite-b', 'b');
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('two schemas differ in exactly what was changed, and the script makes them alike', async () => {
  await run('a', 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, price REAL)');
  await run('a', 'CREATE INDEX items_label ON items (label)');
  await run('a', 'CREATE TABLE extra (id INTEGER PRIMARY KEY, note TEXT)');
  await run('b', 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, price INTEGER)');
  const sides = { source: { session: 'a', path: [] }, target: { session: 'b', path: [] } };
  const compared = await ok('db.compare.schema', sides);
  const shown = compared.objects
    .filter((object) => object.status !== 'equal')
    .map((object) => [
      object.kind,
      object.name,
      object.status,
      object.differences.map((d) => [d.part, d.name, d.status, d.fields]),
    ]);
  assert.deepEqual(shown, [
    ['table', 'extra', 'onlySource', []],
    [
      'table',
      'items',
      'different',
      [
        ['column', 'price', 'different', ['type']],
        ['index', 'items_label', 'onlySource', []],
      ],
    ],
  ]);
  const script = await ok('db.compare.script', sides);
  assert.ok(script.statements.length > 0);
  for (const statement of script.statements) await run('b', statement);
  const again = await ok('db.compare.schema', sides);
  assert.deepEqual(
    again.objects.filter((object) => !['equal', 'equivalent'].includes(object.status)),
    [],
  );
  // The target of a script cannot be read-only or the source itself.
  await connect('lite-b-read', 'b-read');
  const readOnly = await call('db.compare.script', {
    ...sides,
    target: { session: 'b-read', path: [] },
  });
  assert.match(readOnly.body.error, /read-only/);
  const same = await call('db.compare.script', { ...sides, target: sides.source });
  assert.match(same.body.error, /are the same/);
});

test('two tables of 50 000 rows give the exact counts and, synchronized, none', async () => {
  const fill =
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000) INSERT INTO stock SELECT i, 'item ' || i, i % 7 FROM n";
  for (const session of ['a', 'b']) {
    await run(session, 'CREATE TABLE stock (id INTEGER PRIMARY KEY, label TEXT, qty INTEGER)');
    await run(session, fill);
  }
  await run('b', 'DELETE FROM stock WHERE id <= 100');
  await run(
    'b',
    'INSERT INTO stock SELECT id + 50000, label, qty FROM stock WHERE id BETWEEN 101 AND 150',
  );
  await run('b', 'UPDATE stock SET qty = qty + 100 WHERE id BETWEEN 1001 AND 1200');
  const table = (session) => ({ session, path: ['tables', 'stock'], table: 'stock' });
  const sides = { source: table('a'), target: table('b'), statement: 'compare-stock' };
  const compared = await ok('db.compare.data', sides);
  assert.deepEqual(compared.counts, {
    onlySource: 100,
    onlyTarget: 50,
    different: 200,
    equal: 49700,
  });
  assert.deepEqual(compared.key, ['id']);
  assert.equal(compared.differences.length, 350);
  const changed = compared.differences.find((d) => d.kind === 'different');
  assert.deepEqual(changed.columns, ['qty']);
  const script = await ok('db.sync.data', { ...sides, delete: true, script: true });
  assert.equal(script.statements.length, 350);
  assert.match(
    script.statements.find((s) => s.startsWith('UPDATE')),
    /^UPDATE "stock" SET "qty" = \d+ WHERE "id" = \d+;$/,
  );
  // Synchronizing asks for the table's name, never into the source itself.
  const unnamed = await call('db.sync.data', { ...sides, delete: true });
  assert.match(unnamed.body.error, /Type the name of the target table/);
  const itself = await call('db.sync.data', { ...sides, target: table('a'), confirmName: 'stock' });
  assert.match(itself.body.error, /are the same table/);
  await connect('lite-b-read', 'b-read');
  const readOnly = await call('db.sync.data', {
    ...sides,
    target: table('b-read'),
    confirmName: 'stock',
  });
  assert.match(readOnly.body.error, /read-only/);
  const written = await ok('db.sync.data', { ...sides, delete: true, confirmName: 'stock' });
  assert.deepEqual(written, { inserted: 100, updated: 200, deleted: 50, equal: 49700 });
  const after = await ok('db.compare.data', sides);
  assert.deepEqual(after.counts, { onlySource: 0, onlyTarget: 0, different: 0, equal: 50000 });
});
