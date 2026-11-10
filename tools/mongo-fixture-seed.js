// Data of the MongoDB contract and E2E tests, loaded by tools/mongo-fixture.sh into the
// standalone server (mongosh). Database `nexo`:
//   big      100 000 documents with embedded documents, arrays and dates, and an index
//   types    one document with a value of each BSON type
//   madrid   a view on big
//   metrics  a time series collection
//   fs       a GridFS bucket (fs.files and fs.chunks)
const nexo = db.getSiblingDB('nexo');
nexo.dropDatabase();
const statuses = ['A', 'B', 'C', 'D'];
const start = Date.UTC(2024, 0, 1);
for (let first = 0; first < 100000; first += 10000) {
  const batch = [];
  for (let n = first; n < first + 10000; n++) {
    batch.push({
      _id: n,
      n,
      status: statuses[n % 4],
      customer: {
        name: `Customer ${n % 1000}`,
        address: { city: n % 2 ? 'Madrid' : 'Lisboa', zip: String(28000 + (n % 100)) },
      },
      items: [
        { sku: `S${n % 7}`, qty: n % 5 },
        { sku: `T${n % 3}`, qty: 1 },
      ],
      at: new Date(start + n * 60000),
    });
  }
  nexo.big.insertMany(batch, { ordered: false });
}
nexo.big.createIndex({ 'customer.address.city': 1, n: 1 });
nexo.types.insertOne({
  _id: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'),
  int: NumberInt(7),
  long: NumberLong('9007199254740993'),
  double: 1.5,
  decimal: NumberDecimal('1.10'),
  date: ISODate('2024-01-02T03:04:05.006Z'),
  binary: BinData(0, 'AQID'),
  uuid: UUID('3b241101-e2bb-4255-8caf-4136c566a962'),
  regex: /^ab/i,
  timestamp: Timestamp({ t: 1700000000, i: 1 }),
  min: MinKey(),
  max: MaxKey(),
  nothing: null,
  yes: true,
  nested: { list: [1, 'x', { deep: null }] },
});
nexo.createView('madrid', 'big', [{ $match: { 'customer.address.city': 'Madrid' } }]);
nexo.createCollection('metrics', { timeseries: { timeField: 'at', metaField: 'sensor' } });
nexo.createCollection('fs.files');
nexo.createCollection('fs.chunks');
print('seeded');
