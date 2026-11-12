// Contract tests for MongoDB indexes, explain and the profiler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, server, plain, seeded, saveConnection } from './mongo-fixture.mjs';

// Ids of this file's own queries.
let queries = 0;

const tuning = (operation, payload, connectionId = 'tuner') =>
  server.execute(operation, {
    connection: seeded,
    connectionId,
    database: 'nexo_tuning',
    collection: 'orders',
    ...payload,
  });
const explainOrders = (extra = {}) =>
  server
    .execute('mongo.explain', {
      connection: seeded,
      database: 'nexo_tuning',
      collection: 'orders',
      id: `explain-${++queries}`,
      filter: { status: 'A' },
      sort: { at: -1 },
      verbosity: 'executionStats',
      ...extra,
    })
    .then(({ explain }) => explain);
/** The stages of a classic plan, inputs first. */
const stages = (plan) =>
  plan
    ? [...stages(plan.inputStage), plan.stage + (plan.indexName ? `(${plan.indexName})` : '')]
    : [];
const indexesOf = async () =>
  (
    await server.execute('mongo.indexes', {
      connection: seeded,
      database: 'nexo_tuning',
      collection: 'orders',
    })
  ).indexes;

test('a query scans the collection until Nexo creates the index it needs', plain, async () => {
  await saveConnection('tuner', { uri: environment.NEXO_MONGO_PLAIN });
  await tuning('mongo.database.drop', { confirm: 'nexo_tuning', collection: undefined });
  await tuning('mongo.insert', {
    documents: Array.from({ length: 300 }, (_, n) => ({
      n,
      status: n % 3 ? 'B' : 'A',
      at: { $date: { $numberLong: String(1704067200000 + n * 60000) } },
    })),
  });

  let explain = await explainOrders();
  assert.deepEqual(stages(explain.executionStats.executionStages), ['COLLSCAN', 'SORT']);
  assert.equal(explain.executionStats.totalDocsExamined, 300);
  assert.equal(explain.executionStats.nReturned, 100);
  // Only planned: no execution measured.
  const planned = await explainOrders({ verbosity: 'queryPlanner' });
  assert.equal(planned.executionStats, undefined);
  assert.equal(planned.queryPlanner.winningPlan.stage, 'SORT');

  await tuning('mongo.index.create', { keys: { status: 1, at: -1 } });
  explain = await explainOrders();
  assert.deepEqual(stages(explain.executionStats.executionStages), [
    'IXSCAN(status_1_at_-1)',
    'FETCH',
  ]);
  assert.equal(explain.executionStats.totalDocsExamined, 100);

  // The list says what each index is, its size and its use: a query used it (an explain
  // does not count).
  await server.execute('mongo.find', {
    connection: seeded,
    database: 'nexo_tuning',
    collection: 'orders',
    id: `used-${++queries}`,
    filter: { status: 'A' },
    sort: { at: -1 },
  });
  const created = (await indexesOf()).find((index) => index.name === 'status_1_at_-1');
  assert.deepEqual(created.spec.key, { status: { $numberInt: '1' }, at: { $numberInt: '-1' } });
  assert.ok(created.size > 0, 'its size on disk');
  assert.ok(created.accesses >= 1, 'the query used it');
  assert.match(created.since, /^\d{4}-\d{2}-\d{2}T/);

  // Hidden, the planner no longer uses it; shown again, it does.
  await tuning('mongo.index.hide', { name: 'status_1_at_-1', hidden: true });
  explain = await explainOrders();
  assert.deepEqual(stages(explain.executionStats.executionStages), ['COLLSCAN', 'SORT']);
  await tuning('mongo.index.hide', { name: 'status_1_at_-1', hidden: false });
  explain = await explainOrders();
  assert.equal(explain.executionStats.executionStages.inputStage.stage, 'IXSCAN');

  // Every kind of index, with its options; unknown options are refused by name.
  await tuning('mongo.index.create', {
    keys: { at: 1 },
    options: { name: 'expire', expireAfterSeconds: 86400 * 3650, hidden: true },
  });
  await tuning('mongo.index.create', {
    keys: { n: 1 },
    options: { unique: true, partialFilterExpression: { status: 'A' } },
  });
  await tuning('mongo.index.create', {
    keys: { status: 'text' },
    options: { weights: { status: 5 } },
  });
  await tuning('mongo.index.create', { keys: { '$**': 1 }, options: { name: 'everything' } });
  await assert.rejects(
    tuning('mongo.index.create', { keys: { n: 1 }, options: { background: true } }),
    /Unknown index option background/,
  );
  const listed = await indexesOf();
  const spec = (name) => listed.find((index) => index.name === name)?.spec;
  assert.equal(spec('expire').hidden, true);
  assert.ok(spec('expire').expireAfterSeconds);
  assert.equal(spec('n_1').unique, true);
  assert.deepEqual(spec('n_1').partialFilterExpression, { status: 'A' });
  assert.ok(spec('status_text'), 'a text index named as the drivers do');
  assert.ok(spec('everything'));

  // Dropping needs the name; the _id index stays.
  await assert.rejects(
    tuning('mongo.index.drop', { name: 'n_1', confirm: 'n' }),
    /Type the name of the index to confirm: n_1/,
  );
  await tuning('mongo.index.drop', { name: 'n_1', confirm: 'n_1' });
  await assert.rejects(
    tuning('mongo.index.drop', { name: '_id_', confirm: '_id_' }),
    /The _id index cannot be dropped/,
  );
  // An aggregation is explained too, but never one that would write.
  const aggregate = await server.execute('mongo.explain', {
    connection: seeded,
    database: 'nexo_tuning',
    collection: 'orders',
    id: `explain-${++queries}`,
    verbosity: 'executionStats',
    pipeline: [{ $match: { status: 'A' } }, { $group: { _id: null, total: { $sum: 1 } } }],
  });
  assert.ok(aggregate.explain.stages || aggregate.explain.queryPlanner);
  await assert.rejects(
    server.execute('mongo.explain', {
      connection: seeded,
      database: 'nexo_tuning',
      collection: 'orders',
      id: `explain-${++queries}`,
      verbosity: 'executionStats',
      pipeline: [{ $match: {} }, { $out: 'copy' }],
    }),
    /is not explained: running it to measure it would write/,
  );
  const collections = await server.execute('mongo.collections', {
    connection: seeded,
    database: 'nexo_tuning',
  });
  assert.ok(!collections.collections.some((c) => c.name === 'copy'), 'nothing was written');
});

