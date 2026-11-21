// Contract tests for routes: requests and connections that reach their server through an HTTP
// proxy (CONNECT) or a SOCKS5 proxy, with or without a password, the name resolved by the
// proxy, and the egress policy applied to the destination behind the proxy.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { WebSocketServer } from 'ws';
import { fixture, startServer, until } from './server.mjs';
import { socksProxy as relayingProxy } from './socks-fixture.mjs';

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

const socksProxy = (password) => relayingProxy(password, names);

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

test('requests go the way of their nearest folder or collection unless they set their own', async () => {
  const outer = await socksProxy();
  const inner = await socksProxy();
  try {
    const via = (proxy) => ({
      via: 'socks5',
      host: '127.0.0.1',
      port: proxy.port,
      remoteDns: true,
    });
    const single = await server.execute('request', {
      request: { url: 'http://api.internal/single' },
      context: {
        ancestors: [
          { name: 'API', nexoRoute: via(outer) },
          { name: 'Internal', nexoRoute: via(inner) },
        ],
      },
    });
    assert.equal(single.status, 200);
    assert.deepEqual(inner.asked, ['api.internal:80']);
    assert.deepEqual(outer.asked, []);

    const direct = JSON.stringify({ route: { via: 'direct' } });
    const started = await server.execute('run', {
      collection: {
        nexoRoute: via(outer),
        item: [
          { name: 'root', request: { url: 'http://api.internal/root' } },
          {
            name: 'Folder',
            nexoRoute: via(inner),
            item: [{ name: 'nested', request: { url: 'http://api.internal/nested' } }],
          },
          { name: 'own', request: { url: echo.url }, nexoTransport: direct },
        ],
      },
    });
    const done = await until(async () => {
      const current = await server.execute('run', { action: 'status', id: started.id });
      return current.state !== 'running' && current;
    });
    assert.deepEqual(
      done.results.map((result) => result.status),
      [200, 200, 200],
    );
    assert.deepEqual(outer.asked, ['api.internal:80']);
    assert.deepEqual(inner.asked, ['api.internal:80', 'api.internal:80']);
  } finally {
    outer.close();
    inner.close();
  }
});
