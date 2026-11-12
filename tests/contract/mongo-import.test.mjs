// Contract tests for MongoDB imports: batches inserted or upserted, failures by position,
// and emptying the collection, against a database of their own that each run drops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

/** Every document of a collection of the seeded server, in pages of 1000 by `_id`. */
async function* pages(database, collection) {
  let page = await server.execute('mongo.find', {
    connection: seeded,
    database,
    collection,
    id: `pages-${++queries}`,
    sort: { _id: 1 },
    pageSize: 1000,
  });
  for (;;) {
    yield page.documents;
    if (!page.cursor) return;
    page = await server.execute('mongo.more', {
      cursor: page.cursor,
      id: `pages-${++queries}`,
      pageSize: 1000,
    });
  }
}

let queries = 0;
// The connection the imports name, saved once for the file.
let saved;
const importer = () =>
  (saved ??= saveConnection('importer', { uri: environment.NEXO_MONGO_PLAIN }));
const target = { connection: seeded, connectionId: 'importer', database: 'nexo_import' };
const importBatch = (payload) =>
  server.execute('mongo.import', { ...target, collection: 'items', ...payload });
const all = async (filter = {}) =>
  (
    await server.execute('mongo.find', {
      connection: seeded,
      database: 'nexo_import',
      collection: 'items',
      id: `import-${++queries}`,
      filter,
      sort: { n: 1 },
      pageSize: 1000,
    })
  ).documents;
const count = async () =>
  (
    await server.execute('mongo.count', {
      connection: seeded,
      database: 'nexo_import',
      collection: 'items',
      id: `count-${++queries}`,
    })
  ).count;

test(
  'imports keep BSON types in batches, report failures and upsert by fields',
  plain,
  async () => {
    await importer();
    await server.execute('mongo.database.drop', { ...target, confirm: 'nexo_import' });

    // Three batches: the largest one allowed, another and the rest.
    const documents = Array.from({ length: 12_000 }, (_, n) => ({
      n: { $numberInt: String(n) },
      sku: `S-${n}`,
      at: { $date: { $numberLong: String(1_700_000_000_000 + n) } },
      big: { $numberLong: '9007199254740993' },
      price: { $numberDecimal: '19.99' },
      tags: ['a', { nested: true }],
    }));
    let inserted = 0;
    for (let start = 0; start < documents.length; start += 5000)
      inserted += (await importBatch({ documents: documents.slice(start, start + 5000) })).inserted;
    assert.equal(inserted, 12_000);
    assert.equal(await count(), 12_000);
    const [first] = await all({ n: 7 });
    assert.deepEqual(first.at, { $date: { $numberLong: '1700000000007' } });
    assert.deepEqual(first.big, { $numberLong: '9007199254740993' });
    assert.deepEqual(first.price, { $numberDecimal: '19.99' });
    assert.match(first._id.$oid, /^[0-9a-f]{24}$/);

    await assert.rejects(
      importBatch({ documents: Array.from({ length: 5001 }, () => ({})) }),
      /at most 5000 documents/,
    );

    // A duplicate `_id`: without `ordered` the others are written, with it the batch stops.
    await importBatch({
      clearConfirm: 'items',
      documents: [{ _id: 1, n: { $numberInt: '1' } }],
    });
    assert.equal(await count(), 1);
    const unordered = await importBatch({
      documents: [{ _id: 2 }, { _id: 1 }, { _id: 3 }],
    });
    assert.equal(unordered.inserted, 2);
    assert.equal(unordered.failed.length, 1);
    assert.equal(unordered.failed[0].index, 1);
    assert.match(unordered.failed[0].message, /duplicate key/);
    const ordered = await importBatch({
      ordered: true,
      documents: [{ _id: 4 }, { _id: 1 }, { _id: 5 }],
    });
    assert.equal(ordered.inserted, 1);
    assert.deepEqual(
      ordered.failed.map((failed) => failed.index),
      [1],
    );
    assert.equal(await count(), 4);

    // Upsert by an embedded field: one replaced, one inserted, one without the key.
    await importBatch({
      clearConfirm: 'items',
      documents: [{ code: { sku: 'A' }, n: { $numberInt: '1' } }],
    });
    const upserted = await importBatch({
      mode: 'upsert',
      key: ['code.sku'],
      documents: [
        { code: { sku: 'A' }, n: { $numberInt: '10' } },
        { code: { sku: 'B' }, n: { $numberInt: '20' } },
        { n: { $numberInt: '30' } },
      ],
    });
    assert.deepEqual(
      { replaced: upserted.replaced, upserted: upserted.upserted },
      { replaced: 1, upserted: 1 },
    );
    assert.deepEqual(upserted.failed, [{ index: 2, message: 'The document has no code.sku' }]);
    assert.deepEqual(
      (await all()).map((d) => [d.code.sku, d.n.$numberInt]),
      [
        ['A', '10'],
        ['B', '20'],
      ],
    );

    // Emptying needs the collection's name; the indexes stay.
    await server.execute('mongo.index.create', {
      ...target,
      collection: 'items',
      keys: { 'code.sku': 1 },
      options: { name: 'by_sku' },
    });
    await assert.rejects(
      importBatch({ clearConfirm: 'other', documents: [] }),
      /Type the name of the collection to confirm: items/,
    );
    const cleared = await importBatch({ clearConfirm: 'items', documents: [] });
    assert.equal(cleared.cleared, 2);
    assert.equal(await count(), 0);
    const indexes = await server.execute('mongo.indexes', {
      connection: seeded,
      database: 'nexo_import',
      collection: 'items',
    });
    assert.ok(indexes.indexes.some((index) => index.name === 'by_sku'));

    await server.execute('mongo.database.drop', { ...target, confirm: 'nexo_import' });
  },
);

test(
  'a collection read in pages and imported again keeps its documents and types',
  plain,
  async () => {
    await importer();
    await server.execute('mongo.database.drop', { ...target, confirm: 'nexo_import' });
    // As the interface copies a collection: pages of 1000 read, batches of 1000 written.
    for (const collection of ['big', 'types']) {
      let read = 0;
      for await (const documents of pages('nexo', collection)) {
        const answer = await server.execute('mongo.import', { ...target, collection, documents });
        assert.deepEqual(answer.failed, []);
        read += answer.inserted;
      }
      assert.equal(read, collection === 'big' ? 100_000 : 1);
      const original = pages('nexo', collection);
      let compared = 0;
      for await (const copy of pages('nexo_import', collection)) {
        const { value } = await original.next();
        assert.deepEqual(copy, value);
        compared += copy.length;
      }
      assert.equal(compared, read);
    }
    await server.execute('mongo.database.drop', { ...target, confirm: 'nexo_import' });
  },
);
