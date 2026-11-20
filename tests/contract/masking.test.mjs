// Contract tests for data masking: a set of rules saved in the workspace masks documents and
// rows, its hashes are the same for the same value and its key stays in the vault, out of
// sight; MCP agents read through the sets marked for them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './server.mjs';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});

const save = (id, value) =>
  server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind: 'masking',
    name: id,
    revision: 0,
    updated_at: 0,
    value,
  });

const customers = [
  {
    name: 'Ana Real',
    email: 'ana.real@corp.com',
    card: { number: '4111 1111 1111 1234' },
    password: 'hunter2',
    city: 'Madrid',
  },
  {
    name: 'Luis Real',
    email: 'ana.real@corp.com',
    card: { number: '5500 0000 0000 0004' },
    password: 'letmein',
    city: 'Lima',
  },
];

test('a saved set masks every field it names and leaves the rest as it was', async () => {
  const saved = await save('customers', {
    rules: [
      { path: 'email', method: 'hash' },
      { path: 'card.number', method: 'truncate', keep: 4 },
      { path: 'password', method: 'remove' },
      { path: 'name', method: 'synthetic' },
    ],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const { documents } = await server.execute('mask.apply', {
    set: 'customers',
    documents: customers,
  });
  const text = JSON.stringify(documents);
  for (const original of ['Ana Real', 'ana.real@corp.com', '4111 1111', 'hunter2', 'letmein'])
    assert.ok(!text.includes(original), original);
  assert.equal(documents[0].city, 'Madrid');
  assert.equal(documents[0].card.number, '**** 1234');
  assert.equal('password' in documents[0], false);
  assert.match(documents[0].email, /^[0-9a-f]{16}$/);
  // The same email, the same token: masked data still joins.
  assert.equal(documents[0].email, documents[1].email);
  assert.equal(documents[0].name.split(' ').length, 2);
  const again = await server.execute('mask.apply', { set: 'customers', documents: customers });
  assert.deepEqual(again.documents, documents);
});

test('rows of a table come back without the removed columns', async () => {
  const masked = await server.execute('mask.apply', {
    set: 'customers',
    columns: ['id', 'EMAIL', 'password'],
    rows: [[1, 'ana.real@corp.com', 'hunter2']],
  });
  assert.deepEqual(masked.kept, [0, 1]);
  assert.equal(masked.rows[0].length, 2);
  assert.match(masked.rows[0][1], /^[0-9a-f]{16}$/);
});

test('the key of the hashes is never listed, read or changed through the vault', async () => {
  const listed = await server.api('GET', '/secrets');
  assert.equal(
    listed.body.secrets.some((secret) => secret.name.startsWith('nexo-masking')),
    false,
  );
  const changed = await server.api('PUT', '/secrets/nexo-masking:local', { value: 'known' });
  assert.equal(changed.status, 400);
  const removed = await server.api('DELETE', '/secrets/nexo-masking:local');
  assert.equal(removed.status, 400);
});

test('wrong sets are refused when saved and when used', async () => {
  const invalid = await save('broken', { rules: [{ path: 'email', method: 'shred' }] });
  assert.equal(invalid.status, 400);
  await assert.rejects(
    server.execute('mask.apply', { set: 'missing', documents: [] }),
    (error) => error.status === 404,
  );
  await assert.rejects(server.execute('mask.apply', { documents: [] }), /Choose a masking set/);
});

test('MCP agents read through the sets marked for them', async () => {
  const api = http.createServer((_, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ customer: { email: 'ana.real@corp.com' }, total: 12 }));
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  try {
    const call = async () => {
      const reply = await server.api('POST', '/mcp', {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'send_request',
          arguments: { request: { url: `http://127.0.0.1:${api.address().port}/orders` } },
        },
      });
      assert.equal(reply.status, 200);
      return JSON.parse(JSON.parse(reply.body.result.content[0].text).body);
    };
    // The sets not marked for agents mask only the exports that choose them.
    assert.equal((await call()).customer.email, 'ana.real@corp.com');
    const saved = await save('agents', {
      agents: true,
      rules: [{ path: 'email', method: 'hide' }],
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(await call(), { customer: { email: '****' }, total: 12 });
  } finally {
    await new Promise((resolve) => api.close(resolve));
  }
});
