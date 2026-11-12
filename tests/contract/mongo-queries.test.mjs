// Contract tests for the MongoDB explorer and queries.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { server, document, plain, seeded, big, find } from './mongo-fixture.mjs';

test(
  'the explorer lists databases, collections, views, time series and GridFS',
  plain,
  async () => {
    const { databases } = await server.execute('mongo.databases', { connection: seeded });
    const nexo = databases.find((database) => database.name === 'nexo');
    assert.ok(nexo.sizeOnDisk > 0);
    assert.equal(nexo.empty, false);
    assert.deepEqual(
      databases.map((database) => database.name),
      [...databases.map((database) => database.name)].sort(),
    );
    const { collections } = await server.execute('mongo.collections', {
      connection: seeded,
      database: 'nexo',
    });
    const byName = Object.fromEntries(collections.map((c) => [c.name, c]));
    assert.equal(byName.big.kind, 'collection');
    assert.equal(byName.madrid.kind, 'view');
    assert.equal(byName.madrid.viewOn, 'big');
    assert.equal(byName.metrics.kind, 'timeseries');
    assert.equal(byName['fs.files'].gridfs, 'fs');
    assert.equal(byName['fs.chunks'].gridfs, 'fs');
    assert.equal(byName.big.gridfs, undefined);
    const stats = await server.execute('mongo.stats', big);
    assert.equal(stats.count, 100000);
    assert.ok(stats.size > 0 && stats.storageSize > 0 && stats.totalIndexSize > 0);
    assert.ok(stats.averageDocumentSize > 100);
    assert.deepEqual(
      stats.indexes.map((index) => [index.name, index.keys]),
      [
        ['_id_', { _id: { $numberInt: '1' } }],
        [
          'customer.address.city_1_n_1',
          { 'customer.address.city': { $numberInt: '1' }, n: { $numberInt: '1' } },
        ],
      ],
    );
    await assert.rejects(
      server.execute('mongo.collections', { connection: seeded, database: 'a/b' }),
      /Invalid database name/,
    );
  },
);

test(
  'find filters by an embedded field, sorts, projects and pages with its cursor',
  plain,
  async () => {
    const query = {
      filter: { 'customer.address.city': 'Madrid' },
      sort: { n: -1 },
      projection: { n: 1, 'customer.address.city': 1 },
      pageSize: 50,
    };
    const first = await find(query);
    assert.equal(first.documents.length, 50);
    assert.deepEqual(first.documents[0], {
      _id: { $numberInt: '99999' },
      n: { $numberInt: '99999' },
      customer: { address: { city: 'Madrid' } },
    });
    assert.ok(first.cursor);
    assert.equal(first.truncated, false);
    const second = await server.execute('mongo.more', {
      cursor: first.cursor,
      id: 'more-1',
      pageSize: 50,
    });
    assert.equal(second.documents[0].n.$numberInt, '99899');
    const { count } = await server.execute('mongo.count', {
      ...big,
      id: 'count-1',
      filter: query.filter,
    });
    assert.equal(count, 50000);
    // A total limit ends the cursor; skip starts later.
    const limited = await find({ sort: { n: 1 }, skip: 10, limit: 120, pageSize: 50 });
    assert.equal(limited.documents[0].n.$numberInt, '10');
    const next = await server.execute('mongo.more', {
      cursor: limited.cursor,
      id: 'more-2',
      pageSize: 50,
    });
    const last = await server.execute('mongo.more', {
      cursor: next.cursor,
      id: 'more-3',
      pageSize: 50,
    });
    assert.equal(last.documents.length, 20);
    assert.equal(last.documents.at(-1).n.$numberInt, '129');
    assert.equal(last.cursor, undefined);
    // An index by name, a collation and canonical Extended JSON in the filter.
    const hinted = await find({
      filter: { n: { $gte: { $numberLong: '99990' } }, 'customer.address.city': 'Lisboa' },
      hint: 'customer.address.city_1_n_1',
      collation: { locale: 'es', strength: 1 },
      pageSize: 10,
    });
    assert.deepEqual(
      hinted.documents.map((d) => d.n.$numberInt),
      ['99990', '99992', '99994', '99996', '99998'],
    );
    assert.equal(hinted.cursor, undefined);
  },
);

