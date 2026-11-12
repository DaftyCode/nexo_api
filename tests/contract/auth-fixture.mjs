// Shared setup of the authorization contract tests: the server, a Digest server and an echo
// server, started once per test file.
import { after, before } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { fixture, startServer } from './server.mjs';

export let server;
export let digest;
export let echo;
export const USER = 'Mufasa';
export const PASSWORD = 'Circle Of Life';
export const REALM = 'nexo@test';

export const hash = (algorithm, text) =>
  createHash(algorithm === 'SHA-256' ? 'sha256' : 'md5')
    .update(text)
    .digest('hex');
export function fields(header) {
  return Object.fromEntries(
    [...header.matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] ?? m[3]]),
  );
}

before(async () => {
  server = await startServer();
  // A Digest server: challenges with the algorithm and qop in the path, then verifies.
  digest = await fixture((request, body, response) => {
    const url = new URL(request.url, 'http://digest');
    const algorithm = url.searchParams.get('algorithm') ?? 'MD5';
    const qop = url.searchParams.get('qop') ?? 'auth';
    const status = Number(url.searchParams.get('status') ?? 401);
    const header = request.headers.authorization ?? '';
    if (!header.startsWith('Digest ')) {
      const nonce = randomBytes(8).toString('hex');
      response.statusCode = status;
      // Several challenges, as servers that offer more than one algorithm send.
      response.setHeader('www-authenticate', [
        `Digest realm="${REALM}", qop="${qop}", nonce="${nonce}", opaque="op"`,
        `Digest realm="${REALM}", qop="${qop}", nonce="${nonce}", opaque="op", algorithm=SHA-256`,
      ]);
      return response.end('challenge');
    }
    const f = fields(header);
    const ha1 = hash(algorithm, `${f.username}:${f.realm}:${PASSWORD}`);
    const a2 =
      f.qop === 'auth-int'
        ? `${request.method}:${f.uri}:${hash(algorithm, body)}`
        : `${request.method}:${f.uri}`;
    const expected = hash(
      algorithm,
      `${ha1}:${f.nonce}:${f.nc}:${f.cnonce}:${f.qop}:${hash(algorithm, a2)}`,
    );
    const ok = f.response === expected && f.opaque === 'op' && f.uri === url.pathname + url.search;
    response.statusCode = ok ? 200 : 403;
    response.end(ok ? 'welcome' : 'bad digest');
  });
  echo = await fixture((request, body, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ url: request.url, authorization: request.headers.authorization ?? null }),
    );
  });
});
after(async () => {
  await digest?.close();
  await echo?.close();
  await server?.stop();
});

export const digestAuth = (extra = []) => ({
  type: 'digest',
  digest: [{ key: 'username', value: USER }, { key: 'password', value: PASSWORD }, ...extra],
});
export const send = (url, auth, extra = {}) =>
  server.execute('request', { request: { url, auth, ...extra } });
