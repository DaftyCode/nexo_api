// Contract tests of the PostgreSQL module through Nexo: the driver runs as its own process,
// on connections saved in the workspace with their password in the vault. They need the
// servers of tools/sql-fixture.sh, and are skipped without them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_SQL_PG_HOST ? false : 'start tools/sql-fixture.sh';
let server;
const connection = (id, value) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: `PostgreSQL ${id}`,
  revision: 0,
  updated_at: 0,
  value: {
    driver: 'postgres',
    host: '{{host}}',
    port: Number(environment.NEXO_SQL_PG_PORT),
    database: environment.NEXO_SQL_PG_DATABASE,
    user: environment.NEXO_SQL_PG_USER,
    password: '{{vault:db-password:pg}}',
    ...value,
  },
});
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  await server.api('PUT', '/secrets/db-password:pg', { value: environment.NEXO_SQL_PG_PASSWORD });
  for (const [id, value] of [
    ['pg', {}],
    ['pg-read', { readOnly: true }],
  ])
    assert.equal((await server.api('PUT', '/documents', connection(id, value))).status, 200);
});
after(async () => {
  await server?.stop();
});

const connect = (id, session) =>
  server.execute('db.connect', {
    connectionId: id,
    session,
    variables: { host: environment.NEXO_SQL_PG_HOST },
  });
const run = (session, sql, extra = {}) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    ...extra,
  });

test('the PostgreSQL module answers through Nexo', { skip }, async () => {
  const opened = await connect('pg', 'pg-1');
  assert.match(opened.serverVersion, /^\d+/);
  assert.equal(opened.database, 'shop');
  const driver = await server.execute('db.dialect', { driver: 'postgres' });
  assert.equal(driver.dialect.name, 'postgresql');
  assert.equal(driver.capabilities.cancel, true);

  const found = await run('pg-1', 'SELECT id, email FROM shop.customers WHERE id = $1', {
    params: [1],
  });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body.rows, [[1, 'ana@example.com']]);
  assert.equal(found.body.columns[1].origin.table, 'customers');

  const tables = await server.execute('db.tree', {
    session: 'pg-1',
    path: ['shop', 'schemas', 'shop', 'tables'],
  });
  assert.deepEqual(
    tables.nodes.map((node) => node.name),
    ['customers', 'events', 'orders'],
  );
  const ddl = await server.execute('db.ddl', {
    session: 'pg-1',
    path: ['shop', 'schemas', 'shop', 'tables', 'orders'],
  });
  assert.match(ddl.sql, /CREATE TABLE shop\.orders/);
});

test('a syntax error says where it is', { skip }, async () => {
  await connect('pg', 'pg-2');
  const failed = await run('pg-2', 'SELECT 1,\n  2 FORM t');
  assert.equal(failed.status, 400);
  assert.equal(failed.body.code, 'database.syntax');
  assert.equal(failed.body.detail.sqlstate, '42601');
  // FORM is read as an alias of 2: the error is at t, line 2 column 10.
  assert.deepEqual([failed.body.detail.line, failed.body.detail.column], [2, 10]);
});

test('a slow statement is cancelled within a second', { skip }, async () => {
  await connect('pg', 'pg-3');
  const started = Date.now();
  const running = server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session: 'pg-3',
    statement: 'sleepy',
    sql: 'SELECT pg_sleep(60)',
  });
  await new Promise((done) => setTimeout(done, 300));
  await server.execute('db.cancel', { session: 'pg-3', statement: 'sleepy' });
  const cancelled = await running;
  assert.equal(cancelled.body.code, 'database.cancelled');
  assert.ok(Date.now() - started < 1500, `${Date.now() - started} ms`);
});

test('a read-only connection is refused by Nexo and by the server', { skip }, async () => {
  await connect('pg-read', 'pg-4');
  const insert = await run('pg-4', "INSERT INTO shop.customers (email) VALUES ('x@example.com')", {
    confirm: true,
  });
  assert.match(insert.body.error, /read-only/);
  // A read that writes: only the server can tell, and it refuses.
  const sequence = await run('pg-4', "SELECT nextval('shop.invoice_numbers')");
  assert.equal(sequence.body.code, 'database.permission');
  assert.doesNotMatch(server.logs(), new RegExp(environment.NEXO_SQL_PG_PASSWORD));
});
