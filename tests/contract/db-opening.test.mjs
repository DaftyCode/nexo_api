// Contract tests of what a database session does as it opens and while it is open (DB-25):
// its startup queries run in every session (SQLite, always); a connection that takes too long
// to open is left at its own time (a server that never answers, always); and with the
// fixture's PostgreSQL, its default schema, and a session the server ended that opens again
// on its next use, rerunning a read but never a write.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';
import { dbClient } from './db-client.mjs';

const environment = process.env;
const postgres = environment.NEXO_SQL_PG_HOST ? false : 'start tools/sql-fixture.sh';
let server;
let folder;
const { save, connect, run, call, ok } = dbClient(() => server);

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-opening-'));
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('every session runs the startup queries of its connection', async () => {
  const file = { driver: 'sqlite', database: join(folder, 'a.db'), params: { create: 'true' } };
  const opened = await save('lite', {
    ...file,
    startupQueries: ['CREATE TEMP TABLE opened (n int)', 'INSERT INTO temp.opened VALUES (7)'],
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  for (const session of ['a', 'b']) {
    await connect('lite', session);
    assert.deepEqual((await run(session, 'SELECT n FROM temp.opened')).rows, [[7]]);
  }
  // A startup query that fails keeps the session closed, unless the connection lets it.
  await save('broken', { ...file, startupQueries: ['SELECT nothing FROM nowhere'] });
  const refused = await call('db.connect', { connectionId: 'broken', session: 'c' });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /^The startup query «SELECT nothing FROM nowhere» failed/);
  await save('lenient', {
    ...file,
    startupQueries: ['SELECT nothing FROM nowhere'],
    ignoreStartupErrors: true,
  });
  const lenient = await ok('db.connect', { connectionId: 'lenient', session: 'd' });
  assert.equal(lenient.startup[0].sql, 'SELECT nothing FROM nowhere');
  // A read-only connection only reads or sets the session as it opens.
  const writing = await save('reader', {
    ...file,
    readOnly: true,
    startupQueries: ['DELETE FROM t'],
  });
  assert.equal(writing.status, 400);
  assert.match(writing.body.error, /only reads or sets the session/);
});

test('a connection that does not open within its own time is left', async () => {
  // A server that takes the connection and never says a word.
  const silent = net.createServer(() => {});
  await new Promise((done) => silent.listen(0, '127.0.0.1', done));
  try {
    await save('silent', {
      driver: 'postgres',
      host: '127.0.0.1',
      port: silent.address().port,
      user: 'nexo',
      connectTimeoutSeconds: 1,
    });
    const started = Date.now();
    const answer = await call('db.connect', { connectionId: 'silent', session: 'e' });
    assert.equal(answer.body.code, 'database.timeout');
    assert.match(answer.body.error, /did not open within 1 s/);
    assert.ok(Date.now() - started < 5_000, `${Date.now() - started} ms`);
  } finally {
    silent.close();
  }
});

test(
  'a session the server ended opens again: a read runs again, a write never',
  {
    skip: postgres,
  },
  async () => {
    await server.api('PUT', '/secrets/db-password:pg', { value: environment.NEXO_SQL_PG_PASSWORD });
    await save('pg', {
      driver: 'postgres',
      host: environment.NEXO_SQL_PG_HOST,
      port: Number(environment.NEXO_SQL_PG_PORT),
      database: environment.NEXO_SQL_PG_DATABASE,
      user: environment.NEXO_SQL_PG_USER,
      password: '{{vault:db-password:pg}}',
    });
    await connect('pg', 'admin');
    await run('admin', 'CREATE SCHEMA IF NOT EXISTS nexo_opening');
    await run('admin', 'CREATE TABLE IF NOT EXISTS nexo_opening.marks (n int)');
    try {
      await save('pg-schema', {
        driver: 'postgres',
        host: environment.NEXO_SQL_PG_HOST,
        port: Number(environment.NEXO_SQL_PG_PORT),
        database: environment.NEXO_SQL_PG_DATABASE,
        user: environment.NEXO_SQL_PG_USER,
        password: '{{vault:db-password:pg}}',
        defaultSchema: 'nexo_opening',
        startupQueries: ["SET application_name = 'nexo-opening'"],
      });
      await connect('pg-schema', 'work');
      const where = await run('work', 'SELECT current_schema(), pg_backend_pid()');
      assert.equal(where.rows[0][0], 'nexo_opening');
      const pid = where.rows[0][1];
      // The server ends the session; its next read opens it again, schema and all.
      await run('admin', `SELECT pg_terminate_backend(${pid})`);
      const again = await ok('db.execute', {
        session: 'work',
        statement: 'q-again',
        sql: "SELECT current_schema(), current_setting('application_name'), pg_backend_pid()",
      });
      assert.equal(again.reconnected, true);
      assert.deepEqual(again.rows[0].slice(0, 2), ['nexo_opening', 'nexo-opening']);
      assert.notEqual(again.rows[0][2], pid);
      // A write is not run again by itself: the person runs it again.
      await run('admin', `SELECT pg_terminate_backend(${again.rows[0][2]})`);
      const write = await call('db.execute', {
        session: 'work',
        statement: 'q-write',
        sql: 'INSERT INTO marks VALUES (1)',
      });
      assert.equal(write.body.code, 'database.reconnected');
      assert.match(write.body.error, /ran nothing\. Run it again/);
      const marks = await run('admin', 'SELECT count(*) FROM nexo_opening.marks');
      assert.equal(Number(marks.rows[0][0]), 0);
      await run('work', 'INSERT INTO marks VALUES (2)');
      await ok('db.disconnect', { session: 'work' });
    } finally {
      await run('admin', 'DROP SCHEMA nexo_opening CASCADE');
      await ok('db.disconnect', { session: 'admin' });
    }
  },
);
