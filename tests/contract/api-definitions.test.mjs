// Contract tests for API definitions: the linter, the outline and the diff of breaking changes,
// over the same fixtures as the engine's table tests.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer } from './server.mjs';

const fixture = (name) =>
  readFile(
    new URL(`../../backend/crates/nexo-engine/src/api_spec/fixtures/${name}`, import.meta.url),
    'utf8',
  );
let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});

test('a definition is linted with lines and outlined', async () => {
  const valid = await server.execute('api.inspect', { source: await fixture('valid.yaml') });
  assert.equal(valid.version, '3.1');
  assert.deepEqual(valid.findings, []);
  assert.deepEqual(
    valid.outline.paths.map((path) => path.path),
    ['/orders', '/orders/{orderId}'],
  );
  const broken = await server.execute('api.inspect', { source: await fixture('errors.yaml') });
  const errors = broken.findings.filter((finding) => finding.severity === 'error');
  assert.equal(errors.length, 10);
  assert.deepEqual(errors[0], {
    severity: 'error',
    rule: 'info-version',
    params: [],
    pointer: '/info',
    line: 2,
  });
  const unreadable = await server.execute('api.inspect', { source: 'openapi: [' });
  assert.equal(unreadable.findings[0].rule, 'parse');
  await assert.rejects(server.execute('api.inspect', {}), /source/);
  await assert.rejects(server.execute('api.inspect', { source: '', extra: 1 }), /extra/);
});

test('the diff marks the breaking changes between two versions', async () => {
  const diff = await server.execute('api.diff', {
    base: await fixture('valid.yaml'),
    source: await fixture('changed.yaml'),
  });
  assert.equal(diff.breaking, 8);
  assert.deepEqual(
    diff.removed.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    ['delete /orders/{orderId}'],
  );
  assert.deepEqual(
    diff.added.map((endpoint) => `${endpoint.method} ${endpoint.path}`),
    ['put /orders/{id}'],
  );
  const list = diff.changed.find(
    (endpoint) => endpoint.path === '/orders' && endpoint.method === 'get',
  );
  assert.ok(
    list.changes.some((change) => change.rule === 'parameter-added-required' && change.breaking),
  );
  await assert.rejects(server.execute('api.diff', { base: '[', source: 'a: 1' }), /earlier/);
  await assert.rejects(server.execute('api.diff', { base: 'a: 1' }), /source/);
});
