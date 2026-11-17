// Contract tests of execution plans (`db.explain`) through Nexo: on a SQLite file a filter
// scans the table until it has an index, and the actual mode is refused (SQLite has none);
// a read-only connection refuses the actual plan of a change; on PostgreSQL the actual plan
// of an UPDATE is measured and leaves nothing changed. PostgreSQL needs tools/sql-fixture.sh.
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
const explain = (session, sql, mode = 'estimated', extra = {}) =>
  server.api('POST', '/execute/db.explain', {
    workspace: 'local',
    session,
    statement: `plan-${Math.random()}`,
    sql,
    mode,
    ...extra,
  });
const nodes = (list) => list.flatMap((node) => [node, ...nodes(node.children ?? [])]);

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-explain-'));
  const file = join(folder, 'shop.db');
  assert.equal(
    (await save('lite', { driver: 'sqlite', database: file, params: { create: 'true' } })).status,
    200,
  );
  assert.equal(
    (await save('lite-read', { driver: 'sqlite', database: file, readOnly: true })).status,
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

test('a filter scans the table until an index serves it', async () => {
  await connect('lite', 'plans');
  await run('plans', 'CREATE TABLE items (id INTEGER, label TEXT)');
  const query = 'SELECT label FROM items WHERE id = 7';
  const before = await explain('plans', query);
  assert.equal(before.status, 200, JSON.stringify(before.body));
  assert.equal(before.body.mode, 'estimated');
  assert.equal(before.body.format, 'text');
  assert.deepEqual(before.body.nodes[0].flags, ['full-scan']);
  await run('plans', 'CREATE INDEX items_id ON items (id)');
  const after = await explain('plans', query);
  assert.equal(after.body.nodes[0].index, 'items_id');
  const actual = await explain('plans', query, 'actual');
  assert.equal(actual.status, 400);
  assert.equal(actual.body.code, 'database.unsupported');
});

test('a read-only connection refuses the actual plan of a change', async () => {
  await connect('lite-read', 'reading');
  const refused = await explain('reading', "UPDATE items SET label = 'x'", 'actual', {
    confirm: true,
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /read-only/);
  const estimated = await explain('reading', "UPDATE items SET label = 'x'");
  assert.equal(estimated.status, 200, JSON.stringify(estimated.body));
});

test('the actual plan of an UPDATE changes nothing', { skip: postgres }, async () => {
  await connect('pg', 'pg-plans');
  await run('pg-plans', 'DROP TABLE IF EXISTS public.explained', { confirmName: 'explained' });
  await run('pg-plans', 'CREATE TABLE public.explained (id int PRIMARY KEY, label text)');
  await run(
    'pg-plans',
    "INSERT INTO public.explained SELECT n, 'row' FROM generate_series(1, 1000) n",
  );
  const unconfirmed = await explain(
    'pg-plans',
    "UPDATE public.explained SET label = 'changed'",
    'actual',
  );
  assert.equal(unconfirmed.status, 400);
  const plan = await explain(
    'pg-plans',
    "UPDATE public.explained SET label = 'changed' WHERE id <= $1",
    'actual',
    { confirm: true, params: [500] },
  );
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.equal(plan.body.rolledBack, true);
  assert.ok(nodes(plan.body.nodes).some((node) => node.actualRows === 500));
  const changed = await run(
    'pg-plans',
    "SELECT count(*) FROM public.explained WHERE label = 'changed'",
  );
  assert.equal(changed.rows[0][0], 0);
  await run('pg-plans', 'DROP TABLE public.explained', { confirmName: 'explained' });
});
