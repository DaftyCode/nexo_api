// Contract tests for mocks, datasets and load tests.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, until } from './server.mjs';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});

test('mocks match method and path, record calls and reject invalid examples', async () => {
  const mock = await server.execute('mock.start', {
    examples: [
      { method: 'POST', path: '/orders', status: 201, headers: { 'x-mock': '1' }, body: { id: 7 } },
      { path: '*', body: 'fallback' },
    ],
  });
  const created = await fetch(`${mock.url}/orders`, { method: 'POST', body: 'payload' });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('x-mock'), '1');
  assert.deepEqual(await created.json(), { id: 7 });
  assert.equal(await (await fetch(`${mock.url}/other`)).text(), 'fallback');
  const listed = await server.execute('mock.list');
  assert.equal(listed[0].calls[0].body, 'payload');
  await server.execute('mock.stop', { id: mock.id });
  assert.deepEqual(await server.execute('mock.list'), []);
  for (const examples of [
    [{ status: 42 }],
    [{ path: 'relative' }],
    [{ headers: { 'bad header': 'x' } }],
  ])
    await assert.rejects(server.execute('mock.start', { examples }), /Example 1/);
});

test('datasets keep identifiers as text and only allow read-only SQL', async () => {
  const imported = await server.execute('dataset.import', {
    id: 'people',
    content: 'id,code,name\n1,01234,"Ana, ""A"""\n2,00042,Bob\n',
  });
  assert.deepEqual(imported.columns, ['id', 'code', 'name']);
  const result = await server.execute('dataset.query', {
    id: 'people',
    sql: "SELECT code, name FROM data WHERE name LIKE '%select%' OR id = 1",
  });
  assert.deepEqual(result.rows, [{ code: '01234', name: 'Ana, "A"' }]);
  for (const sql of [
    "ATTACH DATABASE 'x' AS x",
    'DELETE FROM data',
    'SELECT 1; SELECT 2',
    "SELECT readfile('x')",
  ])
    await assert.rejects(server.execute('dataset.query', { id: 'people', sql }));
  const schema = await server.execute('dataset.schema', { id: 'people' });
  assert.deepEqual(schema.columns, ['id', 'code', 'name']);
  const parsed = await server.execute('dataset.parse', { content: '[{"a":1}]' });
  assert.deepEqual(parsed, { rows: [{ a: 1 }], total: 1 });
  await server.execute('dataset.delete', { id: 'people' });
  await assert.rejects(
    server.execute('dataset.query', { id: 'people', sql: 'SELECT * FROM data' }),
    /import it again/,
  );
});

test('load tests run virtual users and report a summary', async () => {
  const mock = await server.execute('mock.start', {
    examples: [{ path: '*', body: { ok: true } }],
  });
  try {
    const { id } = await server.execute('performance', {
      request: { url: `${mock.url}/load` },
      users: 2,
      duration: 1,
    });
    const status = await until(
      async () => {
        const current = await server.execute('performance', { action: 'status', id });
        return current.state !== 'running' && current;
      },
      { attempts: 200, delay: 50 },
    );
    assert.equal(status.state, 'completed');
    assert.ok(status.samples > 0);
    assert.equal(status.errors, 0);
    assert.ok(status.summary.rps > 0);
    assert.equal('times' in status, false);
  } finally {
    await server.execute('mock.stop', { id: mock.id });
  }
});
