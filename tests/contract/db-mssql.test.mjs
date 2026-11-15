// Contract tests of the SQL Server module through Nexo: the driver runs as its own process, on
// connections saved in the workspace with their password in the vault. They need the server
// of tools/sql-fixture.sh (x86-64 only), and are skipped without it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_SQL_MSSQL_HOST ? false : 'start tools/sql-fixture.sh';
let server;
const connection = (id, value) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: `SQL Server ${id}`,
  revision: 0,
  updated_at: 0,
  value: {
    driver: 'mssql',
    host: '{{host}}',
    port: Number(environment.NEXO_SQL_MSSQL_PORT),
    database: environment.NEXO_SQL_MSSQL_DATABASE,
    user: environment.NEXO_SQL_MSSQL_USER,
    password: '{{vault:db-password:ms}}',
    ...value,
  },
});
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  await server.api('PUT', '/secrets/db-password:ms', {
    value: environment.NEXO_SQL_MSSQL_PASSWORD,
  });
  for (const [id, value] of [
    ['ms', {}],
    ['ms-read', { readOnly: true }],
  ])
    assert.equal((await server.api('PUT', '/documents', connection(id, value))).status, 200);
});
after(async () => {
  await server?.stop();
});

const connect = (id, session, extra = {}) =>
  server.execute('db.connect', {
    connectionId: id,
    session,
    variables: { host: environment.NEXO_SQL_MSSQL_HOST },
    ...extra,
  });
const run = (session, sql, extra = {}) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    ...extra,
  });

test('the SQL Server module answers through Nexo', { skip }, async () => {
  const opened = await connect('ms', 'ms-1');
  assert.match(opened.serverVersion, /^1\d\./);
  assert.equal(opened.database, 'shop');
  const driver = await server.execute('db.dialect', { driver: 'mssql' });
  assert.equal(driver.dialect.name, 'tsql');
  assert.equal(driver.capabilities.cancel, true);

  const found = await run('ms-1', 'SELECT id, email FROM shop.customers WHERE id = @P1', {
    params: [1],
  });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body.rows, [[1, 'ana@example.com']]);

  // A procedure with two results gives both; the editor shows each in its tab.
  const both = await run('ms-1', 'EXEC shop.two_results');
  assert.equal(both.body.rows.length, 2);
  assert.equal(both.body.results.length, 1);
  assert.equal(both.body.results[0].columns[1].name, 'total');

  const tables = await server.execute('db.tree', {
    session: 'ms-1',
    path: ['databases', 'shop', 'schemas', 'shop', 'tables'],
  });
  assert.deepEqual(
    tables.nodes.map((node) => node.name),
    ['customers', 'orders'],
  );
  const ddl = await server.execute('db.ddl', {
    session: 'ms-1',
    path: ['databases', 'shop', 'schemas', 'shop', 'tables', 'orders'],
  });
  assert.match(ddl.sql, /CREATE TABLE \[shop\]\.\[orders\]/);
});

test('a syntax error says its number and line', { skip }, async () => {
  await connect('ms', 'ms-2');
  const failed = await run('ms-2', 'SELECT 1;\nSELECT FROM');
  assert.equal(failed.status, 400);
  assert.equal(failed.body.code, 'database.syntax');
  assert.equal(failed.body.detail.number, 156);
  assert.equal(failed.body.detail.line, 2);
});

test('a slow statement is cancelled at once and the session goes on', { skip }, async () => {
  await connect('ms', 'ms-3');
  const started = Date.now();
  const running = server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session: 'ms-3',
    statement: 'sleepy',
    sql: "WAITFOR DELAY '00:01:00'",
  });
  await new Promise((done) => setTimeout(done, 300));
  await server.execute('db.cancel', { session: 'ms-3', statement: 'sleepy' });
  const cancelled = await running;
  assert.equal(cancelled.body.code, 'database.cancelled');
  assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms`);
  const next = await run('ms-3', 'SELECT 7');
  assert.deepEqual(next.body.rows, [[7]]);
});

test('a read-only connection is refused writes by Nexo', { skip }, async () => {
  await connect('ms-read', 'ms-4');
  const insert = await run('ms-4', "INSERT INTO shop.customers (email) VALUES (N'x@example.com')", {
    confirm: true,
  });
  assert.match(insert.body.error, /read-only/);
  assert.doesNotMatch(server.logs(), new RegExp(environment.NEXO_SQL_MSSQL_PASSWORD));
});

test('an editor session opens on another database of the server', { skip }, async () => {
  const opened = await connect('ms', 'editor:master', { database: 'master' });
  assert.equal(opened.database, 'master');
  const current = await run('editor:master', 'SELECT DB_NAME()');
  assert.deepEqual(current.body.rows, [['master']]);
  await server.execute('db.disconnect', { session: 'editor:master' });
});
