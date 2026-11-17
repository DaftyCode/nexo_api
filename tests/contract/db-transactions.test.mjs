// Contract tests of transactions through Nexo, with two sessions on one database: what one
// writes in manual commit is seen by the other only after its commit, a rollback undoes it,
// the pending ones are listed with their log, and an isolation level holds. SQLite needs no
// server and always runs; PostgreSQL needs tools/sql-fixture.sh.
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
const single = async (session, sql) => (await run(session, sql)).rows[0][0];
const transaction = (session, action, isolation) =>
  server.execute('db.transaction', { session, action, ...(isolation ? { isolation } : {}) });

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-transactions-'));
  const file = join(folder, 'shop.db');
  assert.equal(
    (await save('lite', { driver: 'sqlite', database: file, params: { create: 'true' } })).status,
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

test('a manual transaction is seen by another session only once committed', async () => {
  await connect('lite', 'writer');
  await connect('lite', 'reader');
  await run('writer', 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
  const manual = await transaction('writer', 'manual');
  assert.equal(manual.autoCommit, false);
  await run('writer', "INSERT INTO items (label) VALUES ('lamp')");
  assert.equal(await single('reader', 'SELECT count(*) FROM items'), 0);
  // The pending transaction is listed with its log, and its counters are in its state.
  const pending = await server.execute('db.transactions', {});
  const writer = pending.sessions.find((session) => session.session === 'writer');
  assert.equal(writer.statements, 1);
  assert.equal(writer.writes, 1);
  assert.match(writer.log[0].sql, /INSERT INTO items/);
  assert.equal(
    pending.sessions.some((session) => session.session === 'reader'),
    false,
  );
  const status = await transaction('writer', 'status');
  assert.equal(status.open, true);
  assert.equal(status.statements, 1);
  const committed = await transaction('writer', 'commit');
  assert.equal(committed.open, false);
  assert.equal(committed.statements, 0);
  assert.equal(await single('reader', 'SELECT count(*) FROM items'), 1);
  // A rollback undoes what the transaction wrote.
  await run('writer', "INSERT INTO items (label) VALUES ('desk')");
  await transaction('writer', 'rollback');
  assert.equal(await single('reader', 'SELECT count(*) FROM items'), 1);
  assert.deepEqual((await server.execute('db.transactions', {})).sessions, []);
  for (const session of ['writer', 'reader']) await server.execute('db.disconnect', { session });
});

test('an isolation level holds for the transaction it begins', { skip: postgres }, async () => {
  await connect('pg', 'snapshot');
  await connect('pg', 'other');
  await run('other', 'CREATE TABLE IF NOT EXISTS shop.isolation_check (n int)');
  await run('other', 'DELETE FROM shop.isolation_check');
  await transaction('snapshot', 'manual');
  await transaction('snapshot', 'begin', 'repeatable read');
  assert.equal(Number(await single('snapshot', 'SELECT count(*) FROM shop.isolation_check')), 0);
  await run('other', 'INSERT INTO shop.isolation_check VALUES (1)');
  // Repeatable read: the transaction keeps seeing what it saw first.
  assert.equal(Number(await single('snapshot', 'SELECT count(*) FROM shop.isolation_check')), 0);
  await transaction('snapshot', 'commit');
  // Back to auto-commit: a manual session would hold the table with its next read.
  await transaction('snapshot', 'auto');
  assert.equal(Number(await single('snapshot', 'SELECT count(*) FROM shop.isolation_check')), 1);
  await run('other', 'DROP TABLE shop.isolation_check', { confirmName: 'isolation_check' });
});
