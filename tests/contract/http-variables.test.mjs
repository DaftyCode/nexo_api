// Contract tests for variables, scripts and runs.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './server.mjs';
import { server, echo, rows } from './http-fixture.mjs';

test('a request inherits collection variables, auth and scripts without leaking folder scope', async () => {
  const result = await server.execute('request', {
    request: {
      name: 'Users',
      method: 'GET',
      url: '{{host}}/{{resource}}',
      auth: { type: 'inherit' },
    },
    variables: [{ key: 'host', value: echo.url, enabled: true }],
    globals: [{ key: 'tenant', value: 'acme', enabled: true }],
    context: {
      ancestors: [
        {
          name: 'API',
          variable: [{ key: 'resource', value: 'root-resource' }],
          auth: { type: 'bearer', bearer: [{ key: 'token', value: 'collection-token' }] },
          event: [
            {
              listen: 'prerequest',
              script: { exec: ['pm.collectionVariables.set("visits", "1");'] },
            },
          ],
        },
        { name: 'Folder', variable: [{ key: 'resource', value: 'users' }] },
      ],
    },
  });
  const body = JSON.parse(result.body);
  assert.equal(body.path, '/users');
  assert.equal(body.authorization, 'Bearer collection-token');
  assert.deepEqual(
    result.variables.collection.find((row) => row.key === 'visits'),
    { key: 'visits', value: '1' },
  );
  assert.ok(
    !result.variables.collection.some((row) => row.key === 'resource' && row.value === 'users'),
  );
  assert.deepEqual(result.variables.globals.values, [
    { key: 'tenant', value: 'acme', enabled: true },
  ]);
});

test('scripts set and unset variables, keep their order and report assertions', async () => {
  const result = await server.execute('request', {
    request: {
      url: `${echo.url}/token`,
      tests: [
        'pm.environment.set("token", pm.response.json().path);',
        'pm.globals.set("seen", "yes");',
        'pm.environment.unset("stale");',
        'pm.test("status", () => pm.response.to.have.status(200));',
      ].join('\n'),
    },
    variables: [
      { key: 'stale', value: 'old', enabled: true },
      { key: 'keep', value: 'value', enabled: true },
    ],
  });
  assert.deepEqual(
    result.variables.environment.values.map((row) => row.key),
    ['keep', 'token'],
  );
  assert.deepEqual(rows(result.variables.environment.values), { keep: 'value', token: '/token' });
  assert.deepEqual(result.variables.globals.values, [{ key: 'seen', value: 'yes', enabled: true }]);
  assert.equal(result.assertions[0].passed, true);
});

test('query variables are substituted after encoding', async () => {
  const result = await server.execute('request', {
    request: {
      url: `${echo.url}/search`,
      query: [
        { key: 'tenant', value: '{{tenant}}', enabled: true },
        { key: 'q', value: 'a b&c', enabled: true },
      ],
    },
    variables: [{ key: 'tenant', value: 'acme', enabled: true }],
  });
  assert.equal(JSON.parse(result.body).path, '/search?tenant=acme&q=a%20b%26c');
});

test('path variables of a Postman URL are filled in, with their own variables resolved', async () => {
  const result = await server.execute('request', {
    item: {
      name: 'Claims',
      request: {
        method: 'GET',
        url: {
          raw: `${echo.url}/orders/:order/items?status=6`,
          variable: [{ key: 'order', value: '{{order}}' }],
        },
      },
    },
    variables: [{ key: 'order', value: '1234567', enabled: true }],
  });
  assert.equal(JSON.parse(result.body).path, '/orders/1234567/items?status=6');
});

test('runs keep folder variables in their folder, order test scripts and iterate data', async () => {
  const script = (listen, line) => ({ listen, script: { exec: [line] } });
  const started = await server.execute('run', {
    iterations: 2,
    data: [{ n: 1 }, { n: 2 }],
    collection: {
      info: { name: 'Order' },
      variable: [{ key: 'base', value: echo.url }],
      event: [script('test', 'pm.collectionVariables.set("order", "collection");')],
      item: [
        {
          name: 'A',
          variable: [{ key: 'scoped', value: 'from-a' }],
          event: [
            script(
              'test',
              'pm.collectionVariables.set("order", pm.collectionVariables.get("order") + ",folder");',
            ),
          ],
          item: [
            {
              name: 'first',
              request: { method: 'POST', url: '{{base}}/a', body: { mode: 'raw', raw: 'n={{n}}' } },
              event: [
                script(
                  'test',
                  'pm.test("outer first", () => pm.expect(pm.collectionVariables.get("order")).to.equal("collection,folder"));',
                ),
                script(
                  'test',
                  'pm.test("data", () => pm.expect(pm.response.json().body).to.equal("n=" + pm.iterationData.get("n")));',
                ),
              ],
            },
          ],
        },
        {
          name: 'B',
          item: [
            {
              name: 'second',
              request: { method: 'GET', url: '{{base}}/b' },
              event: [
                script(
                  'test',
                  'pm.test("folder variable hidden", () => pm.expect(pm.collectionVariables.get("scoped")).to.equal(undefined));',
                ),
              ],
            },
          ],
        },
      ],
    },
  });
  const status = await until(async () => {
    const current = await server.execute('run', { action: 'status', id: started.id });
    return current.state !== 'running' && current;
  });
  assert.equal(status.state, 'completed', status.error);
  assert.equal(status.results.length, 4);
  assert.equal(status.assertions.length, 6);
  assert.ok(
    status.assertions.every((assertion) => assertion.passed),
    JSON.stringify(status.assertions),
  );
});
