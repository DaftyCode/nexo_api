// Contract tests for the MongoDB shell: the usual commands of mongosh against MongoDB 8,
// destructive ones only with the name typed, and a read-only connection that refuses writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, saveConnection } from './mongo-fixture.mjs';

const database = 'nexo_shell';
const shell = (command, extra = {}) =>
  server.execute('mongo.shell', { connection: 'shell', database: 'nexo', command, ...extra });

test('the shell runs the usual commands of mongosh', plain, async () => {
  await saveConnection('shell', { uri: environment.NEXO_MONGO_PLAIN });
  await saveConnection('shell-reader', { uri: environment.NEXO_MONGO_PLAIN, readOnly: true });

  const collections = await shell('show collections');
  assert.ok(collections.value.includes('big'), JSON.stringify(collections.value));
  const databases = await shell('show dbs');
  assert.ok(databases.value.includes('nexo'));

  const found = await shell(
    "db.big.find({ 'customer.address.city': 'Madrid' }).sort({ n: 1 }).limit(3)",
  );
  assert.equal(found.kind, 'documents');
  assert.deepEqual(
    found.value.map((document) => document.n),
    [1, 3, 5],
  );
  // Numbers come back as the shell shows them; without a limit, a cursor shows 50 documents.
  assert.equal((await shell('db.big.find()')).value.length, 50);
  const counted = await shell('db.big.countDocuments({ status: "A" })');
  assert.deepEqual([counted.kind, counted.value], ['value', 25_000]);
  const grouped = await shell(
    "db.big.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray()",
  );
  assert.deepEqual(
    grouped.value.map((group) => group._id),
    ['A', 'B', 'C', 'D'],
  );

  // Several statements: a database of its own, written and read with BSON types.
  const written = await shell(
    [
      `use ${database}`,
      "db.items.insertOne({ sku: 'A-1', at: ISODate('2024-01-02T03:04:05.006Z'), price: NumberDecimal('19.99') })",
      "print('inserted', db.getName())",
      "db.items.findOne({ sku: 'A-1' })",
    ].join('\n'),
  );
  assert.equal(written.database, database);
  assert.deepEqual(written.logs, [['inserted', database]]);
  assert.deepEqual(written.value.at, { $date: { $numberLong: '1704164645006' } });
  assert.deepEqual(written.value.price, { $numberDecimal: '19.99' });
  const indexed = await shell("db.items.createIndex({ sku: 1 }, { name: 'by_sku' })", { database });
  assert.deepEqual(indexed.value, { ok: 1 });
  const indexes = await shell('db.items.getIndexes()', { database });
  assert.deepEqual(
    indexes.value.map((index) => index.name),
    ['_id_', 'by_sku'],
  );

  // Destructive commands need the name the person types.
  await assert.rejects(
    shell('db.items.deleteMany({})', { database }),
    /Type the name of the collection to confirm: items/,
  );
  const emptied = await shell('db.items.deleteMany({})', { database, confirm: 'items' });
  assert.equal(emptied.value.deletedCount, 1);
  await assert.rejects(shell('db.items.drop()', { database }), /confirm: items/);
  assert.equal((await shell('db.items.drop()', { database, confirm: 'items' })).value, true);
  await assert.rejects(shell('db.dropDatabase()', { database }), /confirm: nexo_shell/);
  await shell('db.dropDatabase()', { database, confirm: database });
  assert.ok(!(await shell('show dbs')).value.includes(database));

  // A read-only connection refuses writes, and errors say why.
  await assert.rejects(
    server.execute('mongo.shell', {
      connection: 'shell-reader',
      database,
      command: 'db.items.insertOne({ a: 1 })',
    }),
    /read-only/,
  );
  await assert.rejects(shell('db.big.find('), /SyntaxError/);
  await assert.rejects(shell('db.big.find({ $bad: 1 })'), /\$bad/);
});
