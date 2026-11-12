// Shared setup of the HTTP contract tests: the server and an echo server, started once per
// test file.
import { after, before } from 'node:test';
import { fixture, startServer } from './server.mjs';

export let server;
export let echo;
before(async () => {
  server = await startServer();
  echo = await fixture((request, body, response) => {
    if (request.url === '/image') {
      response.setHeader('content-type', 'image/png');
      return response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    }
    if (request.url === '/latin1') {
      response.setHeader('content-type', 'text/plain; charset=iso-8859-1');
      return response.end(Buffer.from(`Espa\xf1a ${request.headers['x-a']}`, 'latin1'));
    }
    if (request.url === '/login') response.setHeader('set-cookie', 'session=abc; Path=/');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        path: request.url,
        method: request.method,
        authorization: request.headers.authorization ?? null,
        token: request.headers['x-token'] ?? null,
        cookie: request.headers.cookie ?? null,
        body,
      }),
    );
  });
});
after(async () => {
  await echo?.close();
  await server?.stop();
});
export const rows = (values) => Object.fromEntries(values.map((row) => [row.key, row.value]));
