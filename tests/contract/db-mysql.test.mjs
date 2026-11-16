// Contract tests of the MySQL module through Nexo, against MySQL and MariaDB: the driver runs
// as its own process, on connections saved in the workspace with their password in the vault.
// They need the servers of tools/sql-fixture.sh, and are skipped without them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_SQL_MYSQL_HOST ? false : 'start tools/sql-fixture.sh';
let server;
/** A saved connection to the fixture's MySQL (`MYSQL`) or MariaDB (`MARIADB`). */
const connection = (id, flavour, value = {}) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: `MySQL ${id}`,
  revision: 0,
  updated_at: 0,
  value: {
    driver: 'mysql',
    host: '{{host}}',
    port: Number(environment[`NEXO_SQL_${flavour}_PORT`]),
    database: environment[`NEXO_SQL_${flavour}_DATABASE`],
    user: environment[`NEXO_SQL_${flavour}_USER`],
    password: '{{vault:db-password:my}}',
    ...value,
  },
});
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  await server.api('PUT', '/secrets/db-password:my', {
    value: environment.NEXO_SQL_MYSQL_PASSWORD,
  });
  for (const document of [
    connection('my', 'MYSQL'),
    connection('maria', 'MARIADB'),
    connection('my-read', 'MYSQL', { readOnly: true }),
  ])
    assert.equal((await server.api('PUT', '/documents', document)).status, 200);
});
after(async () => {
  await server?.stop();
});

const connect = (id, session, extra = {}) =>
  server.execute('db.connect', {
    connectionId: id,
    session,
    variables: { host: environment.NEXO_SQL_MYSQL_HOST },
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

test('the MySQL module answers through Nexo, for MySQL and MariaDB', { skip }, async () => {
  for (const [id, product] of [
    ['my', /^8\./],
    ['maria', /^11\./],
  ]) {
    const session = `${id}-1`;
    const opened = await connect(id, session);
    assert.match(opened.serverVersion, product);
    assert.equal(opened.database, 'shop');
    const found = await run(session, 'SELECT id, email FROM customers WHERE id = ?', {
      params: [1],
    });
    assert.equal(found.status, 200, JSON.stringify(found.body));
    assert.deepEqual(found.body.rows, [[1, 'ana@example.com']]);
    // A procedure with two results gives both; the editor shows each in its tab.
    const both = await run(session, 'CALL two_results()');
    assert.deepEqual(both.body.rows, [[1]]);
    assert.equal(both.body.results.length, 1);
    const tables = await server.execute('db.tree', {
      session,
      path: ['databases', 'shop', 'tables'],
    });
    assert.deepEqual(
      tables.nodes.map((node) => node.name),
      ['customers', 'every_type', 'numbers', 'orders', 'zero_dates'],
    );
    const ddl = await server.execute('db.ddl', {
      session,
      path: ['databases', 'shop', 'tables', 'orders'],
    });
    assert.match(ddl.sql, /^CREATE TABLE `orders`/);
  }
  const driver = await server.execute('db.dialect', { driver: 'mysql' });
  assert.equal(driver.dialect.name, 'mysql');
  assert.equal(driver.dialect.quoteOpen, '`');
  assert.equal(driver.capabilities.cancel, true);
});

test('a syntax error says its number and where it is', { skip }, async () => {
  await connect('my', 'my-2');
  const failed = await run('my-2', 'SELECT 1,\n  2 FORM t');
  assert.equal(failed.status, 400);
  assert.equal(failed.body.code, 'database.syntax');
  assert.equal(failed.body.detail.number, 1064);
  assert.deepEqual([failed.body.detail.line, failed.body.detail.column], [2, 10]);
});

test('a slow statement is cancelled at once and the session goes on', { skip }, async () => {
  await connect('my', 'my-3');
  const started = Date.now();
  const running = server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session: 'my-3',
    statement: 'sleepy',
    sql: 'SELECT SLEEP(60)',
  });
  await new Promise((done) => setTimeout(done, 300));
  await server.execute('db.cancel', { session: 'my-3', statement: 'sleepy' });
  const cancelled = await running;
  assert.equal(cancelled.body.code, 'database.cancelled');
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`);
  const next = await run('my-3', 'SELECT 7');
  assert.deepEqual(next.body.rows, [[7]]);
});

test('a read-only connection is refused writes by Nexo', { skip }, async () => {
  await connect('my-read', 'my-4');
  const insert = await run('my-4', "INSERT INTO customers (email) VALUES ('x@example.com')", {
    confirm: true,
  });
  assert.match(insert.body.error, /read-only/);
  assert.doesNotMatch(server.logs(), new RegExp(environment.NEXO_SQL_MYSQL_PASSWORD));
});

test('an editor session opens on another database of the server', { skip }, async () => {
  const opened = await connect('my', 'editor:sys', { database: 'information_schema' });
  assert.equal(opened.database, 'information_schema');
  const current = await run('editor:sys', 'SELECT DATABASE()');
  assert.deepEqual(current.body.rows, [['information_schema']]);
  await server.execute('db.disconnect', { session: 'editor:sys' });
});