test('the profiler records the slow operations of a test load, slowest first', plain, async () => {
  await saveConnection('profiler', { uri: environment.NEXO_MONGO_PLAIN });
  const profile = () =>
    server.execute('mongo.profile', { connection: seeded, database: 'nexo_tuning' });
  // Every operation counts as slow from 0 ms on.
  const set = await tuning(
    'mongo.profile.set',
    { level: 1, slowms: 0, collection: undefined },
    'profiler',
  );
  assert.deepEqual([set.level, set.slowms], [1, 0]);
  assert.equal((await profile()).level, 1);
  try {
    for (let n = 0; n < 5; n++)
      await server.execute('mongo.find', {
        connection: seeded,
        database: 'nexo_tuning',
        collection: 'orders',
        id: `load-${n}`,
        filter: { n: { $gte: n * 10 } },
        sort: { at: 1 },
      });
    const { entries } = await server.execute('mongo.profile.entries', {
      connection: seeded,
      database: 'nexo_tuning',
      collection: 'orders',
    });
    const finds = entries.filter((entry) => entry.command?.find === 'orders');
    assert.ok(finds.length >= 5, JSON.stringify(entries.map((e) => [e.op, e.ns])));
    assert.ok(
      entries.every((entry, i) => i === 0 || entries[i - 1].millis >= entry.millis),
      'slowest first',
    );
    const recorded = finds.find((entry) => entry.command.comment?.startsWith('nexo:load-'));
    assert.ok(recorded, 'Nexo marks its queries with a comment');
    assert.ok(recorded.docsExamined > 0);
    assert.match(recorded.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(recorded.command.lsid, undefined, 'session fields are left out');
    // A recorded query is explained again from its command.
    const again = await server.execute('mongo.explain', {
      connection: seeded,
      database: 'nexo_tuning',
      collection: 'orders',
      id: `explain-${++queries}`,
      filter: recorded.command.filter,
      sort: recorded.command.sort,
    });
    assert.ok(again.explain.queryPlanner.winningPlan);
  } finally {
    const off = await tuning('mongo.profile.set', { level: 0, collection: undefined }, 'profiler');
    assert.equal(off.level, 0);
  }
  // A read-only connection reads the profiler and the indexes, and changes neither.
  await saveConnection('tuning-reader', { uri: environment.NEXO_MONGO_PLAIN, readOnly: true });
  for (const [operation, payload] of [
    ['mongo.profile.set', { level: 2, collection: undefined }],
    ['mongo.index.create', { keys: { n: -1 } }],
    ['mongo.index.hide', { name: 'status_1_at_-1', hidden: true }],
    ['mongo.index.drop', { name: 'status_1_at_-1', confirm: 'status_1_at_-1' }],
  ])
    await assert.rejects(tuning(operation, payload, 'tuning-reader'), /read-only/, operation);
  await tuning(
    'mongo.database.drop',
    { confirm: 'nexo_tuning', collection: undefined },
    'profiler',
  );
});
