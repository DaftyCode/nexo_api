import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RuntimeAdapter } from '../src/adapters/runtime.mjs';
import { importArtifact } from '../src/adapters/import-export.mjs';
import { DatasetAdapter, MockAdapter, parseCsv } from '../src/adapters/local-services.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP sends variables and pre-request scripts, and reports response assertions', async () => {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('set-cookie', 'fixture=one; Path=/');
    res.end(
      JSON.stringify({
        path: req.url,
        header: req.headers['x-fixture'],
        cookie: req.headers.cookie,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const runtime = new RuntimeAdapter();
  try {
    const result = await runtime.request('alice', {
      request: {
        name: 'Fixture',
        method: 'GET',
        url: '{{base}}/echo',
        headers: [{ key: 'X-Fixture', value: '{{scriptValue}}', enabled: true }],
        prerequest: 'pm.environment.set("scriptValue", "set-by-script");',
        tests:
          'pm.test("Status", () => pm.response.to.have.status(200));\npm.test("Payload", () => pm.expect(pm.response.json().header).to.eql("set-by-script"));',
      },
      variables: [{ key: 'base', value: `http://127.0.0.1:${port}`, enabled: true }],
    });
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).header, 'set-by-script');
    assert.equal(result.assertions.length, 2);
    assert.ok(
      result.assertions.every((x) => x.passed),
      JSON.stringify(result.assertions),
    );
    assert.deepEqual(
      result.assertions.map((x) => x.name),
      ['Status', 'Payload'],
    );
    const failed = await runtime.request('alice', {
      request: {
        url: `http://127.0.0.1:${port}/echo`,
        headers: [{ key: 'X-Fixture', value: '{{vault:token}}', enabled: true }],
        tests: 'pm.test("Expected failure", () => pm.expect(1).to.eql(2));',
      },
      resolvedSecrets: { token: 'fixture-private-token' },
    });
    assert.equal(failed.assertions[0].name, 'Expected failure');
    assert.equal(failed.assertions[0].passed, false);
    assert.ok(failed.assertions[0].error);
    assert.ok(failed.body.includes('[REDACTED]'));
    assert.ok(!JSON.stringify(failed).includes('fixture-private-token'));
    assert.ok(JSON.parse(failed.body).cookie.includes('fixture=one'));
  } finally {
    runtime.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('execution cancellation and actor boundaries are enforced', async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = new RuntimeAdapter();
  try {
    const id = runtime.start('alice', {
      request: { url: `http://127.0.0.1:${server.address().port}/slow` },
    });
    assert.throws(() => runtime.status('bob', id), /not found/);
    assert.equal(runtime.cancel('alice', id).state, 'cancelled');
  } finally {
    runtime.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
test('imports cURL and portable collections without executing shell operators', async () => {
  const result = await importArtifact('', {
    content: `curl -X POST https://example.test/echo -H 'Content-Type: application/json' -d '{"x":1}'`,
  });
  assert.equal(result.value.item[0].request.method, 'POST');
  assert.equal(result.value.item[0].request.body.raw, '{"x":1}');
  await assert.rejects(
    () => importArtifact('', { content: 'curl https://example.test && whoami' }),
    /operators/,
  );
  const again = await importArtifact('', { content: JSON.stringify(result.value) });
  assert.deepEqual(again.value, result.value);
});
test('datasets support quoted CSV and SQL while rejecting filesystem queries', async () => {
  assert.deepEqual(parseCsv('name,n\n"Ada, A",2\nLinus,3'), [
    { name: 'Ada, A', n: 2 },
    { name: 'Linus', n: 3 },
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'nexo-dataset-test-'));
  const adapter = new DatasetAdapter(directory);
  try {
    const dataset = await adapter.import('alice', { content: 'name,n\nAda,2\nLinus,3' });
    const result = await adapter.query('alice', {
      id: dataset.id,
      sql: 'SELECT SUM(n) AS total FROM data',
    });
    assert.equal(result.rows[0].total, 5);
    await assert.rejects(
      () => adapter.query('alice', { id: dataset.id, sql: "ATTACH '/etc/passwd' AS x" }),
      /read-only/,
    );
    await assert.rejects(() => adapter.query('bob', { id: dataset.id, sql: 'SELECT * FROM data' }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('mock matches method/path and records calls', async () => {
  const mocks = new MockAdapter();
  try {
    const mock = await mocks.start('alice', {
      examples: [{ method: 'GET', path: '/hello', status: 201, body: { hello: 'Nexo' } }],
    });
    const response = await fetch(`${mock.url}/hello`);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { hello: 'Nexo' });
    assert.equal(mocks.list('alice')[0].calls.length, 1);
    assert.equal(mocks.list('bob').length, 0);
    assert.throws(() => mocks.stop('bob', { id: mock.id }), /not found/);
  } finally {
    mocks.close();
  }
});
