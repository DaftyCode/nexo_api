// Contract tests of data transfers through Nexo: a table copied page by page into a table
// created for it (`db.convert`, `db.copy`), rows imported in batches with their failures said
// by position (`db.import`), and a batch stopped at its first failure leaving nothing. SQLite
// always runs; the 100 000 rows of PostgreSQL need tools/sql-fixture.sh.
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

/** Copies what `sql` reads into `table` of `target`, page by page, as the wizard does. */
async function copy(source, target, sql, table, extra = {}) {
  const total = { read: 0, inserted: 0, failed: 0 };
  let cursor;
  let columns;
  do {
    const answer = await server.api('POST', '/execute/db.copy', {
      workspace: 'local',
      source,
      target,
      table,
      ...(cursor ? { cursor, columns } : { sql }),
      first: total.read + 1,
      ...extra,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    total.read += answer.body.read;
    total.inserted += answer.body.inserted;
    total.failed += answer.body.failed;
    cursor = answer.body.cursor;
    columns ??= answer.body.columns?.map((column) => column.name);
  } while (cursor);
  return total;
}

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-transfer-'));
  for (const name of ['source', 'target'])
    assert.equal(
      (
        await save(`lite-${name}`, {
          driver: 'sqlite',
          database: join(folder, `${name}.db`),
          params: { create: 'true' },
        })
      ).status,
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

test('a table is copied into a table created for it, page by page', async () => {
  await connect('lite-source', 'from');
  await connect('lite-target', 'to');
  await run('from', 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, price REAL)');
  await run(
    'from',
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2500) INSERT INTO items SELECT i, 'item ' || i, i * 1.5 FROM n",
  );
  const probe = await run('from', 'SELECT * FROM items WHERE 1 = 0');
  const converted = await server.execute('db.convert', {
    session: 'to',
    table: 'copied',
    columns: probe.columns,
    sourceDriver: 'sqlite',
  });
  assert.match(converted.sql, /^CREATE TABLE "copied"/);
  await run('to', converted.sql);
  const total = await copy('from', 'to', 'SELECT * FROM items', 'copied');
  assert.deepEqual(total, { read: 2500, inserted: 2500, failed: 0 });
  assert.equal(await single('to', 'SELECT count(*) FROM copied'), 2500);
  assert.equal(
    await single('to', 'SELECT sum(price) FROM copied'),
    await single('from', 'SELECT sum(price) FROM items'),
  );
  const writes = await server.api('POST', '/execute/db.copy', {
    workspace: 'local',
    source: 'from',
    target: 'to',
    table: 'copied',
    sql: 'DELETE FROM items',
  });
  assert.equal(writes.status, 400);
});

test('imported rows say their failures, and a stop leaves nothing', async () => {
  await connect('lite-target', 'import');
  await run('import', 'CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const batch = (rows, stopOnError) =>
    server.api('POST', '/execute/db.import', {
      workspace: 'local',
      session: 'import',
      table: 'people',
      columns: ['id', 'name'],
      rows,
      stopOnError,
      first: 101,
    });
  const going = await batch(
    [
      [1, 'Ana'],
      [2, null],
      [3, 'Eva'],
    ],
    false,
  );
  assert.equal(going.status, 200, JSON.stringify(going.body));
  assert.equal(going.body.inserted, 2);
  assert.equal(going.body.failures[0].position, 102);
  assert.match(going.body.failures[0].message, /NOT NULL/);
  const stopped = await batch(
    [
      [4, 'Leo'],
      [5, null],
    ],
    true,
  );
  assert.equal(stopped.body.stopped, true);
  assert.equal(await single('import', 'SELECT count(*) FROM people'), 2);
});

test('the 100 000 rows of PostgreSQL are copied whole', { skip: postgres }, async () => {
  await connect('pg', 'pg-from');
  await connect('pg', 'pg-to');
  const table = `numbers_copy_${Date.now()}`;
  const probe = await run('pg-from', 'SELECT * FROM public.numbers WHERE 1 = 0');
  const converted = await server.execute('db.convert', {
    session: 'pg-to',
    table,
    schema: 'public',
    columns: probe.columns,
    sourceDriver: 'postgres',
  });
  await run('pg-to', converted.sql);
  const total = await copy('pg-from', 'pg-to', 'SELECT * FROM public.numbers', table, {
    schema: 'public',
    stopOnError: true,
    pageRows: 5000,
  });
  assert.deepEqual(total, { read: 100000, inserted: 100000, failed: 0 });
  assert.equal(
    await single(
      'pg-to',
      `SELECT count(*) FROM public.${table} t JOIN public.numbers n USING (n) WHERE t.label = n.label`,
    ),
    100000,
  );
  await run('pg-to', `DROP TABLE public.${table}`, { confirmName: table });
});
