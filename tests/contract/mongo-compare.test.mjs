// Contract tests for comparing and syncing collections: two collections of 50 000 documents
// with known differences, counted exactly, then synced until the comparison is empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

const database = 'nexo_compare';
let ids = 0;
const writer = (connectionId = 'compare') => ({ connection: seeded, connectionId, database });
const side = (collection) => ({ connection: seeded, database, collection });
const compare = (extra = {}) =>
  server.execute('mongo.compare', {
    id: `compare-${++ids}`,
    source: side('a'),
    target: side('b'),
    ...extra,
  });
const copy = (collection, match) =>
  server.execute('mongo.aggregate.write', {
    ...writer(),
    collection: 'big',
    database: 'nexo',
    id: `copy-${++ids}`,
    pipeline: [
      { $match: match },
      { $project: { n: 1, status: 1, customer: 1, at: 1 } },
      { $out: { db: database, coll: collection } },
    ],
    confirm: collection,
  });
const write = (operation, payload) =>
  server.execute(operation, { ...writer(), collection: 'b', ...payload });

test(
  'two collections of 50 000 documents: each difference counted, then synced',
  plain,
  async () => {
    await saveConnection('compare', { uri: environment.NEXO_MONGO_PLAIN });
    await saveConnection('compare-reader', { uri: environment.NEXO_MONGO_PLAIN, readOnly: true });
    await server.execute('mongo.database.drop', { ...writer(), confirm: database });
    await copy('a', { n: { $lt: 50_000 } });
    await copy('b', { n: { $lt: 50_000 } });
    // Known differences: 100 missing in b, 50 only in b, 200 changed, 300 with a field ignored.
    await write('mongo.delete', { filter: { n: { $lt: 100 } }, many: true, expected: 100 });
    await write('mongo.insert', {
      documents: Array.from({ length: 50 }, (_, n) => ({ _id: 1_000_000 + n, n: 1_000_000 + n })),
    });
    await write('mongo.update', {
      filter: { n: { $gte: 1000, $lt: 1200 } },
      update: { $set: { status: 'Z', 'customer.address.city': 'Vigo' } },
      many: true,
      expected: 200,
    });
    await write('mongo.update', {
      filter: { n: { $gte: 2000, $lt: 2300 } },
      update: { $set: { at: { $date: { $numberLong: '0' } } } },
      many: true,
      expected: 300,
    });

    const result = await compare({ kept: 1000 });
    assert.deepEqual(result.counts, {
      onlySource: 100,
      onlyTarget: 50,
      different: 500,
      equal: 49_400,
      withoutKey: 0,
    });
    const changed = result.differences.find(
      (difference) => difference.kind === 'different' && difference.key.$numberInt === '1000',
    );
    assert.deepEqual(
      changed.fields.map((field) => field.path),
      ['status', 'customer.address.city'],
    );
    assert.deepEqual(changed.fields[0], { path: 'status', source: 'A', target: 'Z' });
    assert.equal(result.truncated, false);
    // Leaving out a field, and reading part of both sides.
    const ignoring = await compare({ ignore: ['at'], kept: 1 });
    assert.equal(ignoring.counts.different, 200);
    assert.equal(ignoring.truncated, true);
    const part = await compare({ filter: { n: { $lt: 1500 } } });
    assert.deepEqual([part.counts.onlySource, part.counts.different], [100, 200]);

    // Syncing writes only to a writable target, once its name is typed.
    const sync = (extra) =>
      server.execute('mongo.sync', {
        ...writer(),
        collection: 'b',
        id: `sync-${++ids}`,
        source: side('a'),
        confirm: 'b',
        remove: true,
        ...extra,
      });
    await assert.rejects(sync({ connectionId: 'compare-reader' }), /is read-only/);
    await assert.rejects(sync({ confirm: 'a' }), /Type the name of the collection to confirm: b/);
    await assert.rejects(
      sync({ collection: 'a', confirm: 'a' }),
      /Choose another collection to sync/,
    );
    const synced = await sync({});
    assert.deepEqual(
      {
        inserted: synced.inserted,
        replaced: synced.replaced,
        deleted: synced.deleted,
        failed: synced.failed,
      },
      { inserted: 100, replaced: 500, deleted: 50, failed: [] },
    );
    const after = await compare();
    assert.deepEqual(after.counts, {
      onlySource: 0,
      onlyTarget: 0,
      different: 0,
      equal: 50_000,
      withoutKey: 0,
    });
    assert.deepEqual(after.differences, []);
    await server.execute('mongo.database.drop', { ...writer(), confirm: database });
  },
);

test('a key other than _id pairs the documents, and keeps the target _id', plain, async () => {
  await server.execute('mongo.database.drop', { ...writer(), confirm: database });
  const insert = (collection, documents) =>
    server.execute('mongo.insert', { ...writer(), collection, documents });
  await insert('a', [
    { sku: 'A', qty: 1 },
    { sku: 'B', qty: 2 },
  ]);
  await insert('b', [{ sku: 'A', qty: 5 }, { qty: 9 }]);
  const result = await compare({ key: 'sku' });
  assert.deepEqual(result.counts, {
    onlySource: 1,
    onlyTarget: 0,
    different: 1,
    equal: 0,
    withoutKey: 1,
  });
  assert.deepEqual(
    result.differences
      .find((difference) => difference.kind === 'different')
      .fields.map((f) => f.path),
    ['_id', 'qty'],
  );
  await server.execute('mongo.sync', {
    ...writer(),
    collection: 'b',
    id: 'sync-sku',
    source: side('a'),
    key: 'sku',
    ignore: ['_id'],
    confirm: 'b',
  });
  const again = await compare({ key: 'sku', ignore: ['_id'] });
  assert.deepEqual([again.counts.different, again.counts.onlySource], [0, 0]);
  await server.execute('mongo.database.drop', { ...writer(), confirm: database });
});
