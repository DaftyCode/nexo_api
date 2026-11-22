// Contract tests of connection types of the person's own (DB-25): the engine applies their
// rules to every statement whatever the client asks (confirming changes of structure, commits
// by hand, only reading, a time limit), and a connection whose type no longer exists stays
// closed rather than losing its confirmations. The test driver; no server needed.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';
import { dbClient } from './db-client.mjs';

const environment = process.env;
let server;
const { save, call, ok } = dbClient(() => server);

const type = (id, value) =>
  server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind: 'connection-type',
    name: id,
    revision: 0,
    updated_at: 0,
    value,
  });
const execute = (session, sql, extra = {}) =>
  call('db.execute', { session, statement: `q-${Math.random()}`, sql, ...extra });

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  await server.api('PUT', '/secrets/db-password:typed', { value: 'secret' });
});
after(async () => {
  await server?.stop();
});

const connection = (kind) => ({
  driver: 'test',
  database: 'shop',
  user: 'ana',
  password: '{{vault:db-password:typed}}',
  type: kind,
});

test('a type of your own confirms changes of structure and commits by hand', async () => {
  assert.equal((await type('staging', { confirmStructure: true, autoCommit: false })).status, 200);
  const wrong = await type('broken', { readOnly: 'yes' });
  assert.equal(wrong.status, 400);
  assert.equal((await save('staged', connection('staging'))).status, 200);
  await ok('db.connect', { connectionId: 'staged', session: 's1' });
  const state = await ok('db.transaction', { session: 's1', action: 'status' });
  assert.equal(state.autoCommit, false);
  const refused = await execute('s1', 'CREATE TABLE t (a int)');
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /asks to confirm changes of structure/);
  await ok('db.disconnect', { session: 's1' });
});

test('a read-only type keeps every session from writing', async () => {
  await type('audit', { readOnly: true, autoCommit: true });
  await save('audited', connection('audit'));
  await ok('db.connect', { connectionId: 'audited', session: 's2' });
  const refused = await execute('s2', "INSERT INTO people VALUES ('Ada')", { confirm: true });
  assert.match(refused.body.error, /is read-only/);
  await ok('db.disconnect', { session: 's2' });
});

test('a connection whose type no longer exists stays closed', async () => {
  await save('orphan', connection('gone'));
  const refused = await call('db.connect', { connectionId: 'orphan', session: 's3' });
  assert.equal(refused.status, 400);
  assert.equal(
    refused.body.error,
    'The type of this connection no longer exists: choose another one',
  );
});
