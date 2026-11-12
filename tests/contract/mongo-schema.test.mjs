// Contract tests for the MongoDB schema explorer: a collection with known anomalies sampled
// with $sample and analysed, and the validator its schema gives applied with collMod, against
// a database of their own that each run drops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

const database = 'nexo_schema';
let ids = 0;
let saved;
const connections = () =>
  (saved ??= Promise.all([
    saveConnection('schemas', { uri: environment.NEXO_MONGO_PLAIN }),
    saveConnection('schema-reader', { uri: environment.NEXO_MONGO_PLAIN, readOnly: true }),
  ]));
const writer = (connectionId = 'schemas') => ({ connection: seeded, connectionId, database });
const schema = (collection, extra = {}, on = database) =>
  server.execute('mongo.schema', {
    connection: seeded,
    database: on,
    collection,
    id: `schema-${++ids}`,
    ...extra,
  });
const field = (report, path) => report.fields.find((found) => found.path === path);

// Forty people: `age` is text once and missing once, `email` missing once, `qty` a double once.
const people = Array.from({ length: 40 }, (_, n) => ({
  _id: n,
  name: `P${n}`,
  ...(n === 0 ? {} : { age: n === 1 ? 'old' : { $numberInt: String(20 + n) } }),
  ...(n === 5 ? {} : { email: `p${n}@example.com` }),
  city: n % 4 === 0 ? 'Vigo' : 'Lugo',
  items: [{ sku: 'A', qty: n === 3 ? { $numberDouble: '1.5' } : { $numberInt: '2' } }],
  at: { $date: { $numberLong: String(1_700_000_000_000 + n) } },
}));

test('a sample finds the anomalies of a collection, and the shares add up', plain, async () => {
  await connections();
  await server.execute('mongo.database.drop', { ...writer(), confirm: database });
  await server.execute('mongo.import', { ...writer(), collection: 'people', documents: people });

  // A sample larger than the collection reads every document.
  const report = await schema('people', { size: 1000 });
  assert.equal(report.sampled, 40);
  const age = field(report, 'age');
  assert.deepEqual([age.count, age.parents], [39, 40]);
  assert.deepEqual(
    age.types.map((type) => [type.name, type.count]),
    [
      ['Int32', 38],
      ['String', 1],
    ],
  );
  assert.deepEqual(age.anomalies, ['mixedTypes', 'sometimesMissing']);
  assert.deepEqual(field(report, 'email').anomalies, ['sometimesMissing']);
  const qty = field(report, 'items.[].qty');
  assert.deepEqual(qty.anomalies, ['mixedTypes']);
  assert.deepEqual(field(report, 'city').values, [
    { value: 'Lugo', count: 30 },
    { value: 'Vigo', count: 10 },
  ]);
  assert.equal(field(report, 'at').types[0].name, 'Date');
  assert.deepEqual(field(report, '_id').anomalies, []);
  assert.deepEqual(report.validator.$jsonSchema.required, ['_id', 'name', 'city', 'items', 'at']);
  assert.equal(report.jsonSchema.properties.age.type.length, 2);

  // The sample of a filter's documents, and a sample smaller than the collection.
  const vigo = await schema('people', { filter: { city: 'Vigo' } });
  assert.equal(vigo.sampled, 10);
  assert.deepEqual(field(vigo, 'city').values, [{ value: 'Vigo', count: 10 }]);
  const some = await schema('people', { size: 7 });
  assert.equal(some.sampled, 7);

  // 1 000 of the 100 000 seeded documents, read through the cursor's pages.
  const big = await schema('big', { size: 2500 }, 'nexo');
  assert.equal(big.sampled, 2500);
  const city = field(big, 'customer.address.city');
  assert.deepEqual([city.count, city.parents, city.depth], [2500, 2500, 2]);
  assert.deepEqual(city.values.map((value) => value.value).sort(), ['Lisboa', 'Madrid']);
  await assert.rejects(schema('people', { size: 20_000 }), /between 1 and 10000/);
});

test('the validator of a schema is applied only as a confirmed write', plain, async () => {
  await connections();
  const report = await schema('people');
  const apply = (extra, connectionId) =>
    server.execute('mongo.collection.validator', {
      ...writer(connectionId),
      collection: 'people',
      validator: report.validator,
      confirm: 'people',
      ...extra,
    });
  const insert = (document) =>
    server.execute('mongo.insert', { ...writer(), collection: 'people', documents: [document] });

  await assert.rejects(apply({}, 'schema-reader'), /is read-only/);
  await assert.rejects(apply({ confirm: 'other' }), /Type the name of the collection/);
  await insert({ _id: 'before' });

  await apply({});
  await assert.rejects(insert({ _id: 101 }), /validation/i);
  await insert({
    _id: 102,
    name: 'Ana',
    city: 'Lugo',
    items: [],
    at: { $date: { $numberLong: '0' } },
  });
  // Only logged with `warn`; an empty validator removes the rules.
  await apply({ validationAction: 'warn' });
  await insert({ _id: 103 });
  await apply({ validator: {} });
  await insert({ _id: 'free' });

  await server.execute('mongo.database.drop', { ...writer(), confirm: database });
});
