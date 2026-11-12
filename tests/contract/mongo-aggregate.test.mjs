// Contract tests for MongoDB aggregations: a pipeline of five stages with $lookup previewed
// stage by stage, results read in pages, and $out and $merge run only as confirmed writes,
// against a database of their own that each run drops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

const database = 'nexo_aggregate';
let ids = 0;
let saved;
const connections = () =>
  (saved ??= Promise.all([
    saveConnection('aggregator', { uri: environment.NEXO_MONGO_PLAIN }),
    saveConnection('aggregation-reader', { uri: environment.NEXO_MONGO_PLAIN, readOnly: true }),
  ]));
const writer = (connectionId = 'aggregator') => ({ connection: seeded, connectionId, database });
const aggregate = (collection, pipeline, extra = {}) =>
  server.execute('mongo.aggregate', {
    connection: seeded,
    database,
    collection,
    id: `aggregate-${++ids}`,
    pipeline,
    pageSize: 50,
    ...extra,
  });
const write = (pipeline, confirm, connectionId) =>
  server.execute('mongo.aggregate.write', {
    ...writer(connectionId),
    collection: 'orders',
    id: `write-${++ids}`,
    pipeline,
    confirm,
  });

async function seed() {
  await connections();
  await server.execute('mongo.database.drop', { ...writer(), confirm: database });
  const insert = (collection, documents) =>
    server.execute('mongo.import', { ...writer(), collection, documents });
  await insert('customers', [
    { _id: 1, name: 'Ana', city: 'Lugo' },
    { _id: 2, name: 'Luis', city: 'Vigo' },
    { _id: 3, name: 'Eva', city: 'Lugo' },
  ]);
  await insert(
    'orders',
    Array.from({ length: 30 }, (_, n) => ({
      _id: n,
      customer: (n % 3) + 1,
      status: n % 5 === 0 ? 'cancelled' : 'paid',
      total: { $numberDecimal: `${n}.50` },
    })),
  );
}

// Five stages: paid orders, their customer, one per order, totals by city, the largest first.
const pipeline = [
  { $match: { status: 'paid' } },
  { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'who' } },
  { $unwind: '$who' },
  { $group: { _id: '$who.city', orders: { $sum: 1 }, total: { $sum: '$total' } } },
  { $sort: { total: -1 } },
];

test('a pipeline of five stages with $lookup is previewed stage by stage', plain, async () => {
  await seed();
  const previews = [];
  for (let stage = 0; stage < pipeline.length; stage++) {
    // As the interface previews a stage: the stages up to it and a limit at the end.
    const page = await aggregate('orders', [...pipeline.slice(0, stage + 1), { $limit: 10 }], {
      pageSize: 10,
    });
    assert.ok(page.documents.length <= 10);
    previews.push(page.documents);
  }
  assert.ok(previews[0].every((order) => order.status === 'paid'));
  assert.equal(previews[1][0].who.length, 1, 'each order joined to its customer');
  assert.equal(typeof previews[2][0].who.city, 'string', '$unwind leaves one customer');
  assert.deepEqual(previews[4].map((group) => group._id).sort(), ['Lugo', 'Vigo']);
  // Decimal128 is kept through the stages, in canonical Extended JSON.
  const lugo = previews[4].find((group) => group._id === 'Lugo');
  assert.equal(lugo.orders.$numberInt, '16');
  assert.match(lugo.total.$numberDecimal, /^\d+\.\d+$/);
  assert.equal(previews[3].length, 2);
});

test('the results of a pipeline are read in pages through its cursor', plain, async () => {
  await connections();
  const read = { connection: seeded, database: 'nexo', collection: 'big' };
  let page = await server.execute('mongo.aggregate', {
    ...read,
    id: `aggregate-${++ids}`,
    pipeline: [{ $match: { n: { $lt: 2500 } } }, { $sort: { n: 1 } }, { $project: { n: 1 } }],
    pageSize: 1000,
    allowDiskUse: true,
    maxTimeMS: 30_000,
  });
  const seen = [...page.documents];
  while (page.cursor) {
    page = await server.execute('mongo.more', {
      cursor: page.cursor,
      id: `more-${++ids}`,
      pageSize: 1000,
    });
    seen.push(...page.documents);
  }
  assert.equal(seen.length, 2500);
  assert.deepEqual(seen.at(-1), { _id: { $numberInt: '2499' }, n: { $numberInt: '2499' } });

  await assert.rejects(
    server.execute('mongo.aggregate', { ...read, id: 'x', pipeline: [], pageSize: 10 }),
    /Add at least one stage/,
  );
  await assert.rejects(
    server.execute('mongo.aggregate', {
      ...read,
      id: 'x',
      pipeline: [{ $match: {} }],
      maxTimeMS: 600_000,
    }),
    /maxTimeMS is at most 60000/,
  );
  // The server's own errors come back as they are.
  await assert.rejects(
    server.execute('mongo.aggregate', { ...read, id: 'x', pipeline: [{ $nothing: 1 }] }),
    /\$nothing/,
  );
});

test('$out and $merge write only as confirmed writes on a writable connection', plain, async () => {
  await seed();
  const out = [...pipeline, { $out: 'by_city' }];
  await assert.rejects(aggregate('orders', out), /A pipeline with \$out writes/);
  await assert.rejects(
    write(out, 'by_city', 'aggregation-reader'),
    /is read-only: Nexo refuses its writes/,
  );
  await assert.rejects(write(out, 'orders'), /Type the name of the collection to confirm: by_city/);
  await assert.rejects(
    write([{ $out: 'a' }, { $match: {} }], 'a'),
    /Only a pipeline that ends in \$out or \$merge/,
  );
  // Nothing was written while it was refused.
  const listed = async () =>
    (await server.execute('mongo.collections', { connection: seeded, database })).collections
      .map((collection) => collection.name)
      .sort();
  assert.deepEqual(await listed(), ['customers', 'orders']);

  const written = await write(out, 'by_city');
  assert.deepEqual(
    { database: written.database, collection: written.collection },
    { database, collection: 'by_city' },
  );
  const cities = await aggregate('by_city', [{ $sort: { _id: 1 } }]);
  assert.deepEqual(
    cities.documents.map((city) => city._id),
    ['Lugo', 'Vigo'],
  );

  // $merge into another collection, named in `into`, adds to what it has.
  const merge = [
    { $match: { status: 'cancelled' } },
    { $project: { status: 1 } },
    { $merge: { into: 'cancelled', whenMatched: 'replace', whenNotMatched: 'insert' } },
  ];
  await write(merge, 'cancelled');
  await write(merge, 'cancelled');
  const cancelled = await aggregate('cancelled', [{ $count: 'n' }]);
  assert.deepEqual(cancelled.documents, [{ n: { $numberInt: '6' } }]);

  await server.execute('mongo.database.drop', { ...writer(), confirm: database });
});
