// Contract tests for vault secrets restricted to allowed domains (Postman's "allowed domains").
// 127.0.0.1 and localhost reach the same fixture under two host names.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, startServer } from './server.mjs';

let server;
let echo;
let other;
const tokenCalls = [];
before(async () => {
  server = await startServer();
  echo = await fixture((request, body, response) => {
    if (request.url.startsWith('/hop')) {
      const status = Number(new URL(request.url, 'http://x').searchParams.get('status') ?? 302);
      response.writeHead(status, { location: `${other}/landed` });
      return response.end();
    }
    if (request.url === '/token') {
      tokenCalls.push({ authorization: request.headers.authorization, body });
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ access_token: 'issued', token_type: 'Bearer' }));
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        path: request.url,
        authorization: request.headers.authorization ?? null,
        token: request.headers['x-token'] ?? null,
      }),
    );
  });
  other = echo.url.replace('127.0.0.1', 'localhost');
});
after(async () => {
  await echo?.close();
  await server?.stop();
});

const send = (url, headers, extra = {}) =>
  server.execute('request', {
    request: {
      url,
      headers: Object.entries(headers).map(([key, value]) => ({ key, value, enabled: true })),
      ...extra,
    },
  });
const allow = (hosts) => server.api('PUT', '/secrets/api', { allowedHosts: hosts });

test('a secret limited to some domains is only sent there, also after redirects', async () => {
  const saved = await server.api('PUT', '/secrets/api', {
    value: 'limited-s3cret',
    allowedHosts: ['127.0.0.1'],
  });
  assert.equal(saved.status, 200);
  const listed = await server.api('GET', '/secrets');
  assert.deepEqual(
    listed.body.secrets.find((secret) => secret.name === 'api'),
    { name: 'api', allowedHosts: ['127.0.0.1'] },
  );

  // An allowed host gets it, redacted in what Nexo shows.
  const allowed = await send(`${echo.url}/ok`, { 'X-Token': '{{vault:api}}' });
  assert.equal(allowed.status, 200);
  assert.equal(JSON.parse(allowed.body).token, '[REDACTED]');

  // Another host does not: the request is not sent and the error names the secret only.
  const denied = await send(`${other}/elsewhere`, { 'X-Token': '{{vault:api}}' });
  assert.equal(denied.status, 0);
  assert.equal(denied.error, 'Secret api cannot be sent to localhost');
  assert.ok(!JSON.stringify(denied).includes('limited-s3cret'));
  // Also when only the URL carries it.
  const inUrl = await send(`${other}/q?key={{vault:api}}`, {});
  assert.equal(inUrl.error, 'Secret api cannot be sent to localhost');

  // A redirect elsewhere would carry a custom header: stopped before following it.
  const redirected = await send(`${echo.url}/hop`, { 'X-Token': '{{vault:api}}' });
  assert.equal(redirected.error, 'Secret api cannot be sent to localhost');
  // Credential headers are dropped on such a redirect, so it is followed without them.
  const credential = await send(`${echo.url}/hop`, { Authorization: 'Bearer {{vault:api}}' });
  assert.equal(credential.status, 200, credential.error);
  assert.equal(JSON.parse(credential.body).path, '/landed');
  assert.equal(JSON.parse(credential.body).authorization, null);
  // A 307 keeps the body, and with it the secret.
  const posted = await send(
    `${echo.url}/hop?status=307`,
    {},
    { method: 'POST', body: { mode: 'raw', raw: 'key={{vault:api}}' } },
  );
  assert.equal(posted.error, 'Secret api cannot be sent to localhost');
});

test('allowed domains change without the value, are validated and can be lifted', async () => {
  await server.api('PUT', '/secrets/api', { value: 'limited-s3cret' });
  assert.equal((await allow(['*.example.com'])).status, 200);
  const denied = await send(`${echo.url}/ok`, { 'X-Token': '{{vault:api}}' });
  assert.equal(denied.error, 'Secret api cannot be sent to 127.0.0.1');

  const invalid = await allow(['https://127.0.0.1/']);
  assert.equal(invalid.status, 400);
  assert.match(invalid.body.error, /without protocol, port or path/);
  assert.equal((await server.api('PUT', '/secrets/api', {})).status, 400);
  assert.equal((await server.api('PUT', '/secrets/missing', { allowedHosts: [] })).status, 400);

  // An empty list allows every domain again; the value was kept all along.
  assert.equal((await allow([])).status, 200);
  const sent = await send(`${other}/ok`, { 'X-Token': '{{vault:api}}' });
  assert.equal(sent.status, 200, sent.error);
  assert.equal(JSON.parse(sent.body).token, '[REDACTED]');
});

test('OAuth 2.0 token requests only take a limited client secret to its domains', async () => {
  await server.api('PUT', '/secrets/client', {
    value: 'client-s3cret',
    allowedHosts: ['127.0.0.1'],
  });
  const tokenRequest = (tokenUrl) =>
    server.execute('oauth2.token', {
      request: {
        url: 'https://api.test/x',
        auth: {
          type: 'oauth2',
          oauth2: [
            { key: 'grant_type', value: 'client_credentials' },
            { key: 'accessTokenUrl', value: tokenUrl },
            { key: 'clientId', value: 'app' },
            { key: 'clientSecret', value: '{{vault:client}}' },
            { key: 'tokenName', value: 'limited' },
          ],
        },
      },
    });
  tokenCalls.length = 0;
  await assert.rejects(tokenRequest(`${other}/token`), /Secret client cannot be sent to localhost/);
  assert.equal(tokenCalls.length, 0, 'nothing was sent');
  const token = await tokenRequest(`${echo.url}/token`);
  assert.ok(token.id);
  assert.equal(tokenCalls.length, 1);
  const basic = Buffer.from(tokenCalls[0].authorization.replace('Basic ', ''), 'base64');
  assert.equal(basic.toString(), 'app:client-s3cret');

  // A browser sign-in is refused before it starts when its code would be exchanged there.
  const signIn = (tokenUrl) =>
    server.execute('oauth2.authorize', {
      openBrowser: false,
      request: {
        url: 'https://api.test/x',
        auth: {
          type: 'oauth2',
          oauth2: [
            { key: 'grant_type', value: 'authorization_code' },
            { key: 'authUrl', value: `${echo.url}/authorize` },
            { key: 'accessTokenUrl', value: tokenUrl },
            { key: 'redirect_uri', value: 'https://oauth.pstmn.io/v1/browser-callback' },
            { key: 'clientId', value: 'app' },
            { key: 'clientSecret', value: '{{vault:client}}' },
          ],
        },
      },
    });
  await assert.rejects(signIn(`${other}/token`), /Secret client cannot be sent to localhost/);
  const started = await signIn(`${echo.url}/token`);
  assert.ok(started.session);
  await server.execute('oauth2.authorize', { action: 'cancel', session: started.session });
});
