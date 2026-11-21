// Contract tests of the password of a connection that keeps none (DB-25): one that asks for
// it is opened only with it, keeps it while a session of it is open and asks again after
// (the test driver, always); one that reads PostgreSQL's pgpass file finds its line there
// (the fixture's PostgreSQL). Shell commands that give a password are not offered at all.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';
import { dbClient } from './db-client.mjs';

const environment = process.env;
const postgres = environment.NEXO_SQL_PG_HOST ? false : 'start tools/sql-fixture.sh';
const modules = {
  NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
  NEXO_MODULES_CATALOG: '',
};
let server;
let folder;
const { save, ok, call } = dbClient(() => server);

before(async () => {
  folder = await mkdtemp(join(tmpdir(), 'nexo-passwords-'));
  const pgpass = join(folder, 'pgpass');
  await writeFile(
    pgpass,
    `# lines of other servers first\nelsewhere:*:*:*:wrong\n${environment.NEXO_SQL_PG_HOST ?? 'none'}:${environment.NEXO_SQL_PG_PORT ?? 1}:*:${environment.NEXO_SQL_PG_USER ?? 'none'}:${environment.NEXO_SQL_PG_PASSWORD ?? ''}\n`,
    { mode: 0o600 },
  );
  server = await startServer({ ...modules, NEXO_PGPASS: pgpass });
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

const open = (session, password) =>
  call('db.connect', {
    connectionId: 'asks',
    session,
    ...(password === undefined ? {} : { password }),
  });

test('a connection that asks for its password keeps it while a session of it is open', async () => {
  const connection = { driver: 'test', database: 'shop', user: 'ana', askPassword: true };
  const stored = await save('asks', { ...connection, password: '{{vault:x}}' });
  assert.equal(stored.status, 400);
  assert.match(stored.body.error, /keeps none/);
  assert.equal((await save('asks', connection)).status, 200);

  const asked = await open('a');
  assert.equal(asked.body.code, 'database.password');
  assert.equal(asked.body.detail.connection, 'asks');
  const wrong = await open('a', 'not-it');
  assert.equal(wrong.body.code, 'database.auth');
  assert.doesNotMatch(JSON.stringify(wrong.body), /not-it/);
  // A wrong password is not kept: it is asked for again.
  assert.equal((await open('a')).body.code, 'database.password');
  assert.equal((await open('a', 'secret')).status, 200);
  // Another session of the connection opens without it while the first is open.
  assert.equal((await open('b')).status, 200);
  await ok('db.disconnect', { session: 'a' });
  assert.equal((await open('c')).status, 200);
  await ok('db.disconnect', { session: 'b' });
  await ok('db.disconnect', { session: 'c' });
  // With every session closed, it is asked for again.
  assert.equal((await open('d')).body.code, 'database.password');
  // A test of the connection takes the one typed in the form.
  const tested = await ok('db.test', { connection, password: 'secret' });
  assert.equal(tested.server.serverVersion, '1.0');
});

test(
  'a PostgreSQL connection reads its password from the user pgpass file',
  {
    skip: postgres,
  },
  async () => {
    const value = {
      driver: 'postgres',
      host: environment.NEXO_SQL_PG_HOST,
      port: Number(environment.NEXO_SQL_PG_PORT),
      database: environment.NEXO_SQL_PG_DATABASE,
      user: environment.NEXO_SQL_PG_USER,
      pgpass: true,
    };
    assert.equal((await save('pgpass', value)).status, 200);
    const opened = await ok('db.connect', { connectionId: 'pgpass', session: 'p' });
    assert.match(opened.serverVersion, /^\d+/);
    await ok('db.disconnect', { session: 'p' });
    await save('nobody', { ...value, user: 'nobody' });
    const missing = await call('db.connect', { connectionId: 'nobody', session: 'q' });
    assert.match(missing.body.error, /The pgpass file has no line for .* as nobody/);
    const mysql = await save('mysql', { ...value, driver: 'mysql' });
    assert.match(mysql.body.error, /Only PostgreSQL connections read pgpass/);
  },
);
