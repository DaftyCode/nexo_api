import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { Server } from 'socket.io';
import { RealtimeAdapter } from '../src/adapters/realtime.mjs';
const require = createRequire(import.meta.url);
const mqttRequire = createRequire(require.resolve('mqtt'));
const packet = mqttRequire('mqtt-packet');
async function until(check) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('Timed out waiting for protocol event');
}
test('Socket.IO connects and echoes an event through its own protocol', async () => {
  const httpServer = http.createServer();
  const server = new Server(httpServer);
  server.on('connection', (socket) =>
    socket.on('hello', (message) => socket.emit('reply', message)),
  );
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  const adapter = new RealtimeAdapter();
  try {
    const session = adapter.connect('alice', {
      protocol: 'socketio',
      url: `http://127.0.0.1:${httpServer.address().port}`,
    });
    await until(() => adapter.poll('alice', { id: session.id }).state === 'connected');
    adapter.send('alice', { id: session.id, event: 'hello', message: '{"from":"Nexo"}' });
    await until(() =>
      adapter.poll('alice', { id: session.id }).events.some((x) => x.data.event === 'reply'),
    );
    const reply = adapter
      .poll('alice', { id: session.id })
      .events.find((x) => x.data.event === 'reply');
    assert.equal(reply.data.data[0].from, 'Nexo');
    adapter.disconnect('alice', { id: session.id });
  } finally {
    adapter.close();
    await new Promise((r) => server.close(r));
  }
});
test('MQTT connects, subscribes and publishes against a protocol fixture', async () => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const parser = packet.parser();
    socket.on('data', (data) => parser.parse(data));
    parser.on('packet', (p) => {
      if (p.cmd === 'connect')
        socket.write(packet.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }));
      if (p.cmd === 'subscribe')
        socket.write(
          packet.generate({
            cmd: 'suback',
            messageId: p.messageId,
            granted: p.subscriptions.map(() => 0),
          }),
        );
      if (p.cmd === 'publish')
        socket.write(
          packet.generate({ cmd: 'publish', topic: p.topic, payload: p.payload, qos: 0 }),
        );
      if (p.cmd === 'pingreq') socket.write(packet.generate({ cmd: 'pingresp' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const adapter = new RealtimeAdapter();
  try {
    const session = adapter.connect('alice', {
      protocol: 'mqtt',
      url: `mqtt://127.0.0.1:${server.address().port}`,
      topic: 'nexo/fixture',
    });
    await until(() => adapter.poll('alice', { id: session.id }).state === 'connected');
    adapter.send('alice', { id: session.id, topic: 'nexo/fixture', message: 'hello broker' });
    await until(() =>
      adapter.poll('alice', { id: session.id }).events.some((x) => x.data.text === 'hello broker'),
    );
    adapter.disconnect('alice', { id: session.id });
  } finally {
    adapter.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => server.close(r));
  }
});
