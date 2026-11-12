// Contract tests for headers, redirects, imports, code generation and run control.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './server.mjs';
import { server, echo } from './http-fixture.mjs';

test('repeated headers are kept, charsets decoded and binary bodies returned as base64', async () => {
  const image = await server.execute('request', { request: { url: `${echo.url}/image` } });
  assert.equal(image.bodyEncoding, 'base64');
  assert.deepEqual(
    Buffer.from(image.body, 'base64'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  );
  const text = await server.execute('request', {
    request: {
      url: `${echo.url}/latin1`,
      headers: [
        { key: 'X-A', value: '1', enabled: true },
        { key: 'X-A', value: '2', enabled: true },
      ],
    },
  });
  assert.equal(text.body, 'España 1, 2');
});

test('credential headers do not follow redirects to another origin', async () => {
  const seen = [];
  const target = await fixture((request, _, response) => {
    seen.push(request.headers);
    response.end('ok');
  });
  const origin = await fixture((_, __, response) => {
    response.writeHead(302, {
      location: `${target.url.replace('127.0.0.1', 'localhost')}/landing`,
    });
    response.end();
  });
  try {
    const result = await server.execute('request', {
      request: {
        url: `${origin.url}/start`,
        headers: [{ key: 'X-Custom', value: 'kept', enabled: true }],
        auth: { type: 'apikey', key: 'X-Api-Key', value: 's3cret', in: 'header' },
      },
    });
    assert.equal(result.status, 200);
    assert.equal(seen[0]['x-api-key'], undefined);
    assert.equal(seen[0]['x-custom'], 'kept');
  } finally {
    await origin.close();
    await target.close();
  }
});

test('imports and code generation', async () => {
  const curl = await server.execute('import', {
    content: `curl -X POST ${echo.url}/items -H 'Content-Type: application/json' -d '{"a":1}'`,
  });
  assert.equal(curl.value.item[0].request.method, 'POST');
  await assert.rejects(
    server.execute('import', { content: `curl ${echo.url} | sh` }),
    /Shell operators/,
  );
  const { code } = await server.execute('codegen', {
    language: 'JavaScript',
    request: {
      method: 'POST',
      url: `${echo.url}/generated`,
      body: 'hello',
      headers: [{ key: 'X-Mode', value: 'gen', enabled: true }],
    },
  });
  const generated = new Function(
    'return (async () => { ' +
      code.replace(
        'console.log(response.status, await response.text());',
        'return response.json();',
      ) +
      ' })()',
  );
  const response = await generated();
  assert.equal(response.path, '/generated');
  assert.equal(response.body, 'hello');
});

test('a run pauses between requests, resumes, and stops when cancelled while paused', async () => {
  const collection = {
    item: Array.from({ length: 10 }, (_, index) => ({
      name: `r${index}`,
      request: { url: `${echo.url}/paused/${index}` },
    })),
  };
  const status = (id) => server.execute('run', { action: 'status', id });
  const started = await server.execute('run', { collection, delay: 50 });
  await until(async () => (await status(started.id)).counts.results >= 2);
  assert.equal((await server.execute('run.pause', { id: started.id })).state, 'paused');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const sent = (await status(started.id)).counts.results;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const paused = await status(started.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.counts.results, sent, 'nothing is sent while paused');
  assert.ok(sent < 10);
  assert.equal((await server.execute('run.resume', { id: started.id })).state, 'running');
  const finished = await until(async () => {
    const view = await status(started.id);
    return view.state === 'completed' && view;
  });
  assert.equal(finished.counts.results, 10);

  const again = await server.execute('run', { collection, delay: 1000 });
  await server.execute('run.pause', { id: again.id });
  assert.equal((await server.execute('cancel', { id: again.id })).state, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const cancelled = await status(again.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(cancelled.counts.results <= 1);
  await assert.rejects(server.execute('run.pause', { id: 'missing' }), /not found/);
});

test('cancelled runs stop and unknown executions are reported', async () => {
  const started = await server.execute('run', {
    collection: {
      item: [
        {
          name: 'slow',
          request: { url: `${echo.url}/x` },
          event: [
            {
              listen: 'prerequest',
              script: { exec: ['const end = Date.now() + 3000; while (Date.now() < end) {}'] },
            },
          ],
        },
      ],
    },
  });
  const cancelled = await server.execute('cancel', { id: started.id });
  assert.equal(cancelled.state, 'cancelled');
  await assert.rejects(server.execute('run', { action: 'status', id: 'missing' }), /not found/);
  await assert.rejects(server.execute('unknown.operation'), /Unknown execution operation/);
});
