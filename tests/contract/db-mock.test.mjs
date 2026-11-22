// Contract tests of test data (DB-27) on SQLite, which needs no server: ten thousand rows in a
// table with a foreign key, a unique column and a NOT NULL one go in by batches without breaking
// any of them, the same seed makes the same rows, and a production connection takes none.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';
import { dbClient } from './db-client.mjs';

const environment = process.env;
let server;
let folder;
const { save, connect, run, call, ok } = dbClient(() => server);

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-mock-contract-'));
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const columns = (users) => [
  { name: 'id', generator: { kind: 'sequence', start: 1, step: 1 } },
  { name: 'email', generator: { kind: 'catalog', catalog: 'email' }, unique: true, length: 60 },
  { name: 'name', generator: { kind: 'catalog', catalog: 'fullName', language: 'es' } },
  { name: 'user_id', generator: { kind: 'foreign', values: users }, nulls: 0.1 },
  { name: 'total', generator: { kind: 'decimal', min: 1, max: 500, scale: 2 } },
  { name: 'at', generator: { kind: 'date', from: '2024-01-01', to: '2024-12-31' } },
];

test('ten thousand rows go in by batches without breaking a key, a unique or a NOT NULL', async () => {
  await save('mock', {
    driver: 'sqlite',
    database: join(folder, 'mock.db'),
    params: { create: 'true' },
  });
  await connect('mock', 'm1');
  await run('m1', 'CREATE TABLE users (id INTEGER PRIMARY KEY)');
  await run('m1', 'INSERT INTO users (id) VALUES (1), (2), (3), (4), (5)');
  await run(
    'm1',
    `CREATE TABLE orders (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
       user_id INTEGER REFERENCES users (id), total NUMERIC, at TEXT)`,
  );
  const users = (await run('m1', 'SELECT id FROM users')).rows.map(([id]) => id);
  const preview = await ok('db.mock.rows', {
    session: 'm1',
    table: 'orders',
    columns: columns(users),
    seed: 7,
    first: 0,
    count: 20,
  });
  assert.equal(preview.rows.length, 20);
  const again = await ok('db.mock.rows', {
    session: 'm1',
    table: 'orders',
    columns: columns(users),
    seed: 7,
    first: 0,
    count: 20,
  });
  assert.deepEqual(again.rows, preview.rows);
  let inserted = 0;
  for (let first = 0; first < 10_000; first += 2_500) {
    const batch = await ok('db.mock.rows', {
      session: 'm1',
      table: 'orders',
      columns: columns(users),
      seed: 7,
      first,
      count: 2_500,
      write: true,
    });
    assert.equal(batch.failed ?? 0, 0, JSON.stringify(batch.failures?.slice(0, 3)));
    inserted += batch.inserted;
  }
  assert.equal(inserted, 10_000);
  const counted = await run(
    'm1',
    `SELECT count(*), count(DISTINCT email), sum(name IS NULL),
       sum(user_id IS NOT NULL AND user_id NOT IN (SELECT id FROM users)) FROM orders`,
  );
  assert.deepEqual(counted.rows[0], [10_000, 10_000, 0, 0]);
  // The first rows are the ones the preview showed.
  const first = await run('m1', 'SELECT email FROM orders WHERE id = 1');
  assert.equal(first.rows[0][0], preview.rows[0][1]);
  await ok('db.disconnect', { session: 'm1' });
});

test('a production connection takes no test data', async () => {
  await save('mock-prod', {
    driver: 'sqlite',
    database: join(folder, 'prod.db'),
    params: { create: 'true' },
    type: 'production',
  });
  await connect('mock-prod', 'p1');
  const refused = await call('db.mock.rows', {
    session: 'p1',
    table: 't',
    columns: columns([]),
    seed: 1,
    first: 0,
    count: 1,
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /does not take test data/);
  await ok('db.disconnect', { session: 'p1' });
});