test('every BSON type comes back as canonical Extended JSON', plain, async () => {
  const page = await server.execute('mongo.find', {
    connection: seeded,
    database: 'nexo',
    collection: 'types',
    id: 'types-1',
    filter: { _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' } },
  });
  const [document] = page.documents;
  assert.deepEqual(document._id, { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' });
  assert.deepEqual(document.int, { $numberInt: '7' });
  assert.deepEqual(document.long, { $numberLong: '9007199254740993' });
  assert.deepEqual(document.double, { $numberDouble: '1.5' });
  assert.deepEqual(document.decimal, { $numberDecimal: '1.10' });
  assert.deepEqual(document.date, { $date: { $numberLong: '1704164645006' } });
  assert.deepEqual(document.binary, { $binary: { base64: 'AQID', subType: '00' } });
  assert.deepEqual(document.uuid, {
    $binary: { base64: 'OyQRAeK7QlWMr0E2xWapYg==', subType: '04' },
  });
  assert.deepEqual(document.regex, { $regularExpression: { pattern: '^ab', options: 'i' } });
  assert.deepEqual(document.timestamp, { $timestamp: { t: 1700000000, i: 1 } });
  assert.deepEqual(document.min, { $minKey: 1 });
  assert.deepEqual(document.max, { $maxKey: 1 });
  assert.equal(document.nothing, null);
  assert.equal(document.yes, true);
  assert.deepEqual(document.nested.list[2], { deep: null });
});

test(
  'a long query is cancelled on the server, and closed results are explained',
  plain,
  async () => {
    const id = 'slow-1';
    const started = Date.now();
    // Server-side JavaScript of the query itself: about 100 ms a document.
    const slow = server
      .execute('mongo.find', {
        ...big,
        id,
        filter: { $where: 'sleep(100) || true' },
        pageSize: 100,
      })
      .catch((error) => error);
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(await server.execute('mongo.cancel', { id }), { cancelled: true });
    const error = await slow;
    assert.match(error.message, /cancelled/);
    assert.ok(Date.now() - started < 5000, 'the answer does not wait for the query');
    assert.deepEqual(await server.execute('mongo.cancel', { id }), { cancelled: false });
    // The connection still answers.
    const after = await find({ filter: { n: 1 } });
    assert.equal(after.documents.length, 1);

    const open = await find({ pageSize: 5 });
    await server.execute('mongo.close', { cursor: open.cursor });
    await assert.rejects(
      server.execute('mongo.more', { cursor: open.cursor, id: 'more-closed' }),
      /no longer open: run the query again/,
    );
  },
);

test('queries are checked before they are sent', plain, async () => {
  await assert.rejects(
    find({ filter: { _id: { $oid: 'nope' } } }),
    /Invalid Extended JSON in the filter/,
  );
  await assert.rejects(find({ pageSize: 0 }), /between 1 and 1000 documents/);
  await assert.rejects(find({ filter: 'this.n > 1' }), (error) => error.status === 400);
  await assert.rejects(find({ collation: { strength: 1 } }), /Invalid collation/);
  await assert.rejects(find({ hint: 'missing_index' }), /refused the command|hint/i);
});

test('a saved query and the query history are workspace documents', async () => {
  const query = (kind, value) => ({
    id: `${kind}-1`,
    workspace_id: 'local',
    kind,
    name: 'Orders from Madrid',
    revision: 0,
    updated_at: 0,
    value,
  });
  const refused = await server.api('PUT', '/documents', query('query', { database: 'nexo' }));
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /database and collection/);
  const value = {
    connection: 'mongo-1',
    database: 'nexo',
    collection: 'big',
    filter: "{status: 'A'}",
  };
  const saved = await server.api('PUT', '/documents', query('query', value));
  assert.equal(saved.status, 200);
  const history = await server.api('PUT', '/documents', query('query-history', value));
  assert.equal(history.status, 200);
  const listing = await server.api('GET', '/documents?workspace=local');
  const kinds = listing.body.filter((d) => d.id.endsWith('-1')).map((d) => d.kind);
  assert.ok(kinds.includes('query') && kinds.includes('query-history'));
});
