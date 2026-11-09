// Contract tests for GraphQL subscriptions over WebSocket, with both protocols servers speak.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
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
