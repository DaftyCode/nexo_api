// Contract tests for GraphQL subscriptions over WebSocket, with both protocols servers speak,
// and over server-sent events (graphql-sse, distinct connections).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { startServer, until } from './server.mjs';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});

/**
 * A GraphQL subscription server for one protocol: it acknowledges `connection_init`, sends
 * three results for the subscription and records what the client sent.
 */
async function subscriptionServer(protocol, { complete = false } = {}) {
  const received = [];
  const sockets = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (offered) => (offered.has(protocol) ? protocol : false),
  });
  sockets.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      received.push(message);
      const send = (value) => socket.send(JSON.stringify(value));
      if (message.type === 'connection_init') {
        send({ type: 'connection_ack' });
        if (protocol === 'graphql-ws') send({ type: 'ka' });
        else send({ type: 'ping' });
      }
      if (message.type === 'subscribe' || message.type === 'start') {
        const kind = protocol === 'graphql-ws' ? 'data' : 'next';
        for (const tick of [1, 2, 3])
          send({ id: message.id, type: kind, payload: { data: { ticks: tick } } });
        if (complete) send({ id: message.id, type: 'complete' });
      }
    });
  });
  await new Promise((resolve) => sockets.once('listening', resolve));
  return {
    url: `127.0.0.1:${sockets.address().port}/graphql`,
    received,
    close: () => new Promise((resolve) => sockets.close(resolve)),
  };
}
const poll = (id, check) =>
  until(async () => {
    const polled = await server.execute('realtime.poll', { id });
    return check(polled) && polled;
  });
const ticks = (polled) =>
  polled.events.filter((event) => event.type === 'next').map((event) => event.data.data.ticks);

for (const [protocol, scheme] of [
  ['graphql-transport-ws', 'http'],
  ['graphql-ws', 'ws'],
]) {
  test(`${protocol}: a subscription receives its results and is cancelled on close`, async () => {
    const fixture = await subscriptionServer(protocol);
    try {
      const connection = await server.execute('realtime.connect', {
        protocol: 'graphql-subscription',
        url: `${scheme}://${fixture.url}`,
        graphqlProtocol: protocol,
        query: 'subscription Ticks($from: Int) { ticks(from: $from) }',
        variables: '{"from": 1}',
        operationName: 'Ticks',
        connectionParams: '{"authorization": "Bearer t"}',
      });
      const polled = await poll(connection.id, (value) => ticks(value).length === 3);
      assert.equal(polled.state, 'connected');
      assert.deepEqual(ticks(polled), [1, 2, 3]);
      assert.deepEqual(fixture.received[0], {
        type: 'connection_init',
        payload: { authorization: 'Bearer t' },
      });
      assert.deepEqual(fixture.received[1], {
        id: '1',
        type: protocol === 'graphql-ws' ? 'start' : 'subscribe',
        payload: {
          query: 'subscription Ticks($from: Int) { ticks(from: $from) }',
          variables: { from: 1 },
          operationName: 'Ticks',
        },
      });
      await assert.rejects(
        server.execute('realtime.send', { id: connection.id, message: 'x' }),
        /only receives/,
      );

      await server.execute('realtime.close', { id: connection.id });
      const ended = protocol === 'graphql-ws' ? ['stop', 'connection_terminate'] : ['complete'];
      await until(() => ended.every((type) => fixture.received.some((m) => m.type === type)));
      if (protocol === 'graphql-transport-ws')
        assert.ok(fixture.received.some((message) => message.type === 'pong'));
    } finally {
      await fixture.close();
    }
  });
}

test('a subscription the server completes closes the connection', async () => {
  const fixture = await subscriptionServer('graphql-transport-ws', { complete: true });
  try {
    const connection = await server.execute('realtime.connect', {
      protocol: 'graphql-subscription',
      url: `ws://${fixture.url}`,
      query: 'subscription { ticks }',
    });
    const polled = await poll(connection.id, (value) => value.state === 'closed');
    assert.deepEqual(ticks(polled), [1, 2, 3]);
    assert.equal(polled.events.at(-1).type, 'complete');
  } finally {
    await fixture.close();
  }
});

