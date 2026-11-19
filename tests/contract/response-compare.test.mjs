// Contract tests for comparing responses: the same request sent with two environments, and
// what changed between both answers, field by field and leaving out what is asked.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './server.mjs';

let server;
let api;
let sent = 0;
before(async () => {
  server = await startServer();
  // Answers as two stages of the same API would: the stage named in the path, and a field
  // that changes with every request.
  api = http.createServer((request, response) => {
    sent += 1;
    const stage = request.url.split('/')[1];
    response.setHeader('content-type', 'application/json');
    response.setHeader('x-request-id', String(sent));
    if (stage === 'staging') response.setHeader('x-debug', 'on');
    response.end(
      JSON.stringify({
        stage,
        updatedAt: `2026-11-${10 + sent}`,
        items: stage === 'staging' ? [{ id: 1 }, { id: 2 }] : [{ id: 1 }],
      }),
    );
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
});
after(async () => {
  await new Promise((resolve) => api?.close(resolve));
  await server?.stop();
});

/** Sends the request with an environment that names the stage. */
const send = (stage) =>
  server.execute('request', {
    request: { method: 'GET', url: `http://127.0.0.1:${api.address().port}/{{stage}}/orders` },
    variables: [{ key: 'stage', value: stage }],
  });
const side = ({ status, statusText, headers, body }) => ({ status, statusText, headers, body });

test('the same request with two environments shows exactly what changed', async () => {
  const staging = await send('staging');
  const production = await send('production');
  const compared = await server.execute('response.compare', {
    source: side(staging),
    target: side(production),
    ignore: ['updatedAt'],
    ignoreHeaders: ['X-Request-*', 'date'],
  });
  assert.equal(compared.same, false);
  assert.equal(compared.status.same, true);
  // The header only staging sends, and the length of its longer body.
  assert.deepEqual(compared.headers.map((header) => header.name).sort(), [
    'content-length',
    'x-debug',
  ]);
  assert.deepEqual(
    compared.headers.find((header) => header.name === 'x-debug'),
    { name: 'x-debug', source: 'on' },
  );
  assert.equal(compared.body.format, 'json');
  assert.deepEqual(compared.body.differences, [
    { path: '$.stage', source: 'staging', target: 'production' },
    { path: '$.items[1]', source: { id: 2 } },
  ]);
  assert.ok(!compared.body.source.includes('updatedAt'));

  // Without leaving it out, the field that changes with every request is a difference.
  const all = await server.execute('response.compare', {
    source: side(staging),
    target: side(production),
  });
  assert.ok(all.body.differences.some((difference) => difference.path === '$.updatedAt'));
  assert.ok(all.headers.some((header) => header.name === 'x-request-id'));
});

test('a response compared with itself is the same, and wrong paths are refused', async () => {
  const response = await send('production');
  const same = await server.execute('response.compare', {
    source: side(response),
    target: side(response),
  });
  assert.equal(same.same, true);
  assert.deepEqual(same.body.differences, []);
  await assert.rejects(
    server.execute('response.compare', {
      source: side(response),
      target: side(response),
      ignore: ['items[x]'],
    }),
    /Invalid path to ignore: items\[x\]/,
  );
  await assert.rejects(server.execute('response.compare', { source: {} }), /target/);
  await assert.rejects(
    server.execute('response.compare', { source: {}, target: {}, time: 1 }),
    /time/,
  );
});
