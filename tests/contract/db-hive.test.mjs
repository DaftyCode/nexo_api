// Contract tests of the Hive module through Nexo, against the HiveServer2 of
// tools/nosql-fixture.sh in HTTP mode: the driver runs as its own process on a connection
// saved in the workspace, its password in the vault. Without the server they are skipped.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_HIVE_HOST ? false : 'start tools/nosql-fixture.sh';
let server;
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  await server.api('PUT', '/secrets/db-password:hive', { value: environment.NEXO_HIVE_PASSWORD });
  const document = {
    id: 'hv',
    workspace_id: 'local',
    kind: 'connection',
    name: 'Hive',
    revision: 0,
    updated_at: 0,
    value: {
      driver: 'hive',
      host: environment.NEXO_HIVE_HOST,
      port: Number(environment.NEXO_HIVE_PORT),
      user: environment.NEXO_HIVE_USER,
      password: '{{vault:db-password:hive}}',
      database: 'default',
    },
  };
  assert.equal((await server.api('PUT', '/documents', document)).status, 200);
});
after(async () => {
  await server?.stop();
});

const run = (session, sql, extra = {}) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    ...extra,
  });

test('the Hive module answers through Nexo, by pages of its server cursor', { skip }, async () => {
  const opened = await server.execute('db.connect', {
    workspace: 'local',
    connectionId: 'hv',
    session: 'hv-1',
  });
  assert.equal(opened.product, 'Apache Hive');
  assert.match(opened.serverVersion, /^4\./);
  const databases = await server.execute('db.tree', { session: 'hv-1', path: [] });
  assert.ok(databases.nodes.some((node) => node.name === 'default'));
  const first = await run(
    'hv-1',
    "SELECT pos FROM (SELECT posexplode(split(space(119), ' ')) AS (pos, val)) t ORDER BY pos",
    { pageRows: 50 },
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.rows.length, 50);
  assert.ok(first.body.cursor);
  const next = await server.execute('db.fetch', {
    session: 'hv-1',
    cursor: first.body.cursor,
    pageRows: 50,
  });
  assert.deepEqual(next.rows[0], [50]);
  const plan = await server.api('POST', '/execute/db.explain', {
    workspace: 'local',
    session: 'hv-1',
    statement: 'p',
    sql: 'SELECT 1',
    mode: 'estimated',
  });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.match(plan.body.original, /Stage/);
});

test('commands that reach the files of the server are never sent', { skip }, async () => {
  await server.execute('db.connect', { workspace: 'local', connectionId: 'hv', session: 'hv-2' });
  const refused = await run('hv-2', 'ADD JAR /tmp/x.jar');
  assert.notEqual(refused.status, 200);
  assert.match(JSON.stringify(refused.body), /does not send commands/);
});
