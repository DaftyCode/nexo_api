// Contract tests of rows edited in the grid (`db.rows.write`) through Nexo, on a SQLite file:
// three changed cells, a new row and a deleted one written as one; nothing written when one
// row is gone; and a read-only connection refusing a save sent straight to the API.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
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
const run = async (session, sql) => {
  const answer = await server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    confirm: true,
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
const write = (session, changes) =>
  server.api('POST', '/execute/db.rows.write', {
    workspace: 'local',
    session,
    table: 'items',
    changes,
  });
const key = (id) => [{ column: 'id', value: id }];

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-rows-'));
  const file = join(folder, 'shop.db');
  assert.equal(
    (await save('lite', { driver: 'sqlite', database: file, params: { create: 'true' } })).status,
    200,
  );
  assert.equal(
    (await save('lite-read', { driver: 'sqlite', database: file, readOnly: true })).status,
    200,
  );
  await server.execute('db.connect', { connectionId: 'lite', session: 'grid' });
  await run(
    'grid',
    'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, price DECIMAL(10, 2), doc TEXT)',
  );
  await run(
    'grid',
    "INSERT INTO items (label, price) VALUES ('lamp', 9.99), ('desk', 120), ('chair', 45)",
  );
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('changed cells, a new row and a deleted one are written as one', async () => {
  const written = await write('grid', [
    {
      kind: 'update',
      key: key(1),
      values: [
        { column: 'label', value: 'LED lamp' },
        { column: 'price', value: { $t: 'decimal', v: '12.50' } },
        { column: 'doc', value: { $t: 'json', v: '{"gift":true}' } },
      ],
    },
    {
      kind: 'insert',
      values: [
        { column: 'label', value: 'shelf' },
        { column: 'price', value: null, default: true },
      ],
    },
    { kind: 'delete', key: key(3) },
  ]);
  assert.equal(written.status, 200, JSON.stringify(written.body));
  assert.equal(written.body.affected, 3);
  const rows = await run('grid', 'SELECT id, label, price, doc FROM items ORDER BY id');
  assert.deepEqual(rows.rows, [
    [1, 'LED lamp', 12.5, '{"gift":true}'],
    [2, 'desk', 120, null],
    [4, 'shelf', null, null],
  ]);
  // The save is in the history, with placeholders instead of values.
  const listing = await server.api('GET', '/documents?workspace=local&lite=true');
  const history = listing.body.filter((document) => document.kind === 'sql-history');
  const saved = await Promise.all(
    history.map(
      async (entry) => (await server.api('GET', `/documents/${entry.id}`)).body.value.sql,
    ),
  );
  const update = saved.find((sql) => sql.startsWith('UPDATE'));
  assert.match(update, /^UPDATE "items" SET "label" = \?/);
  assert.doesNotMatch(update, /LED lamp/);
});

test('a row that is gone saves nothing, and says which change failed', async () => {
  const failed = await write('grid', [
    { kind: 'update', key: key(2), values: [{ column: 'label', value: 'table' }] },
    { kind: 'delete', key: key(99) },
  ]);
  assert.equal(failed.status, 400, JSON.stringify(failed.body));
  assert.match(failed.body.error, /Change 2 was not saved/);
  assert.equal(failed.body.detail.change, 1);
  const label = await run('grid', 'SELECT label FROM items WHERE id = 2');
  assert.deepEqual(label.rows, [['desk']]);
});

test('a read-only connection refuses a save sent straight to the API', async () => {
  await server.execute('db.connect', { connectionId: 'lite-read', session: 'reader' });
  const refused = await write('reader', [
    { kind: 'update', key: key(2), values: [{ column: 'label', value: 'x' }] },
  ]);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /read-only/);
});
