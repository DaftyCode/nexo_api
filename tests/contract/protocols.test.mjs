// Contract tests for WebSocket, Socket.IO, MQTT and gRPC against real protocol servers.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Server } from 'socket.io';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import { startServer, until } from './server.mjs';

const require = createRequire(import.meta.url);
const packet = require('mqtt-packet');

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});
async function events(id, check) {
  return until(async () => {
    const polled = await server.execute('realtime.poll', { id });
    return check(polled) && polled;
  });
}

test('WebSocket connects with headers, sends, receives binary and closes', async () => {
  const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let header;
  sockets.on('connection', (socket, request) => {
    header = request.headers['x-test'];
    socket.on('message', (message) => {
      socket.send(`echo:${message}`);
      socket.send(Buffer.from([1, 2]));
    });
  });
  await new Promise((r) => sockets.once('listening', r));
  try {
    const { id } = await server.execute('realtime.connect', {
      protocol: 'websocket',
      url: `ws://127.0.0.1:${sockets.address().port}`,
      headers: [{ key: 'X-Test', value: 'yes', enabled: true }],
    });
    await events(id, (p) => p.state === 'connected');
    await server.execute('realtime.send', { id, message: 'hello' });
    const polled = await events(id, (p) => p.events.length >= 3);
    assert.equal(header, 'yes');
    assert.deepEqual(polled.events[1].data, { text: 'echo:hello', binary: false });
    assert.deepEqual(polled.events[2].data, { text: 'AQI=', binary: true });
    const list = await server.execute('realtime.list');
    assert.equal(list.find((x) => x.id === id).protocol, 'websocket');
    await server.execute('realtime.close', { id });
    await assert.rejects(server.execute('realtime.poll', { id }), /not found/);
  } finally {
    for (const client of sockets.clients) client.terminate();
    await new Promise((r) => sockets.close(r));
  }
});

test('Socket.IO connects and echoes an event through its own protocol', async () => {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  io.on('connection', (socket) => socket.on('hello', (message) => socket.emit('reply', message)));
  await new Promise((r) => httpServer.listen(0, '127.0.0.1', r));
  try {
    const { id } = await server.execute('realtime.connect', {
      protocol: 'socketio',
      url: `http://127.0.0.1:${httpServer.address().port}`,
    });
    await events(id, (p) => p.state === 'connected');
    await server.execute('realtime.send', { id, event: 'hello', message: '{"from":"Nexo"}' });
    const polled = await events(id, (p) => p.events.some((x) => x.data?.event === 'reply'));
    assert.equal(polled.events.find((x) => x.data?.event === 'reply').data.data[0].from, 'Nexo');
    await server.execute('realtime.close', { id });
  } finally {
    await new Promise((r) => io.close(r));
  }
});

test('MQTT connects, subscribes and publishes against a protocol fixture', async () => {
  const sockets = new Set();
  let subscribed;
  const broker = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const parser = packet.parser();
    socket.on('data', (data) => parser.parse(data));
    parser.on('packet', (p) => {
      if (p.cmd === 'connect')
        socket.write(packet.generate({ cmd: 'connack', returnCode: 0, sessionPresent: false }));
      if (p.cmd === 'subscribe') {
        subscribed = p.subscriptions[0].topic;
        socket.write(
          packet.generate({
            cmd: 'suback',
            messageId: p.messageId,
            granted: p.subscriptions.map(() => 0),
          }),
        );
      }
      if (p.cmd === 'publish')
        socket.write(
          packet.generate({ cmd: 'publish', topic: p.topic, payload: p.payload, qos: 0 }),
        );
      if (p.cmd === 'pingreq') socket.write(packet.generate({ cmd: 'pingresp' }));
    });
  });
  await new Promise((r) => broker.listen(0, '127.0.0.1', r));
  try {
    const { id } = await server.execute('realtime.connect', {
      protocol: 'mqtt',
      url: `mqtt://127.0.0.1:${broker.address().port}`,
      topic: 'nexo/fixture',
    });
    await events(id, (p) => p.state === 'connected');
    await until(() => subscribed === 'nexo/fixture');
    await server.execute('realtime.send', { id, topic: 'nexo/fixture', message: 'hello broker' });
    const polled = await events(id, (p) => p.events.some((x) => x.data?.text === 'hello broker'));
    assert.equal(
      polled.events.find((x) => x.data?.text === 'hello broker').data.topic,
      'nexo/fixture',
    );
    await server.execute('realtime.close', { id });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((r) => broker.close(r));
  }
});

test('gRPC uses a supplied proto for unary and server-streaming calls', async () => {
  const proto = `syntax = "proto3"; package fixture;
service Echo { rpc Say (Request) returns (Response); rpc Count (Request) returns (stream Response); }
message Request { string name = 1; int64 times = 2; }
message Response { string greeting = 1; }`;
  const directory = await mkdtemp(join(tmpdir(), 'nexo-grpc-'));
  const path = join(directory, 'fixture.proto');
  await writeFile(path, proto);
  const definition = grpc.loadPackageDefinition(loader.loadSync(path));
  const grpcServer = new grpc.Server();
  let metadata;
  grpcServer.addService(definition.fixture.Echo.service, {
    Say(call, callback) {
      metadata = call.metadata.get('x-client')[0];
      callback(null, { greeting: `Hello ${call.request.name}` });
    },
    Count(call) {
      for (let i = 0; i < Number(call.request.times); i++) call.write({ greeting: `${i}` });
      call.end();
    },
  });
  const port = await new Promise((resolve, reject) =>
    grpcServer.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  try {
    const listed = await server.execute('grpc', { proto });
    assert.deepEqual(listed.services, ['fixture.Echo']);
    const unary = await server.execute('grpc', {
      proto,
      service: 'fixture.Echo',
      method: 'Say',
      url: `127.0.0.1:${port}`,
      message: { name: 'Nexo' },
      metadata: [{ key: 'x-client', value: 'nexo', enabled: true }],
    });
    assert.equal(unary.message.greeting, 'Hello Nexo');
    assert.equal(metadata, 'nexo');
    const stream = await server.execute('grpc', {
      proto,
      service: 'fixture.Echo',
      method: 'Count',
      url: `127.0.0.1:${port}`,
      message: { name: 'n', times: 3 },
    });
    assert.deepEqual(
      stream.messages.map((m) => m.greeting),
      ['0', '1', '2'],
    );
    await assert.rejects(
      server.execute('grpc', { proto: 'syntax = "proto3"; import "secret/file.proto";' }),
      /inline it/,
    );
  } finally {
    grpcServer.forceShutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
