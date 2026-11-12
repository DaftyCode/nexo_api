// Contract tests for MongoDB change streams: a standalone server is explained, and on a
// replica set of one member an insert, an update and a delete arrive in order through the
// realtime operations, a pipeline filters them and a resume token starts after a change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

const replica = { skip: !environment.NEXO_MONGO_REPLICA_SET };
const database = 'nexo_watch';
const connection = () => ({ uri: environment.NEXO_MONGO_REPLICA_SET });
const target = () => ({ connection: connection(), connectionId: 'watcher', database });
const write = (operation, payload) =>
  server.execute(operation, { ...target(), collection: 'items', ...payload });

/** The events of a change stream until `count` of them have the types wanted. */
async function changes(id, count, types = ['insert', 'update', 'replace', 'delete']) {
  const found = [];
  let after = 0;
  for (let round = 0; round < 100 && found.length < count; round++) {
    const answer = await server.execute('realtime.poll', { id, after });
    for (const event of answer.events) {
      after = event.sequence;
      if (types.includes(event.type)) found.push(event);
    }
    if (found.length < count) await new Promise((done) => setTimeout(done, 100));
  }
  return found;
}

test('a standalone server has no change streams, and says so', plain, async () => {
  await assert.rejects(
    server.execute('mongo.watch', { connection: seeded, database: 'nexo', collection: 'big' }),
    /need a replica set or a sharded cluster/,
  );
});

test('inserts, updates and deletes arrive in order, filtered and resumed', replica, async () => {
  await saveConnection('watcher', connection());
  await server.execute('mongo.database.drop', { ...target(), confirm: database });
  await server.execute('mongo.collection.create', { ...target(), collection: 'items' });

  const opened = await server.execute('mongo.watch', {
    connection: connection(),
    database,
    collection: 'items',
    fullDocument: 'updateLookup',
  });
  assert.match(opened.id, /^mongo-watch-/);
  assert.equal(opened.state, 'connected');
  // Only inserts, for the whole database.
  const inserts = await server.execute('mongo.watch', {
    connection: connection(),
    database,
    pipeline: [{ $match: { operationType: 'insert' } }],
  });

  await write('mongo.insert', { documents: [{ _id: 1, n: { $numberInt: '1' } }] });
  await write('mongo.update', { filter: { _id: 1 }, update: { $set: { n: 2 } } });
  await write('mongo.delete', { filter: { _id: 1 } });

  const [insert, update, remove] = await changes(opened.id, 3);
  assert.deepEqual([insert.type, update.type, remove.type], ['insert', 'update', 'delete']);
  assert.deepEqual(insert.data.ns, { db: database, coll: 'items' });
  assert.deepEqual(insert.data.documentKey, { _id: { $numberInt: '1' } });
  assert.deepEqual(update.data.updateDescription.updatedFields, { n: { $numberInt: '2' } });
  assert.deepEqual(update.data.fullDocument, { _id: { $numberInt: '1' }, n: { $numberInt: '2' } });
  assert.ok(insert.sequence < update.sequence && update.sequence < remove.sequence);
  const onlyInserts = await changes(inserts.id, 1);
  assert.deepEqual(
    onlyInserts.map((event) => event.type),
    ['insert'],
  );

  const listed = await server.execute('realtime.list', {});
  const mine = listed.find((session) => session.id === opened.id);
  assert.deepEqual(mine, {
    id: opened.id,
    protocol: 'mongodb',
    url: `${database}.items`,
    state: 'connected',
  });
  await assert.rejects(
    server.execute('realtime.send', { id: opened.id, message: 'x' }),
    /only receives/,
  );

  // After the insert: the update and the delete come again.
  const resumed = await server.execute('mongo.watch', {
    connection: connection(),
    database,
    collection: 'items',
    resumeAfter: insert.data._id._data,
  });
  const again = await changes(resumed.id, 2);
  assert.deepEqual(
    again.map((event) => event.type),
    ['update', 'delete'],
  );

  for (const session of [opened, inserts, resumed])
    assert.deepEqual(await server.execute('realtime.close', { id: session.id }), { closed: true });
  await assert.rejects(server.execute('realtime.poll', { id: opened.id }), /Connection not found/);

  // Dropping the collection ends its change stream.
  const ending = await server.execute('mongo.watch', {
    connection: connection(),
    database,
    collection: 'items',
  });
  await server.execute('mongo.database.drop', { ...target(), confirm: database });
  const end = await changes(ending.id, 1, ['invalidate']);
  assert.equal(end[0]?.type, 'invalidate');
  await server.execute('realtime.close', { id: ending.id });
});
