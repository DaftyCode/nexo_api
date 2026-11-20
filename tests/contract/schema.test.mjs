// Contract tests of JSON Schema from responses (B-08): a schema read from five responses
// makes required only what all of them have, and a test that checks it passes with them
// and fails with a response that lacks a required field.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './server.mjs';
import { server } from './http-fixture.mjs';

const users = [1, 2, 3, 4, 5].map((id) => ({
  id,
  email: `user${id}@example.com`,
  created: `2026-11-0${id}T10:00:00Z`,
  role: id % 2 ? 'user' : 'admin',
  ...(id === 3 ? {} : { nickname: `nick${id}` }),
  orders: [{ sku: `A${id}`, total: id * 1.5 }],
}));

test('a schema read from five responses checks the next ones in a test script', async () => {
  const inferred = await server.execute('schema.infer', { samples: users, enums: true });
  assert.equal(inferred.sampled, 5);
  const { schema } = inferred;
  assert.deepEqual(schema.required, ['id', 'email', 'created', 'role', 'orders']);
  assert.equal(schema.properties.email.format, 'email');
  assert.equal(schema.properties.created.format, 'date-time');
  assert.deepEqual(schema.properties.role.enum, ['user', 'admin']);
  assert.equal(schema.properties.nickname.type, 'string');

  const api = await fixture((request, _body, response) => {
    const id = Number(request.url.split('/').at(-1));
    const { email: _left, ...broken } = users[0];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(id ? users[id - 1] : broken));
  });
  try {
    const check = [
      `const schema = ${JSON.stringify(schema)};`,
      "pm.test('The response matches its JSON Schema', () => {",
      '  pm.response.to.have.jsonSchema(schema);',
      '});',
    ];
    const item = (name) => ({
      name,
      request: { url: `${api.url}/users/${name}`, method: 'GET' },
      event: [{ listen: 'test', script: { exec: check } }],
    });
    const started = await server.execute('run', {
      collection: { item: ['1', '2', '3', '4', '5', 'broken'].map(item) },
    });
    const done = await until(async () => {
      const current = await server.execute('run', { action: 'status', id: started.id });
      return current.state !== 'running' && current;
    });
    assert.deepEqual(
      done.assertions.map((assertion) => [assertion.request, assertion.passed]),
      [
        ['1', true],
        ['2', true],
        ['3', true],
        ['4', true],
        ['5', true],
        ['broken', false],
      ],
    );
    assert.match(done.assertions[5].error, /\$: Missing required property "email"/);
  } finally {
    await api.close();
  }
});

test('a schema needs one to a hundred samples', async () => {
  await assert.rejects(server.execute('schema.infer', { samples: [] }), /1 to 100 JSON responses/);
});
