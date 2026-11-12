// Contract tests for MongoDB writes.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  environment,
  server,
  document,
  plain,
  seeded,
  big,
  find,
  saveConnection,
} from './mongo-fixture.mjs';

// Ids of this file's own queries.
let queries = 0;

// Writes, against a database of their own that each run creates and drops.

const writes = (operation, payload, connectionId = 'writer') =>
  server.execute(operation, {
    connection: seeded,
    connectionId,
    database: 'nexo_writes',
    ...payload,
  });
const undo = (change) =>
  server.execute('mongo.undo', { connection: seeded, connectionId: 'writer', change });
const readBack = async (filter) =>
  (
    await server.execute('mongo.find', {
      connection: seeded,
      database: 'nexo_writes',
      collection: 'items',
      id: `read-${++queries}`,
      filter,
    })
  ).documents;

test('writes keep BSON types, count before many, confirm names and undo', plain, async () => {
  await saveConnection('writer', { uri: environment.NEXO_MONGO_PLAIN });
  await writes('mongo.database.drop', { confirm: 'nexo_writes' });
  await writes('mongo.collection.create', {
    collection: 'items',
    options: { validator: { $jsonSchema: { required: ['name'] } } },
  });
  const inserted = await writes('mongo.insert', {
    collection: 'items',
    documents: [
      {
        _id: 1,
        name: 'a',
        at: { $date: { $numberLong: '1704164645006' } },
        price: { $numberDecimal: '1.10' },
        big: { $numberLong: '9007199254740993' },
      },
      { _id: 2, name: 'b' },
      { name: 'c' },
    ],
  });
  assert.equal(inserted.inserted.length, 3);
  assert.ok(inserted.inserted[2].$oid, 'an _id is chosen for a document without one');
  // The validator refuses a document without a name.
  await assert.rejects(
    writes('mongo.insert', { collection: 'items', documents: [{ x: 1 }] }),
    /validation/i,
  );

  // A field edited with $set keeps its type, and the others are untouched.
  const edited = await writes('mongo.update', {
    collection: 'items',
    filter: { _id: 1 },
    update: {
      $set: { at: { $date: { $numberLong: '1704164700000' } }, price: { $numberDecimal: '2.50' } },
    },
    writeConcern: { w: 'majority', j: true },
  });
  assert.deepEqual([edited.matched, edited.modified], [1, 1]);
  let [first] = await readBack({ _id: 1 });
  assert.deepEqual(first.at, { $date: { $numberLong: '1704164700000' } });
  assert.deepEqual(first.price, { $numberDecimal: '2.50' });
  assert.deepEqual(first.big, { $numberLong: '9007199254740993' });
  // Replaced from its canonical Extended JSON, every type survives.
  await writes('mongo.replace', {
    collection: 'items',
    filter: { _id: 1 },
    replacement: { ...first, name: 'A' },
  });
  [first] = await readBack({ _id: 1 });
  assert.equal(first.name, 'A');
  assert.deepEqual(first.at, { $date: { $numberLong: '1704164700000' } });
  assert.deepEqual(first.big, { $numberLong: '9007199254740993' });

  // Undo puts the document back, and only while it is as the change left it.
  const renamed = await writes('mongo.update', {
    collection: 'items',
    filter: { _id: 2 },
    update: { $set: { name: 'B' } },
  });
  await undo(renamed.change);
  assert.equal((await readBack({ _id: 2 }))[0].name, 'b');
  await assert.rejects(undo(renamed.change), /changed after this change/);
  // A field added since also counts as a change: nothing would be lost silently.
  const again = await writes('mongo.update', {
    collection: 'items',
    filter: { _id: 2 },
    update: { $set: { name: 'C' } },
  });
  await writes('mongo.update', {
    collection: 'items',
    filter: { _id: 2 },
    update: { $set: { note: 'x' } },
  });
  await assert.rejects(undo(again.change), /changed after this change/);
  await writes('mongo.update', {
    collection: 'items',
    filter: { _id: 2 },
    update: { $set: { name: 'b' }, $unset: { note: '' } },
  });

  // Many documents: only with the count confirmed, and the empty filter with the name.
  await assert.rejects(
    writes('mongo.update', {
      collection: 'items',
      filter: {},
      update: { $set: { flag: true } },
      many: true,
    }),
    /Count the documents first/,
  );
  await assert.rejects(
    writes('mongo.update', {
      collection: 'items',
      filter: {},
      update: { $set: { flag: true } },
      many: true,
      expected: 2,
    }),
    /now matches 3 documents, not the 2 confirmed/,
  );
  const many = await writes('mongo.update', {
    collection: 'items',
    filter: {},
    update: [{ $set: { flag: true } }],
    many: true,
    expected: 3,
  });
  assert.deepEqual([many.matched, many.modified], [3, 3]);
  await assert.rejects(
    writes('mongo.insert', {
      collection: 'items',
      documents: [{ name: 'x' }],
      writeConcern: { w: 0 },
    }),
    /Unacknowledged/,
  );

  const removed = await writes('mongo.delete', { collection: 'items', filter: { _id: 2 } });
  assert.equal(removed.deleted, 1);
  await undo(removed.change);
  assert.equal((await readBack({ _id: 2 })).length, 1);
  await assert.rejects(
    writes('mongo.delete', { collection: 'items', filter: {}, many: true, expected: 3 }),
    /Type the name of the collection to confirm: items/,
  );
  const emptied = await writes('mongo.delete', {
    collection: 'items',
    filter: {},
    many: true,
    expected: 3,
    confirm: 'items',
  });
  assert.equal(emptied.deleted, 3);

  await writes('mongo.collection.rename', { collection: 'items', to: 'things' });
  const { collections } = await server.execute('mongo.collections', {
    connection: seeded,
    database: 'nexo_writes',
  });
  assert.deepEqual(
    collections.map((c) => c.name),
    ['things'],
  );
  await assert.rejects(
    writes('mongo.collection.drop', { collection: 'things', confirm: 'thing' }),
    /to confirm: things/,
  );
  await writes('mongo.collection.drop', { collection: 'things', confirm: 'things' });
  await writes('mongo.database.drop', { confirm: 'nexo_writes' });

  // Each write of documents is a workspace document, without any secret.
  const listing = await server.api('GET', '/documents?workspace=local');
  const changes = listing.body.filter((d) => d.kind === 'database-change');
  assert.ok(
    changes.some((d) => d.value.operation === 'mongo.replace' && d.value.changes.length === 1),
  );
});

