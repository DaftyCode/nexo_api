// Contract tests for protected environments: while a read-only environment is active the
// engine refuses what may change data, from the request, a script (pm.sendRequest) or a
// collection run, and lets reads and GraphQL queries through. A client cannot set it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, startServer, until } from './server.mjs';

let server;
let echo;
const received = [];
before(async () => {
  server = await startServer();
  echo = await fixture((request, body, response) => {
    received.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  for (const [id, protection] of [
    ['prod', 'readonly'],
    ['stage', 'confirm'],
  ]) {
    const saved = await server.api('PUT', '/documents', {
      id,
      workspace_id: 'local',
      kind: 'environment',
      name: id === 'prod' ? 'Production' : 'Staging',
      revision: 0,
      updated_at: 0,
      value: { name: id, values: [], protection, color: '#e5534b' },
    });
    assert.equal(saved.status, 200);
  }
});
after(async () => {
  await echo?.close();
  await server?.stop();
});

const send = (request, extra = {}) => server.execute('request', { request, ...extra });

test('a read-only environment refuses changes and lets reads through', async () => {
  received.length = 0;
  const refused = await send(
    { url: `${echo.url}/orders/1`, method: 'DELETE' },
    { environment: 'prod' },
  );
  assert.equal(refused.status, 0);
  assert.equal(
    refused.error,
    'The environment «Production» is read-only: DELETE requests are not sent',
  );
  const read = await send({ url: `${echo.url}/orders`, method: 'GET' }, { environment: 'prod' });
  assert.equal(read.status, 200);
  assert.deepEqual(received, ['GET /orders']);

  // A script cannot get around it.
  received.length = 0;
  const scripted = await send(
    {
      url: `${echo.url}/list`,
      prerequest: [
        `pm.sendRequest({ url: "${echo.url}/orders/2", method: "POST" }, (error) =>`,
        '  pm.environment.set("scriptError", error ? error.message : "sent"));',
      ].join('\n'),
    },
    { environment: 'prod' },
  );
  assert.equal(scripted.status, 200);
  const values = scripted.variables.environment.values;
  assert.match(values.find((row) => row.key === 'scriptError').value, /read-only: POST/);
  assert.deepEqual(received, ['GET /list']);
});

test('GraphQL queries pass a read-only environment and mutations do not', async () => {
  const graphql = (query) =>
    send(
      { url: `${echo.url}/graphql`, method: 'POST', body: { mode: 'graphql', graphql: { query } } },
      { environment: 'prod' },
    );
  assert.equal((await graphql('query { orders { id } }')).status, 200);
  const mutation = await graphql('mutation { cancel(id: 1) { id } }');
  assert.equal(mutation.status, 0);
  assert.match(mutation.error, /GraphQL mutations are not sent/);
});

test('a collection run in a read-only environment sends only what reads', async () => {
  received.length = 0;
  const started = await server.execute('run', {
    environment: 'prod',
    collection: {
      item: [
        { name: 'list', request: { url: `${echo.url}/run`, method: 'GET' } },
        { name: 'create', request: { url: `${echo.url}/run`, method: 'PUT' } },
      ],
    },
  });
  const done = await until(async () => {
    const current = await server.execute('run', { action: 'status', id: started.id });
    return current.state !== 'running' && current;
  });
  assert.deepEqual(
    done.results.map((result) => [result.name, result.status]),
    [
      ['list', 200],
      ['create', 0],
    ],
  );
  assert.match(done.results[1].error, /read-only: PUT/);
  assert.deepEqual(received, ['GET /run']);
});

test('other environments and clients that name a read-only one send as usual', async () => {
  received.length = 0;
  const staging = await send({ url: `${echo.url}/a`, method: 'POST' }, { environment: 'stage' });
  assert.equal(staging.status, 200, 'asking first is the interface’s job');
  const forged = await send(
    { url: `${echo.url}/b`, method: 'POST' },
    { readOnlyEnvironment: 'Production' },
  );
  assert.equal(forged.status, 200, 'only the application names the read-only environment');
  const gone = await send({ url: `${echo.url}/c`, method: 'POST' }, { environment: 'deleted' });
  assert.equal(gone.status, 200);
  assert.deepEqual(received, ['POST /a', 'POST /b', 'POST /c']);
});
