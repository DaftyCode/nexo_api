// Contract tests for the egress policy and the typed operation contract.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { startServer, until } from './server.mjs';
import { server, echo, rows } from './http-fixture.mjs';

test('the deny-private egress policy blocks private destinations', async () => {
  const restricted = await startServer({ NEXO_EGRESS: 'deny-private' });
  try {
    for (const url of [`${echo.url}/private`, 'http://169.254.169.254/latest', 'http://[::1]:9/']) {
      const blocked = await restricted.execute('request', { request: { url } });
      assert.equal(blocked.status, 0, url);
      assert.match(blocked.error, /egress policy/, url);
    }
    const scripted = await restricted.execute('request', {
      request: {
        url: `${echo.url}/blocked`,
        prerequest: [
          `pm.sendRequest("${echo.url}/from-script", (error) =>`,
          '  pm.environment.set("scriptError", error ? error.message : "sent"));',
        ].join('\n'),
      },
    });
    assert.match(
      rows(scripted.variables.environment.values).scriptError,
      /egress policy/,
      'pm.sendRequest follows the egress policy',
    );
    await assert.rejects(
      restricted.execute('oauth.token', { url: `${echo.url}/token`, fields: { grant_type: 'x' } }),
      /egress policy/,
    );
    await assert.rejects(
      restricted.execute('realtime.connect', { protocol: 'websocket', url: 'ws://127.0.0.1:9' }),
      /egress policy/,
    );
    const mock = await restricted.execute('mock.start', {
      examples: [{ path: '/own', body: { ok: true } }],
    });
    const own = await restricted.execute('request', { request: { url: `${mock.url}/own` } });
    assert.equal(own.status, 200, 'requests may reach the user’s own mocks');
  } finally {
    await restricted.stop();
  }
});

test('the server accepts every operation of the generated TypeScript contract', async () => {
  const source = await readFile('src/app/application/operations.ts', 'utf8');
  const block = source.slice(source.indexOf('EXECUTION_OPERATIONS'), source.indexOf('] as const'));
  const operations = [...block.matchAll(/'([a-z.]+)'/g)].map((match) => match[1]);
  assert.ok(operations.length > 20);
  for (const operation of operations) {
    if (operation === 'performance') continue; // starts a load test with no request: rejected below
    const response = await server.api('POST', `/execute/${operation}`, { workspace: 'local' });
    assert.notEqual(response.body?.error, 'Unknown execution operation', operation);
  }
  const unknown = await server.api('POST', '/execute/shell.exec', { workspace: 'local' });
  assert.equal(unknown.body.error, 'Unknown execution operation');
});

test('typed payloads are refused at the edge, naming the field', async () => {
  const misspelled = await server.api('POST', '/execute/request', {
    workspace: 'local',
    request: { url: `${echo.url}/never` },
    strictSsl: false,
  });
  assert.equal(misspelled.status, 400);
  assert.equal(misspelled.body.code, 'validation');
  assert.match(
    misspelled.body.error,
    /^Invalid request payload at strictSsl: unknown field `strictSsl`/,
  );
  const wrongType = await server.api('POST', '/execute/run', {
    workspace: 'local',
    collection: { info: { name: 'C' }, item: [] },
    iterations: 'many',
  });
  assert.equal(wrongType.status, 400);
  assert.match(
    wrongType.body.error,
    /^Invalid run payload at iterations: invalid type: string "many"/,
  );
  const row = await server.api('POST', '/execute/request', {
    workspace: 'local',
    request: { url: `${echo.url}/never` },
    variables: [{ value: 'no key' }],
  });
  assert.match(row.body.error, /at variables\[0\]: missing field `key`/);
  // Postman documents inside stay open: unknown item fields still reach the engine.
  const sent = await server.execute('request', {
    request: { url: `${echo.url}/typed`, nexoNote: 'kept' },
    variables: [{ key: 'a', value: '1', type: 'default', description: 'Postman field' }],
  });
  assert.equal(sent.status, 200);
});

test('run status returns only entries after the cursor', async () => {
  const started = await server.execute('run', {
    iterations: 3,
    collection: {
      item: [
        {
          name: 'r',
          request: { url: `${echo.url}/cursor` },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {});'] } }],
        },
      ],
    },
  });
  const done = await until(async () => {
    const current = await server.execute('run', { action: 'status', id: started.id });
    return current.state !== 'running' && current;
  });
  assert.deepEqual(done.counts, { results: 3, assertions: 3, logs: 0 });
  const later = await server.execute('run', {
    action: 'status',
    id: started.id,
    after: { results: 2, assertions: 3 },
  });
  assert.equal(later.results.length, 1);
  assert.equal(later.assertions.length, 0);
  assert.equal(later.results[0].iteration, 2);
});
