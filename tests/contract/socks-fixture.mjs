// A SOCKS5 proxy for the contract tests of routes (requests, connections and databases).
import net from 'node:net';

/**
 * A SOCKS5 proxy (RFC 1928, 1929) that records what it is asked and relays to 127.0.0.1: to
 * the port `names()` gives a name only it knows, or to the port asked for.
 */
export async function socksProxy(password, names) {
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
