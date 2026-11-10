// Contract tests for MongoDB connections. Those that need real servers run when they are
// configured (CI starts them with `tools/mongo-fixture.sh`) and are skipped otherwise:
//   NEXO_MONGO_PLAIN          standalone without authentication, with the data of
//                             tools/mongo-fixture-seed.js
//   NEXO_MONGO_AUTH           SCRAM user without its password, which is NEXO_MONGO_PASSWORD;
//                             TLS with the CA NEXO_MONGO_CA and X.509 with NEXO_MONGO_CLIENT_CERT
//                             and NEXO_MONGO_CLIENT_KEY (PEM files)
//   NEXO_MONGO_REPLICA_SET    a replica set
//   NEXO_MONGO_FERRETDB       FerretDB, with NEXO_MONGO_PASSWORD
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freePort, startServer } from './server.mjs';

const environment = process.env;
let server;
let restricted;
before(async () => {
  [server, restricted] = await Promise.all([
    startServer(),
    startServer({ NEXO_EGRESS: 'deny-private' }),
  ]);
});
after(async () => {
  await Promise.all([server?.stop(), restricted?.stop()]);
});

const connect = (connection, on = server) => on.execute('mongo.test', { connection });
const document = (uri) => ({
  id: 'mongo-1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local MongoDB',
  revision: 0,
  updated_at: 0,
  value: { uri, password: '{{vault:mongo-local}}' },
});

test('a connection keeps its password out of the URI it stores', async () => {
  const refused = await server.api('PUT', '/documents', document('mongodb://ana:secret@db.test'));
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Keep the password out of the connection URI/);
  const saved = await server.api('PUT', '/documents', document('mongodb://ana@db.test'));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  const listing = await server.api('GET', '/documents?workspace=local');
  assert.ok(listing.body.some((d) => d.kind === 'connection' && d.id === 'mongo-1'));
});

test('connections are checked before anything is sent', async () => {
  await assert.rejects(connect({ uri: 'postgres://db.test' }), /mongodb:\/\/ or mongodb\+srv/);
  await assert.rejects(connect({ uri: 'mongodb://{{host}}:27017' }), /\{\{host\}\}/);
  await assert.rejects(
    connect({ uri: 'mongodb://db.test/?tls=true&tlsCAFile=/etc/passwd' }),
    /does not read files named in a URI/,
  );
  await assert.rejects(
    connect({ uri: 'mongodb://db.test', tlsCAFile: '/etc/passwd' }),
    /at connection.tlsCAFile/,
  );
  await assert.rejects(connect({ uri: 'mongodb://db.test', caPem: 'x' }), /PEM format/);
  await assert.rejects(
    connect({ uri: 'mongodb://ana@db.test/?authMechanism=GSSAPI' }),
    /not supported yet|GSSAPI/,
  );
});

test('an unreachable server and an unknown name are explained', async () => {
  const port = await freePort();
  await assert.rejects(
    connect({ uri: `mongodb://127.0.0.1:${port}/?serverSelectionTimeoutMS=500` }),
    /No server answered/,
  );
  await assert.rejects(
    connect({ uri: 'mongodb+srv://cluster0.nexo-does-not-exist.invalid/' }),
    /resolve|DNS|SRV/i,
  );
});

