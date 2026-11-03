import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import grpc from '@grpc/grpc-js';
import loader from '@grpc/proto-loader';
import { RealtimeAdapter, grpcRequest } from '../src/adapters/realtime.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
test('WebSocket connects, sends, receives and isolates sessions', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  server.on('connection', (socket) => socket.on('message', (data) => socket.send(data.toString())));
  const adapter = new RealtimeAdapter();
  try {
    const session = adapter.connect('alice', {
      protocol: 'websocket',
      url: `ws://127.0.0.1:${server.address().port}`,
    });
    for (let i = 0; i < 100 && adapter.poll('alice', { id: session.id }).state !== 'connected'; i++)
      await new Promise((r) => setTimeout(r, 10));
    adapter.send('alice', { id: session.id, message: 'hello' });
    for (
      let i = 0;
      i < 100 &&
      !adapter.poll('alice', { id: session.id }).events.some((e) => e.type === 'message');
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(
      adapter.poll('alice', { id: session.id }).events.some((e) => e.data.text === 'hello'),
    );
    assert.throws(() => adapter.poll('bob', { id: session.id }), /not found/);
    adapter.disconnect('alice', { id: session.id });
  } finally {
    adapter.close();
    for (const client of server.clients) client.terminate();
    await new Promise((r) => server.close(r));
  }
});
test('gRPC uses a supplied proto and returns a real unary response', async () => {
  const proto =
    'syntax = "proto3"; package fixture; service Echo { rpc Say (Request) returns (Response); } message Request { string name=1; } message Response { string greeting=1; }';
  const directory = await mkdtemp(join(tmpdir(), 'nexo-grpc-test-'));
  const path = join(directory, 'fixture.proto');
  await writeFile(path, proto);
  const definition = grpc.loadPackageDefinition(loader.loadSync(path));
  const server = new grpc.Server();
  server.addService(definition.fixture.Echo.service, {
    Say(call, callback) {
      callback(null, { greeting: `Hello ${call.request.name}` });
    },
  });
  const port = await new Promise((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) =>
      e ? reject(e) : resolve(p),
    ),
  );
  try {
    const result = await grpcRequest('', {
      proto,
      service: 'fixture.Echo',
      method: 'Say',
      url: `127.0.0.1:${port}`,
      message: { name: 'Nexo' },
    });
    assert.equal(result.message.greeting, 'Hello Nexo');
  } finally {
    server.forceShutdown();
    await rm(directory, { recursive: true, force: true });
  }
});
