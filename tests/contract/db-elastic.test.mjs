// Contract tests of the Elasticsearch module through Nexo, against the Elasticsearch and
// OpenSearch of tools/nosql-fixture.sh: the driver runs as its own process, on connections
// saved in the workspace with their password in the vault. Without them they are skipped.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_ELASTIC_HOST ? false : 'start tools/nosql-fixture.sh';
let server;
/** A saved connection to the fixture's Elasticsearch (`ELASTIC`) or OpenSearch (`OPENSEARCH`). */
const connection = (id, flavour, value = {}) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: `Search ${id}`,
  revision: 0,
  updated_at: 0,
  value: {
    driver: 'elastic',
    host: environment.NEXO_ELASTIC_HOST,
    port: Number(environment[`NEXO_${flavour}_PORT`]),
    user: environment[`NEXO_${flavour}_USER`],
    password: '{{vault:db-password:search}}',
    ...(flavour === 'OPENSEARCH' ? { tls: { mode: 'require' } } : {}),
    ...value,
  },
});
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  await server.api('PUT', '/secrets/db-password:search', {
    value: environment.NEXO_SEARCH_PASSWORD,
  });
  for (const document of [
    connection('es', 'ELASTIC'),
    connection('os', 'OPENSEARCH'),
    connection('es-read', 'ELASTIC', { readOnly: true }),
  ])
    assert.equal((await server.api('PUT', '/documents', document)).status, 200);
});
after(async () => {
  await server?.stop();
});

const connect = (id, session) =>
  server.execute('db.connect', { workspace: 'local', connectionId: id, session });
const rest = (session, payload) =>
  server.api('POST', '/execute/db.rest.request', { workspace: 'local', session, ...payload });
const run = (session, sql) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
  });

test('both engines answer SQL and the console through Nexo', { skip }, async () => {
  for (const [id, product] of [
    ['es', /^Elasticsearch/],
    ['os', /^OpenSearch/],
  ]) {
    const session = `${id}-1`;
    const opened = await connect(id, session);
    assert.match(opened.product, product);
    const fields = await server.execute('db.tree', { session, path: ['indices', 'shop'] });
    assert.ok(fields.nodes.some((node) => node.name === 'user.address.city'));
    const sql = await run(session, 'SELECT name FROM shop WHERE price > 40 ORDER BY price');
    assert.equal(sql.status, 200, JSON.stringify(sql.body));
    assert.deepEqual(sql.body.rows, [['Chair'], ['Desk']]);
    const search = await rest(session, {
      method: 'POST',
      path: 'shop/_search',
      body: { query: { range: { price: { gt: 40 } } }, sort: [{ price: 'asc' }] },
    });
    assert.deepEqual(
      search.body.body.hits.hits.map((hit) => hit._source.name),
      ['Chair', 'Desk'],
    );
    const cat = await rest(session, { method: 'GET', path: '_cat/indices' });
    assert.equal(cat.body.status, 200);
  }
});

test('deleting an index asks for its name, also through the API', { skip }, async () => {
  await connect('es', 'es-2');
  await rest('es-2', { method: 'PUT', path: 'contract-tmp' });
  const refused = await rest('es-2', { method: 'DELETE', path: 'contract-tmp' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Type contract-tmp to confirm it/);
  const wildcard = await rest('es-2', { method: 'DELETE', path: 'contract-*', confirm: true });
  assert.match(wildcard.body.error, /Type contract-\* to confirm it/);
  const typed = await rest('es-2', {
    method: 'DELETE',
    path: 'contract-tmp',
    confirmName: 'contract-tmp',
  });
  assert.equal(typed.body.status, 200);
  const outside = await rest('es-2', { method: 'GET', path: 'http://127.0.0.1:1/_search' });
  assert.equal(outside.status, 400);
});

test('a read-only connection refuses writes, also through the API', { skip }, async () => {
  await connect('es-read', 'es-3');
  const put = await rest('es-3', { method: 'PUT', path: 'shop/_doc/9', body: { name: 'x' } });
  assert.match(put.body.error, /read-only/);
  const drop = await rest('es-3', { method: 'DELETE', path: 'shop', confirmName: 'shop' });
  assert.match(drop.body.error, /read-only/);
  const read = await rest('es-3', { method: 'POST', path: 'shop/_count' });
  assert.equal(read.body.body.count, 3);
  assert.doesNotMatch(server.logs(), new RegExp(environment.NEXO_SEARCH_PASSWORD));
});
