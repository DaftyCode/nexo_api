// Contract tests for `nx.mongo`: a request to an API that writes to MongoDB, and a test
// script that finds the document it wrote with its types, then deletes it. The script
// names saved connections only: a read-only one refuses writes and the URI never reaches it.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

const database = 'nexo_scripts';
const address = () => new URL(environment.NEXO_MONGO_PLAIN).host;
let api;
let base;
after(() => api?.close());

/** An API under test: `POST /orders` stores the order in MongoDB, as a real service would. */
async function orders() {
  api = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      if (!body) return response.end('{}');
      const order = JSON.parse(body);
      await server.execute('mongo.insert', {
        connection: seeded,
        connectionId: 'scripts',
        database,
        collection: 'orders',
        documents: [
          {
            sku: order.sku,
            price: { $numberDecimal: order.price },
            at: { $date: { $numberLong: '1704164645006' } },
          },
        ],
      });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sku: order.sku }));
    });
  });
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${api.address().port}`;
}

const testScript = `
pm.test('the API stored the order, with its types', async () => {
  pm.expect(pm.response.code).to.equal(201);
  const orders = nx.mongo('scripts').db('${database}').collection('orders');
  const order = await orders.findOne({ sku: 'A-1' });
  pm.expect(order.price.toString()).to.equal('19.99');
  pm.expect(order.at.toISOString()).to.equal('2024-01-02T03:04:05.006Z');
  pm.expect(order._id instanceof ObjectId).to.equal(true);
  pm.expect(await orders.countDocuments({ sku: 'A-1' })).to.equal(1);
  const found = await orders.find({}, { projection: { sku: 1, _id: 0 } }).toArray();
  pm.expect(found).to.eql([{ sku: 'A-1' }]);
  const deleted = await orders.deleteOne({ _id: order._id });
  pm.expect(deleted.deletedCount).to.equal(1);
});
pm.test('a read-only connection refuses writes', async () => {
  let message = '';
  try {
    await nx.mongo('scripts-reader').db('${database}').collection('orders').insertOne({ a: 1 });
  } catch (error) {
    message = error.message;
  }
  pm.expect(message).to.include('read-only');
});
pm.test('the connection is a name, not its URI', () => {
  pm.expect(JSON.stringify(nx.mongo('scripts'))).to.not.include('${address()}');
});
`;

test('a test script checks with nx.mongo what the API wrote, and deletes it', plain, async () => {
  // The URI is written with a variable, which the script's environment fills.
  await saveConnection('scripts', { uri: 'mongodb://{{mongoAddress}}' });
  await saveConnection('scripts-reader', { uri: environment.NEXO_MONGO_PLAIN, readOnly: true });
  const writer = { connection: seeded, connectionId: 'scripts', database };
  await server.execute('mongo.database.drop', { ...writer, confirm: database });
  base ??= await orders();

  const result = await server.execute('request', {
    item: {
      name: 'Create order',
      request: {
        method: 'POST',
        url: `${base}/orders`,
        header: [{ key: 'content-type', value: 'application/json' }],
        body: { mode: 'raw', raw: JSON.stringify({ sku: 'A-1', price: '19.99' }) },
      },
      event: [{ listen: 'test', script: { exec: [testScript] } }],
    },
    variables: [{ key: 'mongoAddress', value: address(), enabled: true }],
  });
  assert.equal(result.status, 201);
  assert.deepEqual(
    result.assertions.map((assertion) => [assertion.name, assertion.passed, assertion.error]),
    [
      ['the API stored the order, with its types', true, undefined],
      ['a read-only connection refuses writes', true, undefined],
      ['the connection is a name, not its URI', true, undefined],
    ],
  );
  // The script's delete went through the same writes as the interface: it is recorded.
  const count = await server.execute('mongo.count', {
    connection: seeded,
    database,
    collection: 'orders',
    id: 'scripts-count',
  });
  assert.equal(count.count, 0);
  const changes = await server.api('GET', '/documents?workspace=local&kind=database-change');
  assert.ok(
    changes.body.some((change) => change.value?.operation === 'mongo.delete'),
    JSON.stringify(changes.body.map((change) => change.value?.operation)),
  );
  await server.execute('mongo.database.drop', { ...writer, confirm: database });
});

test('a script cannot reach a connection that is not saved', plain, async () => {
  const result = await server.execute('request', {
    item: {
      name: 'Missing',
      request: { method: 'GET', url: `${(base ??= await orders())}/` },
      event: [
        {
          listen: 'prerequest',
          script: {
            exec: [
              "nx.mongo('nowhere').db('a').collection('b').findOne({}).catch((e) => pm.environment.set('why', e.message));",
            ],
          },
        },
      ],
    },
  });
  assert.equal(
    result.variables.environment.values.find((row) => row.key === 'why')?.value,
    'No saved MongoDB connection is named nowhere',
  );
});
