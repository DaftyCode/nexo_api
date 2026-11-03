import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import { RuntimeAdapter } from '../src/adapters/runtime.mjs';
import { ScriptSession } from '../src/adapters/scripts.mjs';
import { importArtifact, generateCode } from '../src/adapters/import-export.mjs';

test('scripts isolate host objects, reject code generation and deliver async request callbacks', async () => {
  const seed = {
    environment: {},
    globals: {},
    local: {},
    collection: {},
    data: { row: 7 },
    secrets: {},
    request: { url: 'https://example.test', method: 'GET' },
    iteration: 0,
  };
  const session = new ScriptSession(seed, async () => ({
    status: 201,
    body: '{"id":42}',
    headers: [],
    cookies: [],
  }));
  await session.run([
    `nx.test('No host access', () => { nx.expect(typeof process).equal('undefined'); nx.expect(typeof require).equal('undefined'); nx.expect(() => ({}).constructor.constructor('return process')()).to.throw(); });
    nx.sendRequest('https://example.test', (error, response) => { nx.test('Callback', () => nx.expect(response.code).equal(201)); nx.environment.set('id', response.json().id); });
    nx.test('Data', () => nx.expect(nx.iterationData.get('row')).equal(7));`,
  ]);
  const state = session.snapshot();
  assert.equal(state.environment.id, 42);
  assert.equal(state.assertions.length, 3);
  assert.ok(
    state.assertions.every((item) => item.passed),
    JSON.stringify(state.assertions),
  );
  assert.deepEqual(seed.environment, {});
  assert.equal(session.replace('{{id}}'), '42');
  await assert.rejects(() => session.run(['while (true) {}']), /timed out/);
});

test('OpenAPI YAML resolves local schema references, groups tags and rejects external references', async () => {
  const specification = {
    openapi: '3.1.0',
    info: { title: 'Inventory' },
    servers: [{ url: 'https://api.example.test' }],
    components: {
      schemas: {
        Product: { type: 'object', properties: { name: { type: 'string', example: 'Ada' } } },
      },
      securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Key' } },
    },
    security: [{ key: [] }],
    paths: {
      '/products/{id}': {
        parameters: [{ name: 'id', in: 'path', schema: { type: 'integer' } }],
        post: {
          tags: ['Products'],
          requestBody: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Product' } } },
          },
          responses: { 201: { description: 'Created' } },
        },
      },
    },
  };
  const result = await importArtifact('', { content: JSON.stringify(specification) });
  const request = result.value.item[0].item[0].request;
  assert.equal(result.name, 'Inventory');
  assert.equal(request.url, 'https://api.example.test/products/{{id}}');
  assert.deepEqual(JSON.parse(request.body.raw), { name: 'Ada' });
  assert.equal(request.auth.type, 'apikey');
  const yaml = await importArtifact('', {
    content: 'openapi: 3.0.3\ninfo:\n  title: YAML API\npaths: {}',
  });
  assert.equal(yaml.name, 'YAML API');
  specification.paths['/products/{id}'].post.requestBody.content['application/json'].schema.$ref =
    'file:///private/schema.json';
  await assert.rejects(
    () => importArtifact('', { content: JSON.stringify(specification) }),
    /External references/,
  );
});

test('generated JavaScript reproduces the request against an actual server', async () => {
  let received;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received = { method: request.method, body, token: request.headers.authorization };
      response.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = generateCode('', {
      language: 'javascript',
      request: {
        url: `http://127.0.0.1:${server.address().port}/example`,
        method: 'POST',
        body: '{"name":"Ada"}',
        auth: { type: 'bearer', token: 'fixture-token' },
      },
    });
    await vm.runInNewContext(`(async () => { ${result.code} })()`, {
      fetch,
      console: { log() {} },
    });
    assert.deepEqual(received, {
      method: 'POST',
      body: '{"name":"Ada"}',
      token: 'Bearer fixture-token',
    });
    assert.match(
      generateCode('', { language: 'csharp', request: { url: 'https://example.test' } }).code,
      /HttpClient/,
    );
    assert.match(
      generateCode('', { language: 'java', request: { url: 'https://example.test' } }).code,
      /HttpRequest/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('collection runner inherits scripts and auth, iterates data and sends form/GraphQL bodies', async () => {
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push({
        url: request.url,
        body,
        authorization: request.headers.authorization,
        type: request.headers['content-type'],
      });
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const runtime = new RuntimeAdapter();
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const collection = {
      info: { name: 'Runner fixture' },
      auth: {
        type: 'basic',
        basic: [
          { key: 'username', value: 'alice' },
          { key: 'password', value: 'secret' },
        ],
      },
      event: [{ listen: 'prerequest', script: { exec: ['nx.environment.set("shared", "yes");'] } }],
      item: [
        {
          name: 'Folder',
          item: [
            {
              name: 'Form',
              request: {
                method: 'POST',
                url: `${url}/{{shared}}`,
                body: { mode: 'urlencoded', urlencoded: [{ key: 'name', value: '{{name}}' }] },
              },
              event: [
                {
                  listen: 'test',
                  script: {
                    exec: [
                      'nx.test("Form response", () => nx.expect(nx.response.json().ok).to.be.true);',
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    const id = runtime.start('alice', {
      collection,
      iterations: 2,
      data: [{ name: 'Ada A' }, { name: 'Linus' }],
    });
    let result;
    do {
      await new Promise((resolve) => setTimeout(resolve, 25));
      result = runtime.status('alice', id);
    } while (result.state === 'running');
    assert.equal(result.state, 'completed', result.error);
    assert.equal(result.assertions.length, 2);
    assert.ok(result.assertions.every((item) => item.passed));
    assert.deepEqual(
      received.map((item) => item.body),
      ['name=Ada+A', 'name=Linus'],
    );
    assert.ok(
      received.every(
        (item) =>
          item.url === '/yes' &&
          item.authorization === `Basic ${Buffer.from('alice:secret').toString('base64')}`,
      ),
    );
    const graph = await runtime.request('alice', {
      request: {
        url,
        method: 'POST',
        protocol: 'graphql',
        body: 'query Q { ok }',
        graphqlVariables: '{"id":7}',
      },
    });
    assert.equal(graph.status, 200);
    assert.deepEqual(JSON.parse(received.at(-1).body), {
      query: 'query Q { ok }',
      variables: { id: 7 },
    });
    const form = await runtime.request('alice', {
      request: {
        url,
        method: 'POST',
        bodyMode: 'formdata',
        form: [{ key: 'hello', value: 'world' }],
      },
    });
    assert.equal(form.status, 200);
    assert.match(received.at(-1).body, /name="hello"\r\n\r\nworld/);
  } finally {
    runtime.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
