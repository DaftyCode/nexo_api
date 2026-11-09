// Contract tests for Socket.IO 4: long polling, the upgrade to WebSocket and binary events.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Server } from 'socket.io';
import { startServer, until } from './server.mjs';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});

/**
 * A Socket.IO server that echoes events, answers a binary event with the bytes reversed and
 * records the cookies each Engine.IO request of a session carried.
 */
async function socketServer(options = {}) {
  const httpServer = http.createServer();
  const io = new Server(httpServer, { cookie: true, ...options });
  // After attaching: engine.io takes over the request listeners that were there before.
  const cookies = [];
  httpServer.prependListener('request', (request) => {
    if (request.url.includes('sid=')) cookies.push(request.headers.cookie ?? '');
  });
  httpServer.prependListener('upgrade', (request) => cookies.push(request.headers.cookie ?? ''));
  const received = [];
  io.on('connection', (socket) => {
    socket.on('hello', (message) => socket.emit('reply', message));
    socket.on('file', (file) => {
      received.push(file);
      socket.emit('file-back', { name: file.name, bytes: Buffer.from(file.bytes).reverse() });
    });
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${httpServer.address().port}`,
    cookies,
    received,
    close: () => new Promise((resolve) => io.close(resolve)),
  };
}
const poll = (id, check) =>
  until(async () => {
    const polled = await server.execute('realtime.poll', { id });
    return check(polled) && polled;
  });
const event = (polled, name) =>
  polled.events.find((item) => item.type === 'message' && item.data?.event === name);

for (const [label, transports, serverTransports, expected] of [
  ['long polling only', 'polling', ['polling'], 'polling'],
  ['both transports, upgraded', undefined, undefined, 'websocket'],
  ['WebSocket only', 'websocket', ['websocket'], 'websocket'],
]) {
  test(`Socket.IO with ${label}: echoes, and sends and receives binary events`, async () => {
    const fixture = await socketServer(serverTransports ? { transports: serverTransports } : {});
    try {
      const { id } = await server.execute('realtime.connect', {
        protocol: 'socketio',
        url: fixture.url,
        ...(transports ? { transports } : {}),
      });
      const opened = await poll(id, (p) => p.events.some((item) => item.type === 'transport'));
      assert.equal(opened.state, 'connected');
      assert.equal(opened.events.find((item) => item.type === 'transport').data, expected);
      if (!transports) assert.ok(opened.events.some((item) => item.type === 'upgrade'));

      await server.execute('realtime.send', { id, event: 'hello', message: '{"from":"Nexo"}' });
      const echoed = await poll(id, (p) => event(p, 'reply'));
      assert.deepEqual(event(echoed, 'reply').data.data, [{ from: 'Nexo' }]);

      // A $binary value is sent as an attachment and arrives as a Buffer.
      await server.execute('realtime.send', {
        id,
        event: 'file',
        message: JSON.stringify({ name: 'a.bin', bytes: { $binary: 'AQID/w==' } }),
      });
      const back = await poll(id, (p) => event(p, 'file-back'));
      assert.ok(Buffer.isBuffer(fixture.received[0].bytes));
      assert.deepEqual([...fixture.received[0].bytes], [1, 2, 3, 255]);
      assert.deepEqual(event(back, 'file-back').data.data, [
        { name: 'a.bin', bytes: { $binary: Buffer.from([255, 3, 2, 1]).toString('base64') } },
      ]);

      // Sticky sessions: every request after the handshake carried its cookie.
      if (transports !== 'websocket') {
        assert.ok(fixture.cookies.length > 0);
        assert.ok(
          fixture.cookies.every((cookie) => cookie.startsWith('io=')),
          JSON.stringify(fixture.cookies),
        );
      }
      await server.execute('realtime.close', { id });
    } finally {
      await fixture.close();
    }
  });
}

test('Socket.IO falls back to WebSocket when long polling is refused', async () => {
  const fixture = await socketServer({ transports: ['websocket'] });
  try {
    const { id } = await server.execute('realtime.connect', {
      protocol: 'socketio',
      url: fixture.url,
    });
    const opened = await poll(id, (p) => p.events.some((item) => item.type === 'transport'));
    assert.equal(opened.events.find((item) => item.type === 'transport').data, 'websocket');
    await server.execute('realtime.close', { id });
    const refused = await server.execute('realtime.connect', {
      protocol: 'socketio',
      url: fixture.url,
      transports: 'polling',
    });
    const failed = await poll(refused.id, (p) => p.state === 'error');
    assert.match(JSON.stringify(failed.events), /Long polling failed \(HTTP 400\)/);
  } finally {
    await fixture.close();
  }
});
