// Contract tests of the Ignite module through Nexo, against the Ignite 3 nodes of
// tools/nosql-fixture.sh: the driver runs as its own process on connections saved in the
// workspace, one with TLS and its password in the vault. Without the nodes they are skipped.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_IGNITE_HOST ? false : 'start tools/nosql-fixture.sh';
let server;
const connection = (id, value) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: id,
  revision: 0,
  updated_at: 0,
  value: { driver: 'ignite', host: environment.NEXO_IGNITE_HOST, ...value },
});
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  await server.api('PUT', '/secrets/db-password:ignite', {
    value: environment.NEXO_IGNITE_PASSWORD,
  });
  const open = connection('ig', { port: Number(environment.NEXO_IGNITE_PORT), database: 'SHOP' });
  const secure = connection('igs', {
    port: Number(environment.NEXO_IGNITE_SECURE_PORT),
    user: environment.NEXO_IGNITE_USER,
    password: '{{vault:db-password:ignite}}',
    tls: { mode: 'require' },
  });
  for (const document of [open, secure])
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

test(
  'the Ignite module answers through Nexo, by pages of its server cursor',
  { skip },
  async () => {
    const opened = await server.execute('db.connect', {
      workspace: 'local',
      connectionId: 'ig',
      session: 'ig-1',
    });
    assert.match(opened.product, /^Apache Ignite/);
    assert.match(opened.serverVersion, /^3\./);
    const schemas = await server.execute('db.tree', { session: 'ig-1', path: [] });
    assert.ok(schemas.nodes.some((node) => node.name === 'SHOP'));
    // The connection's database is the default schema: ITEMS needs no prefix.
    const first = await run('ig-1', 'SELECT ID FROM ITEMS ORDER BY ID', { pageRows: 50 });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.rows.length, 50);
    assert.ok(first.body.cursor);
    const next = await server.execute('db.fetch', {
      session: 'ig-1',
      cursor: first.body.cursor,
      pageRows: 50,
    });
    assert.deepEqual(next.rows[0], [51]);
    const ddl = await server.execute('db.ddl', { session: 'ig-1', path: ['SHOP', 'ITEMS'] });
    assert.match(ddl.sql, /ZONE "SHOP_ZONE"/);
    const plan = await server.api('POST', '/execute/db.explain', {
      workspace: 'local',
      session: 'ig-1',
      statement: 'p',
      sql: 'SELECT * FROM ITEMS WHERE ID = 1',
      mode: 'estimated',
    });
    assert.equal(plan.status, 200, JSON.stringify(plan.body));
    assert.equal(plan.body.format, 'text');
    assert.ok(plan.body.original.length > 0);
  },
);

test('a node with TLS takes the password from the vault', { skip }, async () => {
  const opened = await server.execute('db.connect', {
    workspace: 'local',
    connectionId: 'igs',
    session: 'igs-1',
  });
  assert.equal(opened.tls, true);
  assert.equal(opened.user, environment.NEXO_IGNITE_USER);
  const one = await run('igs-1', 'SELECT 1 AS one');
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(one.body.rows, [[1]]);
  assert.ok(!JSON.stringify(one.body).includes(environment.NEXO_IGNITE_PASSWORD));
});
