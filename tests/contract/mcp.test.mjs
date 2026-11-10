// Contract tests for the MCP server: resources and prompts over Streamable HTTP, without any
// vault value or credential in what a client reads.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const secret = 'vault-value-7f3a91';
let server;
before(async () => {
  server = await startServer();
  assert.equal(
    (await server.api('PUT', '/secrets/api', { value: secret, allowedHosts: [] })).status,
    200,
  );
  const save = (document) =>
    server.api('PUT', '/documents', {
      workspace_id: 'local',
      revision: 0,
      updated_at: 0,
      ...document,
    });
  await save({
    id: 'shop',
    kind: 'collection',
    name: 'Shop',
    value: {
      info: { name: 'Shop' },
      auth: { type: 'apikey', apikey: [{ key: 'value', value: 'literal-api-key' }] },
      item: [
        {
          id: 'orders',
          name: 'List orders',
          request: {
            method: 'GET',
            url: '{{base}}/orders?key={{vault:api}}',
            header: [{ key: 'X-Debug', value: `pasted ${secret}` }],
          },
        },
      ],
    },
  });
  await save({
    id: 'dev',
    kind: 'environment',
    name: 'Dev',
    value: { values: [{ key: 'clientSecret', value: 'env-secret-value' }] },
  });
  await save({
    id: 'last',
    kind: 'history',
    name: 'GET /orders',
    value: { request: { url: '/orders' }, response: { status: 503, body: `down ${secret}` } },
  });
});
after(async () => {
  await server?.stop();
});

async function rpc(method, params = {}) {
  const { status, body } = await server.api('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  });
  assert.equal(status, 200);
  return body;
}

test('a client sees and reads the resources without secrets', async () => {
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.deepEqual(initialized.result.capabilities.prompts, { listChanged: false });
  const { resources } = (await rpc('resources/list')).result;
  assert.deepEqual(
    resources.map((resource) => resource.uri),
    [
      'nexo://workspaces/local/collections/shop',
      'nexo://workspaces/local/environments/dev',
      'nexo://workspaces/local/history/latest',
    ],
  );
  const everything = [];
  for (const { uri } of resources) {
    const read = await rpc('resources/read', { uri });
    everything.push(read.result.contents[0].text);
  }
  everything.push(
    (
      await rpc('resources/read', {
        uri: 'nexo://workspaces/local/collections/shop/requests/orders',
      })
    ).result.contents[0].text,
  );
  const text = everything.join('\n');
  assert.match(text, /List orders/);
  assert.match(text, /\{\{vault:api\}\}/, 'references stay');
  assert.match(text, /down \[REDACTED\]/);
  for (const hidden of [secret, 'literal-api-key', 'env-secret-value'])
    assert.ok(!text.includes(hidden), hidden);
  const missing = await rpc('resources/read', { uri: 'nexo://workspaces/local/collections/none' });
  assert.equal(missing.error.code, -32002);
});

test('a client uses the prompts, which embed resources without secrets', async () => {
  const { prompts } = (await rpc('prompts/list')).result;
  assert.deepEqual(
    prompts.map((prompt) => prompt.name),
    ['write_tests', 'explain_failure', 'document_collection'],
  );
  const tests = await rpc('prompts/get', {
    name: 'write_tests',
    arguments: { collection: 'Shop', request: 'List orders' },
  });
  const [instruction, embedded] = tests.result.messages;
  assert.match(instruction.content.text, /pm\.test/);
  assert.equal(
    embedded.content.resource.uri,
    'nexo://workspaces/local/collections/shop/requests/orders',
  );
  assert.ok(!embedded.content.resource.text.includes(secret));
  const failure = await rpc('prompts/get', { name: 'explain_failure' });
  assert.match(failure.result.messages[1].content.resource.text, /503/);
  const invalid = await rpc('prompts/get', { name: 'write_tests', arguments: {} });
  assert.equal(invalid.error.code, -32602);
});
