// Contract tests for SQL on MongoDB: a battery of SELECTs translated by the engine gives the
// same documents as the same query written by hand in MongoDB, against MongoDB 8.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

let ids = 0;
/** The documents of a query (`find` or `aggregate`), as the explorer would run it. */
async function run(database, query) {
  const where = {
    connection: seeded,
    database,
    collection: query.collection,
    id: `sql-${++ids}`,
    pageSize: 1000,
  };
  if (query.kind === 'aggregate')
    return (await server.execute('mongo.aggregate', { ...where, pipeline: query.pipeline }))
      .documents;
  const { kind: _, collection: __, ...fields } = query;
  return (await server.execute('mongo.find', { ...where, ...fields })).documents;
}
const sql = async (database, text) =>
  run(database, await server.execute('mongo.sql', { sql: text }));

test('SQL gives the same documents as MongoDB written by hand', plain, async () => {
  const battery = [
    [
      "SELECT n, status FROM big WHERE n < 20 AND status = 'A' ORDER BY n DESC",
      {
        kind: 'find',
        collection: 'big',
        filter: { n: { $lt: 20 }, status: 'A' },
        projection: { _id: 0, n: 1, status: 1 },
        sort: { n: -1 },
      },
    ],
    [
      "SELECT customer.address.city AS city, COUNT(*) AS n, MAX(n) AS top FROM big WHERE status IN ('A', 'B') GROUP BY customer.address.city ORDER BY city",
      {
        kind: 'aggregate',
        collection: 'big',
        pipeline: [
          { $match: { status: { $in: ['A', 'B'] } } },
          { $group: { _id: '$customer.address.city', n: { $sum: 1 }, top: { $max: '$n' } } },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, city: '$_id', n: 1, top: 1 } },
        ],
      },
    ],
    [
      "SELECT n FROM big WHERE customer.name LIKE 'Customer 99%' AND n < 2000 ORDER BY n LIMIT 5",
      {
        kind: 'find',
        collection: 'big',
        filter: { 'customer.name': { $regex: '^Customer 99' }, n: { $lt: 2000 } },
        projection: { _id: 0, n: 1 },
        sort: { n: 1 },
        limit: 5,
      },
    ],
    [
      'SELECT n FROM big WHERE n BETWEEN 10 AND 30 ORDER BY n LIMIT 5 OFFSET 3',
      {
        kind: 'find',
        collection: 'big',
        filter: { n: { $gte: 10, $lte: 30 } },
        projection: { _id: 0, n: 1 },
        sort: { n: 1 },
        skip: 3,
        limit: 5,
      },
    ],
    [
      'SELECT status, COUNT(*) AS c FROM big GROUP BY status HAVING COUNT(*) > 24000 ORDER BY status',
      {
        kind: 'aggregate',
        collection: 'big',
        pipeline: [
          { $group: { _id: '$status', c: { $sum: 1 } } },
          { $match: { c: { $gt: 24000 } } },
          { $sort: { _id: 1 } },
          { $project: { _id: 0, status: '$_id', c: 1 } },
        ],
      },
    ],
    [
      "SELECT n FROM big WHERE at >= TIMESTAMP '2024-01-01 00:10:00' AND n < 15 ORDER BY n",
      {
        kind: 'find',
        collection: 'big',
        filter: { at: { $gte: { $date: '2024-01-01T00:10:00Z' } }, n: { $lt: 15 } },
        projection: { _id: 0, n: 1 },
        sort: { n: 1 },
      },
    ],
    [
      "SELECT AVG(n) AS average, MIN(n) AS low, SUM(n) AS total FROM big WHERE customer.address.city = 'Madrid' AND n < 100",
      {
        kind: 'aggregate',
        collection: 'big',
        pipeline: [
          { $match: { 'customer.address.city': 'Madrid', n: { $lt: 100 } } },
          {
            $group: {
              _id: null,
              average: { $avg: '$n' },
              low: { $min: '$n' },
              total: { $sum: '$n' },
            },
          },
          { $project: { _id: 0 } },
        ],
      },
    ],
  ];
  for (const [text, byHand] of battery) {
    const translated = await sql('nexo', text);
    assert.ok(translated.length > 0, text);
    assert.deepEqual(translated, await run('nexo', byHand), text);
  }
});

test('joins match the lookup written by hand, and writes are refused', plain, async () => {
  await saveConnection('sql', { uri: environment.NEXO_MONGO_PLAIN });
  const writer = { connection: seeded, connectionId: 'sql', database: 'nexo_sql' };
  await server.execute('mongo.database.drop', { ...writer, confirm: 'nexo_sql' });
  await server.execute('mongo.import', {
    ...writer,
    collection: 'customers',
    documents: [
      { _id: 1, name: 'Ana', city: 'Lugo' },
      { _id: 2, name: 'Luis', city: 'Vigo' },
    ],
  });
  await server.execute('mongo.import', {
    ...writer,
    collection: 'orders',
    documents: [
      { sku: 'A', customer: 1 },
      { sku: 'B', customer: 2 },
      { sku: 'C', customer: 3 },
      { sku: 'D', customer: 1 },
    ],
  });
  const inner = await sql(
    'nexo_sql',
    "SELECT o.sku, c.name AS customer FROM orders o JOIN customers c ON o.customer = c._id WHERE c.city = 'Lugo' ORDER BY o.sku",
  );
  assert.deepEqual(
    inner,
    await run('nexo_sql', {
      kind: 'aggregate',
      collection: 'orders',
      pipeline: [
        { $lookup: { from: 'customers', localField: 'customer', foreignField: '_id', as: 'c' } },
        { $unwind: '$c' },
        { $match: { 'c.city': 'Lugo' } },
        { $sort: { sku: 1 } },
        { $project: { _id: 0, sku: 1, customer: '$c.name' } },
      ],
    }),
  );
  assert.deepEqual(inner, [
    { sku: 'A', customer: 'Ana' },
    { sku: 'D', customer: 'Ana' },
  ]);
  const left = await sql(
    'nexo_sql',
    'SELECT o.sku, c.name FROM orders o LEFT JOIN customers c ON o.customer = c._id ORDER BY o.sku',
  );
  assert.equal(left.length, 4);
  assert.deepEqual(left[2], { sku: 'C' }, 'an order without its customer stays, as in SQL');

  await assert.rejects(server.execute('mongo.sql', { sql: 'DELETE FROM orders' }), /Only SELECT/);
  await assert.rejects(
    server.execute('mongo.sql', { sql: 'SELECT DISTINCT sku FROM orders' }),
    /DISTINCT/,
  );
  await server.execute('mongo.database.drop', { ...writer, confirm: 'nexo_sql' });
});