test('the egress policy refuses private servers before connecting', async () => {
  await assert.rejects(
    connect({ uri: 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=500' }, restricted),
    /Nexo may not connect to 127.0.0.1:27017: .*egress policy/,
  );
});

test("a secret's allowed domains apply to every server", async () => {
  await server.api('PUT', '/secrets/mongo-scoped', {
    value: 'scoped-secret',
    allowedHosts: ['*.example.com'],
  });
  const error = await connect({
    uri: 'mongodb://ana@127.0.0.1:27017/?serverSelectionTimeoutMS=500',
    password: '{{vault:mongo-scoped}}',
  }).catch((e) => e);
  assert.match(error.message, /secret mongo-scoped cannot be sent to 127.0.0.1/);
  assert.doesNotMatch(error.message, /scoped-secret/);
});

const plain = { skip: !environment.NEXO_MONGO_PLAIN };
const auth = { skip: !environment.NEXO_MONGO_AUTH };

test('a standalone server without authentication', plain, async () => {
  const report = await connect({ uri: environment.NEXO_MONGO_PLAIN });
  assert.equal(report.topology, 'standalone');
  assert.match(report.serverVersion, /^\d+\.\d+/);
  assert.equal(report.tls, false);
  assert.equal(report.authMechanism, undefined);
  assert.deepEqual(
    report.hosts.map((host) => [host.role, host.allowed]),
    [['standalone', true]],
  );
});

test('SCRAM with the password in the vault, and a wrong one', auth, async () => {
  await server.api('PUT', '/secrets/mongo-auth', { value: environment.NEXO_MONGO_PASSWORD });
  const report = await connect({
    uri: environment.NEXO_MONGO_AUTH,
    password: '{{vault:mongo-auth}}',
  });
  assert.equal(report.authMechanism, 'SCRAM');
  await server.api('PUT', '/secrets/mongo-wrong', { value: 'wrong-password-value' });
  const error = await connect({
    uri: environment.NEXO_MONGO_AUTH,
    password: '{{vault:mongo-wrong}}',
  }).catch((e) => e);
  assert.match(error.message, /Authentication failed/);
  assert.doesNotMatch(error.message, /wrong-password-value/);
});

test('TLS: the CA is needed to trust the server, and X.509 signs in', auth, async () => {
  const tlsUri = `${environment.NEXO_MONGO_AUTH}&tls=true&serverSelectionTimeoutMS=2000`;
  await assert.rejects(
    connect({ uri: tlsUri, password: environment.NEXO_MONGO_PASSWORD }),
    /certificate is not trusted/,
  );
  const caPem = await readFile(environment.NEXO_MONGO_CA, 'utf8');
  const report = await connect({ uri: tlsUri, password: environment.NEXO_MONGO_PASSWORD, caPem });
  assert.equal(report.tls, true);
  // Any certificate, when the person allows it.
  const insecure = await connect({
    uri: `${tlsUri}&tlsAllowInvalidCertificates=true`,
    password: environment.NEXO_MONGO_PASSWORD,
  });
  assert.equal(insecure.tls, true);
  const [certPem, keyPem] = await Promise.all([
    readFile(environment.NEXO_MONGO_CLIENT_CERT, 'utf8'),
    readFile(environment.NEXO_MONGO_CLIENT_KEY, 'utf8'),
  ]);
  const host = new URL(environment.NEXO_MONGO_AUTH.replace('mongodb://', 'http://')).host;
  const x509 = await connect({
    uri: `mongodb://${host}/?authMechanism=MONGODB-X509&tls=true`,
    caPem,
    certPem,
    keyPem,
  });
  assert.equal(x509.authMechanism, 'MONGODB-X509');
});

test('a replica set lists its members', { skip: !environment.NEXO_MONGO_REPLICA_SET }, async () => {
  const report = await connect({ uri: environment.NEXO_MONGO_REPLICA_SET });
  assert.equal(report.topology, 'replicaSet');
  assert.equal(report.replicaSet, 'rs0');
  assert.equal(report.direct, false);
  assert.deepEqual(
    report.hosts.map((host) => [host.role, host.allowed]),
    [['primary', true]],
  );
  // Under a restrictive policy the members are asked for and checked before the driver
  // contacts them; allowed ones keep the replica set.
  const allowed = await startServer({
    NEXO_EGRESS: 'deny-private',
    NEXO_EGRESS_ALLOW: '127.0.0.1',
  });
  try {
    const checked = await connect({ uri: environment.NEXO_MONGO_REPLICA_SET }, allowed);
    assert.equal(checked.topology, 'replicaSet');
    assert.equal(checked.direct, false);
  } finally {
    await allowed.stop();
  }
});

test('FerretDB is a compatible server', { skip: !environment.NEXO_MONGO_FERRETDB }, async () => {
  const report = await connect({
    uri: environment.NEXO_MONGO_FERRETDB,
    password: environment.NEXO_MONGO_PASSWORD,
  });
  assert.equal(report.flavor, 'FerretDB');
});

// The explorer and queries, against the data of tools/mongo-fixture-seed.js.
const seeded = { uri: environment.NEXO_MONGO_PLAIN };
const big = { connection: seeded, database: 'nexo', collection: 'big' };
let queries = 0;
const find = (query) => server.execute('mongo.find', { ...big, id: `q${++queries}`, ...query });

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

// Writes, against a database of their own that each run creates and drops.
const saveConnection = async (id, value) => {
  const saved = await server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind: 'connection',
    name: id,
    revision: 0,
    updated_at: 0,
    value,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
};
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
