// Contract tests of searching through Nexo (`db.search`): objects by name and in code, a
// value in the data of tables with its wildcards taken literally, and, on PostgreSQL, a slow
// search cancelled on the server. SQLite always runs; PostgreSQL needs tools/sql-fixture.sh.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const postgres = environment.NEXO_SQL_PG_HOST ? false : 'start tools/sql-fixture.sh';
let server;
let folder;
const save = (id, value) =>
  server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind: 'connection',
    name: id,
    revision: 0,
    updated_at: 0,
    value,
  });
const connect = (id, session) =>
  server.execute('db.connect', {
    connectionId: id,
    session,
    variables: { host: environment.NEXO_SQL_PG_HOST ?? '' },
  });
const run = async (session, sql, extra = {}) => {
  const answer = await server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    confirm: true,
    ...extra,
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
const search = (session, body) =>
  server.api('POST', '/execute/db.search', {
    workspace: 'local',
    session,
    statement: `find-${Math.random()}`,
    ...body,
  });

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-search-'));
  assert.equal(
    (
      await save('lite', {
        driver: 'sqlite',
        database: join(folder, 'shop.db'),
        params: { create: 'true' },
      })
    ).status,
    200,
  );
  if (!postgres) {
    await server.api('PUT', '/secrets/db-password:pg', { value: environment.NEXO_SQL_PG_PASSWORD });
    const value = {
      driver: 'postgres',
      host: '{{host}}',
      port: Number(environment.NEXO_SQL_PG_PORT),
      database: environment.NEXO_SQL_PG_DATABASE,
      user: environment.NEXO_SQL_PG_USER,
      password: '{{vault:db-password:pg}}',
    };
    assert.equal((await save('pg', value)).status, 200);
  }
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('objects are found by name and in code, and values in the data', async () => {
  await connect('lite', 'find');
  await run('find', 'CREATE TABLE orders (id INTEGER, order_note TEXT)');
  await run('find', 'CREATE TABLE notes (id INTEGER, body TEXT)');
  await run('find', "INSERT INTO orders VALUES (1, 'it''s 50%_off'), (2, 'plain')");
  await run('find', "INSERT INTO notes VALUES (3, 'IT''S 50%_OFF too'), (4, 'nothing')");
  await run('find', 'CREATE VIEW open_orders AS SELECT * FROM orders WHERE id > 0');
  const objects = await search('find', { text: '%order%', code: true });
  assert.equal(objects.status, 200, JSON.stringify(objects.body));
  const found = objects.body.objects.map((hit) => `${hit.kind}:${hit.name}`);
  for (const expected of ['table:orders', 'view:open_orders', 'column:order_note'])
    assert.ok(found.includes(expected), found.join(', '));
  assert.deepEqual(objects.body.objects.find((hit) => hit.kind === 'table').path, [
    'tables',
    'orders',
  ]);

  const tables = [{ name: 'orders' }, { name: 'notes' }];
  const data = await search('find', { mode: 'data', text: "it's 50%_off", tables });
  assert.equal(data.status, 200, JSON.stringify(data.body));
  assert.deepEqual(
    data.body.data.map((hit) => [hit.table, hit.matched, hit.rows.length]),
    [
      ['orders', ['order_note'], 1],
      ['notes', ['body'], 1],
    ],
  );
  const literal = await search('find', { mode: 'data', text: '50%off', tables });
  assert.deepEqual(literal.body.data ?? [], []);
  const cased = await search('find', { mode: 'data', text: "IT'S", tables, caseSensitive: true });
  assert.deepEqual(
    cased.body.data.map((hit) => hit.table),
    ['notes'],
  );
});

test('a slow data search is cancelled on the server', { skip: postgres }, async () => {
  await connect('pg', 'pg-find');
  const view = `slow_${Date.now()}`;
  await run('pg-find', `CREATE VIEW public.${view} AS SELECT pg_sleep(20)::text AS waited`);
  const statement = `find-${Date.now()}`;
  const started = Date.now();
  const searching = server.api('POST', '/execute/db.search', {
    workspace: 'local',
    session: 'pg-find',
    statement,
    mode: 'data',
    text: 'anything',
    tables: [{ schema: 'public', name: view }],
  });
  await new Promise((done) => setTimeout(done, 1500));
  await server.execute('db.cancel', { session: 'pg-find', statement });
  const cancelled = await searching;
  assert.equal(cancelled.status, 400, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.code, 'database.cancelled');
  assert.ok(Date.now() - started < 15_000);
  await run('pg-find', `DROP VIEW public.${view}`, { confirmName: view });
});
