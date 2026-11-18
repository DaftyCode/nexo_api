// Contract tests for routes: requests and connections that reach their server through an HTTP
// proxy (CONNECT) or a SOCKS5 proxy, with or without a password, the name resolved by the
// proxy, and the egress policy applied to the destination behind the proxy.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { fixture, startServer, until } from './server.mjs';

let server;
let echo;
let sockets;
before(async () => {
  server = await startServer();
  echo = await fixture((request, body, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ path: request.url, host: request.headers.host }));
  });
  sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  sockets.on('connection', (socket) => socket.on('message', (m) => socket.send(`echo:${m}`)));
  await new Promise((r) => sockets.once('listening', r));
});
after(async () => {
  await echo?.close();
  await new Promise((r) => sockets?.close(r));
  await server?.stop();
});

/** Where the names the proxies are asked for really are. */
const names = () => ({
  'api.internal': Number(new URL(echo.url).port),
  'ws.internal': sockets.address().port,
});

/** A SOCKS5 proxy (RFC 1928, 1929) that records what it is asked and relays to 127.0.0.1. */
async function socksProxy(password) {
  const asked = [];
  const proxy = net.createServer((client) => {
    let stage = 'greeting';
    let buffer = Buffer.alloc(0);
    client.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'greeting' && buffer.length >= 2 && buffer.length >= 2 + buffer[1]) {
        buffer = buffer.subarray(2 + buffer[1]);
        stage = password ? 'auth' : 'request';
        client.write(Buffer.from([5, password ? 2 : 0]));
      }
      if (stage === 'auth' && buffer.length >= 2 && buffer.length >= 3 + buffer[1]) {
        const user = buffer.subarray(2, 2 + buffer[1]).toString();
        const length = buffer[2 + buffer[1]];
        if (buffer.length < 3 + buffer[1] + length) return;
        const pass = buffer.subarray(3 + buffer[1], 3 + buffer[1] + length).toString();
        buffer = buffer.subarray(3 + buffer[1] + length);
        asked.push(`user ${user}`);
        const ok = pass === password;
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return client.end();
        stage = 'request';
      }
      if (stage === 'request' && buffer.length >= 7) {
        let host;
        let end;
        if (buffer[3] === 3) {
          end = 5 + buffer[4];
          host = buffer.subarray(5, end).toString();
        } else {
          end = 8;
          host = [...buffer.subarray(4, 8)].join('.');
        }
        if (buffer.length < end + 2) return;
        const port = buffer.readUInt16BE(end);
        asked.push(`${host}:${port}`);
        const rest = buffer.subarray(end + 2);
        stage = 'relay';
        const upstream = net.connect(names()[host] ?? port, '127.0.0.1', () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          if (rest.length) upstream.write(rest);
          client.pipe(upstream).pipe(client);
        });
        upstream.on('error', () => client.destroy());
      }
    });
    client.on('error', () => {});
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return { port: proxy.address().port, asked, close: () => proxy.close() };
}

/** An HTTP proxy that only opens tunnels with CONNECT, recording the authority asked for. */
async function connectProxy() {
  const asked = [];
  const proxy = net.createServer((client) => {
    let head = '';
    const read = (chunk) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', read);
      const authority = head.split(' ')[1];
      asked.push(head.split('\r\n')[0]);
      const [host, port] = authority.split(':');
      const upstream = net.connect(names()[host] ?? Number(port), '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection established\r\n\r\n');
        client.pipe(upstream).pipe(client);
      });
      upstream.on('error', () => client.destroy());
    };
    client.on('data', read);
    client.on('error', () => {});
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  return { port: proxy.address().port, asked, close: () => proxy.close() };
}

const send = (url, route) =>
  server.execute('request', { request: { url, transport: JSON.stringify({ route }) } });

test('a request reaches a name only the SOCKS5 proxy knows, with and without a password', async () => {
  const open = await socksProxy();
  const signed = await socksProxy('pw');
  try {
    const route = { via: 'socks5', host: '127.0.0.1', port: open.port, remoteDns: true };
    const answer = await send('http://api.internal/orders?page=2', route);
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.body), { path: '/orders?page=2', host: 'api.internal' });
    assert.deepEqual(open.asked, ['api.internal:80']);

    const withPassword = { ...route, port: signed.port, username: 'ada', password: 'pw' };
    assert.equal((await send('http://api.internal/', withPassword)).status, 200);
    assert.deepEqual(signed.asked, ['user ada', 'api.internal:80']);
    const refused = await send('http://api.internal/', { ...withPassword, password: 'wrong' });
    assert.equal(refused.status, 0);
    assert.match(refused.error, /proxy|SOCKS/i);
  } finally {
    open.close();
    signed.close();
  }
});

test('a WebSocket opens through an HTTP proxy with CONNECT and through SOCKS5', async () => {
  const http = await connectProxy();
  const socks = await socksProxy();
  try {
    for (const route of [
      { via: 'http', host: '127.0.0.1', port: http.port },
      { via: 'socks5', host: '127.0.0.1', port: socks.port, remoteDns: true },
    ]) {
      const { id } = await server.execute('realtime.connect', {
        protocol: 'websocket',
        url: 'ws://ws.internal/live',
        route,
      });
      await until(
        async () => (await server.execute('realtime.poll', { id })).state === 'connected',
      );
      await server.execute('realtime.send', { id, message: 'hello' });
      const polled = await until(async () => {
        const events = await server.execute('realtime.poll', { id });
        return events.events.some((e) => e.data?.text === 'echo:hello') && events;
      });
      assert.ok(polled);
      await server.execute('realtime.close', { id });
    }
    assert.deepEqual(http.asked, ['CONNECT ws.internal:80 HTTP/1.1']);
    assert.deepEqual(socks.asked, ['ws.internal:80']);
  } finally {
    http.close();
    socks.close();
  }
});

test('the egress policy refuses a private destination behind a proxy', async () => {
  const strict = await startServer({ NEXO_EGRESS: 'deny-private', NEXO_EGRESS_ALLOW: '127.0.0.1' });
  try {
    const route = { via: 'socks5', host: '127.0.0.1', port: 1080, remoteDns: true };
    const ask = (url) =>
      strict.execute('request', { request: { url, transport: JSON.stringify({ route }) } });
    const privateOne = await ask('http://192.168.10.20/');
    assert.equal(privateOne.status, 0);
    assert.match(privateOne.error, /blocked by the egress policy/);
    const unknown = await ask('http://api.invalid/');
    assert.equal(unknown.status, 0);
    assert.match(unknown.error, /cannot be checked against the egress policy/);
  } finally {
    await strict.stop();
  }
});