test('a read-only connection refuses every write in the backend', plain, async () => {
  await saveConnection('reader', { uri: environment.NEXO_MONGO_PLAIN, readOnly: true });
  const refused = [
    ['mongo.insert', { collection: 'big', documents: [{ name: 'x' }] }],
    ['mongo.update', { collection: 'big', filter: { _id: 1 }, update: { $set: { n: 0 } } }],
    ['mongo.replace', { collection: 'big', filter: { _id: 1 }, replacement: { n: 0 } }],
    ['mongo.delete', { collection: 'big', filter: { _id: 1 } }],
    ['mongo.collection.create', { collection: 'other' }],
    ['mongo.collection.rename', { collection: 'big', to: 'small' }],
    ['mongo.collection.drop', { collection: 'big', confirm: 'big' }],
    ['mongo.database.drop', { confirm: 'nexo' }],
  ];
  for (const [operation, payload] of refused) {
    await assert.rejects(
      server.execute(operation, {
        connection: seeded,
        connectionId: 'reader',
        database: 'nexo',
        ...payload,
      }),
      /read-only: Nexo refuses its writes/,
      operation,
    );
  }
  assert.equal((await find({ filter: { _id: 1 } })).documents[0].n.$numberInt, '1');
  // Another URI under the name of a writable connection is refused too.
  await saveConnection('elsewhere', { uri: 'mongodb://127.0.0.1:9' });
  await assert.rejects(
    server.execute('mongo.insert', {
      connection: seeded,
      connectionId: 'elsewhere',
      database: 'nexo',
      collection: 'big',
      documents: [{}],
    }),
    /not the saved one/,
  );
});

// Indexes, explain and the profiler, on a database of their own that each run creates.
