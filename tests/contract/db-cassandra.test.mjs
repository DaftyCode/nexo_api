// Contract tests of the Cassandra module through Nexo, against the node of
// tools/nosql-fixture.sh: the driver runs as its own process on connections saved in the
// workspace. Without the node they are skipped.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_CASSANDRA_HOST ? false : 'start tools/nosql-fixture.sh';
let server;
/** A saved connection to the fixture's node, on the keyspace `shop`. */
const connection = (id, value = {}) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: `Cassandra ${id}`,
  revision: 0,
  updated_at: 0,
  value: {
    driver: 'cassandra',
    host: environment.NEXO_CASSANDRA_HOST,
    port: Number(environment.NEXO_CASSANDRA_PORT),
    database: 'shop',
    params: { localDc: environment.NEXO_CASSANDRA_DC ?? '' },
    ...value,
  },
});
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  for (const document of [connection('ks'), connection('ks-read', { readOnly: true })])
    assert.equal((await server.api('PUT', '/documents', document)).status, 200);
});
after(async () => {
  await server?.stop();
});

const connect = (id, session) =>
  server.execute('db.connect', { workspace: 'local', connectionId: id, session });
const run = (session, sql, extra = {}) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    ...extra,
  });

test('the Cassandra module answers through Nexo', { skip }, async () => {
  const opened = await connect('ks', 'ks-1');
  assert.match(opened.serverVersion, /^\d+\./);
  assert.equal(opened.database, 'shop');
  const found = await run('ks-1', 'SELECT id, a_text FROM every_type WHERE id = ?', {
    params: [1],
  });
  assert.equal(found.status, 200, JSON.stringify(found.body));
  assert.deepEqual(found.body.rows, [[1, "O'Brien"]]);
  const keyspaces = await server.execute('db.tree', { session: 'ks-1', path: [] });
  assert.ok(keyspaces.nodes.some((node) => node.name === 'shop' && node.kind === 'schema'));
  const tables = await server.execute('db.tree', { session: 'ks-1', path: ['shop', 'tables'] });
  assert.deepEqual(
    tables.nodes.map((node) => node.name),
    ['every_type', 'readings'],
  );
  const ddl = await server.execute('db.ddl', {
    session: 'ks-1',
    path: ['shop', 'tables', 'readings'],
  });
  assert.match(ddl.sql, /PRIMARY KEY \(\(sensor, day\), at\)/);
  const driver = await server.execute('db.dialect', { driver: 'cassandra' });
  assert.equal(driver.dialect.name, 'cql');
  assert.equal(driver.capabilities.transactions, false);
});

test(
  'ALLOW FILTERING is confirmed first, and cqlsh commands set the session',
  { skip },
  async () => {
    await connect('ks', 'ks-2');
    const sql = 'SELECT sensor FROM readings WHERE value = ? ALLOW FILTERING';
    const asked = await run('ks-2', sql, { params: [2.5] });
    assert.equal(asked.status, 400);
    assert.match(asked.body.error, /ALLOW FILTERING/);
    const confirmed = await run('ks-2', sql, { params: [2.5], confirm: true });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.deepEqual(confirmed.body.rows, [['s1']]);
    // A batch with its own semicolons travels whole.
    const batch = await run(
      'ks-2',
      "BEGIN BATCH INSERT INTO every_type (id, a_text) VALUES (90, 'a'); INSERT INTO every_type (id, a_text) VALUES (91, 'b'); APPLY BATCH",
    );
    assert.equal(batch.status, 200, JSON.stringify(batch.body));
    const both = await run('ks-2', 'SELECT count(*) FROM every_type WHERE id IN (90, 91)');
    assert.deepEqual(both.body.rows, [[2]]);
    await run('ks-2', 'DELETE FROM every_type WHERE id IN (90, 91)');
    const level = await run('ks-2', 'CONSISTENCY QUORUM');
    assert.equal(level.body.notices[0].message, 'Consistency level set to QUORUM.');
  },
);

test('a read-only connection runs no write, not even in a batch', { skip }, async () => {
  await connect('ks-read', 'ks-3');
  for (const sql of [
    'INSERT INTO every_type (id) VALUES (99)',
    'BEGIN BATCH DELETE FROM every_type WHERE id = 1; APPLY BATCH',
  ]) {
    const refused = await run('ks-3', sql, { confirm: true });
    assert.match(refused.body.error, /read-only/, sql);
  }
  const read = await run('ks-3', 'SELECT id FROM every_type WHERE id = 1');
  assert.deepEqual(read.body.rows, [[1]]);
});