test('a subscription needs a query and valid variables', async () => {
  const connect = (extra) =>
    server.execute('realtime.connect', {
      protocol: 'graphql-subscription',
      url: 'ws://127.0.0.1:9/graphql',
      ...extra,
    });
  await assert.rejects(connect({ query: ' ' }), /Enter the subscription to send/);
  await assert.rejects(
    connect({ query: 'subscription { a }', variables: '{' }),
    /GraphQL variables must be valid JSON/,
  );
  await assert.rejects(
    connect({ query: 'subscription { a }', graphqlProtocol: 'sse' }),
    /Unknown GraphQL subscription protocol sse/,
  );
});

/**
 * A graphql-sse server (distinct connections): each POST streams three results. With
 * `complete` it ends the stream; otherwise it keeps it open until the client leaves.
 */
async function sseServer({ complete = false, status = 200, json = false } = {}) {
  const requests = [];
  let closed = 0;
  const http = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      requests.push({ headers: request.headers, body: JSON.parse(body || '{}') });
      if (status !== 200) {
        response.writeHead(status, { 'content-type': 'application/json' });
        return response.end('{"errors":[{"message":"Not allowed"}]}');
      }
      if (json) {
        response.writeHead(200, { 'content-type': 'application/json' });
        return response.end('{"data":{"ticks":7}}');
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      response.write(': connected\n\n');
      for (const tick of [1, 2, 3])
        response.write(`event: next\ndata: ${JSON.stringify({ data: { ticks: tick } })}\n\n`);
      if (complete) return response.end('event: complete\ndata:\n\n');
      // Kept open: the client ends the subscription by leaving.
      response.on('close', () => closed++);
    });
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${http.address().port}/graphql/stream`,
    requests,
    closed: () => closed,
    close: () =>
      new Promise((resolve) => {
        http.closeAllConnections();
        http.close(resolve);
      }),
  };
}

test('graphql-sse: a subscription streams its results and is cancelled on close', async () => {
  const fixture = await sseServer();
  try {
    const connection = await server.execute('realtime.connect', {
      protocol: 'graphql-subscription',
      url: fixture.url,
      graphqlProtocol: 'graphql-sse',
      query: 'subscription Ticks($from: Int) { ticks(from: $from) }',
      variables: '{"from": 1}',
      operationName: 'Ticks',
      headers: [{ key: 'Authorization', value: 'Bearer t' }],
    });
    const polled = await poll(connection.id, (value) => ticks(value).length === 3);
    assert.equal(polled.state, 'connected');
    assert.deepEqual(ticks(polled), [1, 2, 3]);
    const [request] = fixture.requests;
    assert.equal(request.headers.accept, 'text/event-stream');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers.authorization, 'Bearer t');
    assert.deepEqual(request.body, {
      query: 'subscription Ticks($from: Int) { ticks(from: $from) }',
      variables: { from: 1 },
      operationName: 'Ticks',
    });
    await server.execute('realtime.close', { id: connection.id });
    await until(() => fixture.closed() === 1);
  } finally {
    await fixture.close();
  }
});

test('graphql-sse: the server completes, answers once, or refuses', async () => {
  const completed = await sseServer({ complete: true });
  const single = await sseServer({ json: true });
  const refused = await sseServer({ status: 401 });
  try {
    const connect = (url) =>
      server.execute('realtime.connect', {
        protocol: 'graphql-subscription',
        url,
        graphqlProtocol: 'graphql-sse',
        query: 'subscription { ticks }',
      });
    const done = await poll((await connect(completed.url)).id, (v) => v.state === 'closed');
    assert.deepEqual(ticks(done), [1, 2, 3]);
    assert.equal(done.events.at(-1).type, 'complete');
    const once = await poll((await connect(single.url)).id, (v) => v.state === 'closed');
    assert.deepEqual(ticks(once), [7]);
    // ws:// is reached over http:// for this protocol.
    const failed = await poll(
      (await connect(refused.url.replace('http://', 'ws://'))).id,
      (v) => v.state === 'error',
    );
    assert.match(JSON.stringify(failed.events), /HTTP 401/);
    assert.equal(refused.requests.length, 1);
  } finally {
    await Promise.all([completed.close(), single.close(), refused.close()]);
  }
});
