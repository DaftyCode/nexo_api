// Contract tests of MongoDB in saved database tasks (DB-40): a saved transfer copies the
// documents its compiled query reads into another collection, and a saved comparison says
// its differences and syncs the target only when the task authorizes it. The task runs
// through `db.task.run`, as the scheduler runs it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

const database = 'nexo_tasks';
const writer = { connection: seeded, connectionId: 'tasks', database };
const put = (id, kind, name, value) =>
  server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind,
    name,
    revision: 0,
    updated_at: 0,
    value,
  });
const runTask = (id) => server.api('POST', '/execute/db.task.run', { workspace: 'local', id });
const count = (collection, filter = {}) =>
  server.execute('mongo.count', {
    connection: seeded,
    database,
    collection,
    filter,
    id: `count-${Math.random()}`,
  });

test('a saved transfer and a saved comparison run as tasks', plain, async () => {
  await saveConnection('tasks', { uri: environment.NEXO_MONGO_PLAIN });
  await server.execute('mongo.database.drop', { ...writer, confirm: database });
  await server.execute('mongo.import', {
    ...writer,
    collection: 'orders',
    documents: [
      { sku: 'A', status: 'paid', total: { $numberInt: '3' } },
      { sku: 'B', status: 'paid', total: { $numberInt: '5' } },
      { sku: 'C', status: 'draft', total: { $numberInt: '7' } },
    ],
  });
  // The transfer keeps what it reads compiled, as the interface saves it.
  assert.equal(
    (
      await put('tr', 'mongo-transfer', 'Paid orders', {
        direction: 'export',
        connection: 'tasks',
        database,
        collection: 'orders',
        destination: 'collection',
        to: { connection: 'tasks', database, collection: 'paid' },
        mode: 'insert',
        continueOnError: false,
        mask: '',
        built: { query: { filter: { status: 'paid' } } },
      })
    ).status,
    200,
  );
  await put('copy', 'db-task', 'Copy paid', { type: 'mongo-transfer', transfer: 'tr' });
  const copied = await runTask('copy');
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  assert.equal(copied.body.state, 'passed', JSON.stringify(copied.body));
  assert.equal(copied.body.rows, 2);
  assert.equal((await count('paid')).count, 2);

  // The paid copy lacks the draft order: one difference, synced only when authorized.
  await put('cmp', 'mongo-compare', 'Orders ↔ paid', {
    connection: 'tasks',
    database,
    collection: 'orders',
    target: { connection: 'tasks', database, collection: 'paid' },
    filter: "{ sku: { $in: ['A', 'C'] } }",
    builtFilter: { sku: { $in: ['A', 'C'] } },
    key: 'sku',
    ignore: ['_id'],
    remove: false,
  });
  await put('check', 'db-task', 'Check', { type: 'mongo-compare', comparison: 'cmp' });
  const checked = await runTask('check');
  assert.equal(checked.body.state, 'differences', JSON.stringify(checked.body));
  assert.equal(checked.body.differences, 1);
  await put('sync', 'db-task', 'Sync', { type: 'mongo-compare', comparison: 'cmp', sync: true });
  const refused = await runTask('sync');
  assert.equal(refused.body.state, 'failed');
  assert.match(refused.body.error, /does not authorize syncing paid/);
  await put('sync2', 'db-task', 'Sync', {
    type: 'mongo-compare',
    comparison: 'cmp',
    sync: true,
    authorize: { writes: true },
  });
  const synced = await runTask('sync2');
  assert.equal(synced.body.state, 'differences', JSON.stringify(synced.body));
  assert.equal((await count('paid', { sku: 'C' })).count, 1);
  assert.equal((await runTask('check')).body.state, 'passed');
  await server.execute('mongo.database.drop', { ...writer, confirm: database });
});
