// Contract tests of the structure editor through Nexo (`db.ddl.model`, `db.ddl.plan`): a table
// made from a model reads back with its key, foreign key and index; a change plans the
// engine's statements; a drop does not run without the table's name typed, not even sent
// straight to the API; and a read-only connection plans no change. On SQLite, always.
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
const execute = (session, sql, extra = {}) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    confirm: true,
    ...extra,
  });
const plan = (session, original, target) =>
  server.execute('db.ddl.plan', {
    session,
    ...(original ? { original } : {}),
    ...(target ? { target } : {}),
  });

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-structure-'));
  const file = join(folder, 'shop.db');
  assert.equal(
    (await save('lite', { driver: 'sqlite', database: file, params: { create: 'true' } })).status,
    200,
  );
  assert.equal(
    (await save('lite-read', { driver: 'sqlite', database: file, readOnly: true })).status,
    200,
  );
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a table made from a model reads back, changes and drops only by its name', async () => {
  await server.execute('db.connect', { connectionId: 'lite', session: 'edit' });
  assert.equal((await execute('edit', 'CREATE TABLE people (id INTEGER PRIMARY KEY)')).status, 200);
  const types = await server.execute('db.ddl.model', { session: 'edit' });
  assert.ok(types.types.includes('INTEGER'));
  const table = {
    name: 'orders',
    columns: [
      { name: 'id', typeName: 'INTEGER', nullable: false, identity: true },
      { name: 'person', typeName: 'INTEGER', nullable: true, identity: false },
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [
      {
        columns: ['person'],
        referencedTable: 'people',
        referencedColumns: ['id'],
        onDelete: 'CASCADE',
      },
    ],
    indexes: [{ name: 'orders_person', columns: ['person'], unique: false }],
  };
  const created = await plan('edit', undefined, table);
  for (const sql of created.statements) assert.equal((await execute('edit', sql)).status, 200);
  const model = await server.execute('db.ddl.model', {
    session: 'edit',
    path: ['tables', 'orders'],
  });
  assert.deepEqual(
    model.table.columns.map((column) => [column.name, column.typeName, column.identity ?? false]),
    [
      ['id', 'INTEGER', true],
      ['person', 'INTEGER', false],
    ],
  );
  assert.equal(model.table.foreignKeys[0].onDelete, 'CASCADE');
  assert.equal(model.table.indexes[0].name, 'orders_person');

  const changed = structuredClone(model.table);
  changed.columns.push({ name: 'note', typeName: 'TEXT', nullable: true, identity: false });
  const altered = await plan('edit', model.table, changed);
  assert.deepEqual(altered.statements, ['ALTER TABLE "orders" ADD COLUMN "note" TEXT']);

  const dropped = await plan('edit', model.table, undefined);
  assert.deepEqual(dropped.statements, ['DROP TABLE "orders"']);
  const unnamed = await execute('edit', dropped.statements[0]);
  assert.equal(unnamed.status, 400);
  assert.match(unnamed.body.error, /Type the name/);
  assert.equal(
    (await execute('edit', dropped.statements[0], { confirmName: 'orders' })).status,
    200,
  );
});

test('a read-only connection plans no change of structure', async () => {
  await server.execute('db.connect', { connectionId: 'lite-read', session: 'read' });
  const refused = await server.api('POST', '/execute/db.ddl.plan', {
    workspace: 'local',
    session: 'read',
    target: {
      name: 'x',
      columns: [{ name: 'a', typeName: 'TEXT', nullable: true, identity: false }],
    },
  });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /read-only/);
});
