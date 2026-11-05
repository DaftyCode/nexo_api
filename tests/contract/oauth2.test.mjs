// Contract tests for OAuth 2.0 token requests ("Get New Access Token" and refresh).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import net from 'node:net';
import { fixture, startServer } from './server.mjs';

const freePort = () =>
  new Promise((done) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });
/** Follows the provider's redirect, as the browser would, and returns where it led. */
async function signIn(authorizationUrl) {
  const answer = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(answer.status, 302);
  return answer.headers.get('location');
}
/** Polls a sign-in until it finishes. */
async function finished(session) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const status = await server.execute('oauth2.authorize', { action: 'status', session });
    if (status.state !== 'waiting') return status;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('The sign-in did not finish');
}

let server;
let provider;
const received = [];
/** Authorization requests the provider received, by the code it issued. */
const issued = new Map();
const challengeOf = (verifier) => createHash('sha256').update(verifier).digest('base64url');
before(async () => {
  server = await startServer();
  // A provider that records what it receives and answers like a real one: it signs in at
  // /authorize (redirecting back with a code, or a token for the implicit grant) and checks
  // the PKCE verifier when the code is exchanged at the token endpoint.
  provider = await fixture((request, body, response) => {
    const address = new URL(request.url, 'http://provider');
    if (address.pathname === '/echo') {
      response.setHeader('content-type', 'application/json');
      return response.end(JSON.stringify({ authorization: request.headers.authorization ?? null }));
    }
    if (address.pathname === '/authorize') {
      const query = Object.fromEntries(address.searchParams);
      const back = new URL(query.redirect_uri);
      if (query.response_type === 'token') {
        back.hash = new URLSearchParams({
          access_token: 'implicit-token',
          token_type: 'Bearer',
          state: query.state,
        }).toString();
      } else {
        const code = `code-${issued.size + 1}`;
        issued.set(code, query);
        back.search = new URLSearchParams({ code, state: query.state }).toString();
      }
      response.writeHead(302, { location: back.toString() });
      return response.end();
    }
    const form = Object.fromEntries(new URLSearchParams(body));
    received.push({ url: request.url, headers: request.headers, form });
    response.setHeader('content-type', 'application/json');
    if (form.grant_type === 'authorization_code') {
      const authorized = issued.get(form.code);
      const verified =
        authorized?.code_challenge_method === 'S256'
          ? challengeOf(form.code_verifier ?? '') === authorized.code_challenge
          : !authorized?.code_challenge || form.code_verifier === authorized.code_challenge;
      if (!authorized || !verified || form.redirect_uri !== authorized.redirect_uri) {
        response.statusCode = 400;
        return response.end(JSON.stringify({ error: 'invalid_grant' }));
      }
      return response.end(JSON.stringify({ access_token: 'code-token', expires_in: 60 }));
    }
    if (form.client_secret === 'wrong') {
      response.statusCode = 401;
      return response.end(
        JSON.stringify({
          error: 'invalid_client',
          error_description: 'Client authentication failed',
        }),
      );
    }
    response.end(
      JSON.stringify({
        access_token: form.grant_type === 'refresh_token' ? 'renewed-token' : 'new-token',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        // A scope of "short" gets a token that expires within a minute.
        expires_in: form.scope === 'short' ? 30 : 300,
      }),
    );
  });
});
after(async () => {
  await provider?.close();
  await server?.stop();
});

const details = (id) => server.execute('oauth2.tokens', { action: 'details', id });

/** A request that inherits the collection's OAuth 2.0 settings, as in a Postman export. */
const inheriting = (settings, extra = {}) => ({
  request: { url: 'https://api.test/x', auth: { type: 'inherit' } },
  variables: [{ key: 'tokenUrl', value: `${provider.url}/token`, enabled: true }],
  context: {
    ancestors: [
      {
        name: 'API',
        variable: [{ key: 'clientId', value: 'collection-client' }],
        auth: { type: 'oauth2', oauth2: settings },
      },
    ],
  },
  ...extra,
});

test('client credentials resolve variables and vault secrets and use a Basic header', async () => {
  assert.equal(
    (await server.api('PUT', '/secrets/client_secret', { value: 'vault-secret' })).status,
    200,
  );
  received.length = 0;
  const token = await server.execute(
    'oauth2.token',
    inheriting([
      { key: 'grant_type', value: 'client_credentials' },
      { key: 'accessTokenUrl', value: '{{tokenUrl}}' },
      { key: 'clientId', value: '{{clientId}}' },
      { key: 'clientSecret', value: '{{vault:client_secret}}' },
      { key: 'scope', value: 'read' },
      {
        key: 'tokenRequestParams',
        value: [{ key: 'tenant', value: 'acme', enabled: true, send_as: 'request_url' }],
      },
    ]),
  );
  assert.ok(token.id);
  assert.equal(token.hasRefreshToken, true);
  assert.ok(!JSON.stringify(token).includes('new-token'), 'token values stay in the vault');
  assert.equal((await details(token.id)).accessToken, 'new-token');
  assert.ok(token.expiresAt > Date.now());
  const [call] = received;
  assert.equal(call.url, '/token?tenant=acme');
  assert.deepEqual(call.form, { grant_type: 'client_credentials', scope: 'read' });
  const basic = Buffer.from(call.headers.authorization.replace('Basic ', ''), 'base64');
  assert.equal(basic.toString(), 'collection-client:vault-secret');
});

test('password credentials can send the client in the body, and tokens refresh', async () => {
  const settings = [
    { key: 'grant_type', value: 'password_credentials' },
    { key: 'accessTokenUrl', value: '{{tokenUrl}}' },
    { key: 'username', value: 'ada' },
    { key: 'password', value: 'pw' },
    { key: 'clientId', value: 'app' },
    { key: 'clientSecret', value: 'body-secret' },
    { key: 'client_authentication', value: 'body' },
  ];
  received.length = 0;
  const token = await server.execute('oauth2.token', inheriting(settings));
  assert.equal((await details(token.id)).accessToken, 'new-token');
  assert.deepEqual(received[0].form, {
    grant_type: 'password',
    username: 'ada',
    password: 'pw',
    client_id: 'app',
    client_secret: 'body-secret',
  });
  assert.equal(received[0].headers.authorization, undefined);

  const renewed = await server.execute('oauth2.token', inheriting(settings, { tokenId: token.id }));
  assert.equal(renewed.id, token.id);
  assert.equal((await details(token.id)).accessToken, 'renewed-token');
  assert.equal(received[1].form.grant_type, 'refresh_token');
  assert.equal(received[1].form.refresh_token, 'refresh-1');
});

test('provider errors and browser grants are reported clearly', async () => {
  await assert.rejects(
    server.execute(
      'oauth2.token',
      inheriting([
        { key: 'grant_type', value: 'client_credentials' },
        { key: 'accessTokenUrl', value: '{{tokenUrl}}' },
        { key: 'clientId', value: 'app' },
        { key: 'clientSecret', value: 'wrong' },
        { key: 'client_authentication', value: 'body' },
      ]),
    ),
    /invalid_client.*Client authentication failed/,
  );
  await assert.rejects(
    server.execute(
      'oauth2.token',
      inheriting([{ key: 'grant_type', value: 'authorization_code_with_pkce' }]),
    ),
    /browser/,
  );
});

const browserSettings = (extra) => [
  { key: 'authUrl', value: `${provider.url}/authorize` },
  { key: 'accessTokenUrl', value: `${provider.url}/token` },
  { key: 'clientId', value: 'app' },
  { key: 'scope', value: 'openid' },
  { key: 'client_authentication', value: 'body' },
  ...extra,
];

test('loopback: PKCE sign-in returns to a local Callback URL that Nexo listens on', async () => {
  const port = await freePort();
  const callback = `http://127.0.0.1:${port}/cb`;
  const started = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'authorization_code_with_pkce' },
        { key: 'redirect_uri', value: callback },
      ]),
    ),
  );
  assert.equal(started.mode, 'loopback');
  assert.equal(started.redirectUri, callback);
  assert.equal(started.opened, false);
  const authorization = new URL(started.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.get('client_id'), 'app');

  // Only the callback path with this sign-in's state is accepted.
  assert.equal((await fetch(`http://127.0.0.1:${port}/other?code=x`)).status, 404);
  assert.equal((await fetch(`${callback}?code=x&state=forged`)).status, 400);
  assert.equal(
    (await server.execute('oauth2.authorize', { action: 'status', session: started.session }))
      .state,
    'waiting',
  );

  const back = await signIn(started.authorizationUrl);
  const page = await fetch(back);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /You can close this tab/);
  const result = await finished(started.session);
  assert.equal(result.state, 'done');
  assert.equal((await details(result.token.id)).accessToken, 'code-token');
  const exchange = received.at(-1).form;
  assert.equal(exchange.grant_type, 'authorization_code');
  assert.equal(exchange.client_id, 'app');
  assert.ok(exchange.code_verifier.length >= 43);
  // The listener is closed afterwards.
  await assert.rejects(fetch(callback));
});

test('relay: "Authorize using browser" goes through Nexo callback page to a one-time port', async () => {
  const started = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'authorization_code' },
        { key: 'useBrowser', value: true },
      ]),
    ),
  );
  assert.equal(started.mode, 'relay');
  assert.equal(started.redirectUri, 'https://relay.nexo.test/oauth/callback');
  const back = new URL(await signIn(started.authorizationUrl));
  assert.equal(back.origin + back.pathname, started.redirectUri);
  // What the callback page does: forward the answer to the port at the end of `state`.
  const port = back.searchParams.get('state').split('.').at(-1);
  const page = await fetch(`http://127.0.0.1:${port}/callback${back.search}`);
  assert.equal(page.status, 200);
  const result = await finished(started.session);
  assert.equal((await details(result.token.id)).accessToken, 'code-token');
});

test('manual: the implicit grant completes with the pasted address, also with Postman URL', async () => {
  const started = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'implicit' },
        { key: 'redirect_uri', value: 'https://oauth.pstmn.io/v1/browser-callback' },
      ]),
    ),
  );
  assert.equal(started.mode, 'manual');
  const back = await signIn(started.authorizationUrl);
  assert.match(back, /#access_token=implicit-token/);
  const result = await server.execute('oauth2.authorize', {
    action: 'complete',
    session: started.session,
    url: back,
  });
  assert.equal(result.state, 'done');
  assert.equal((await details(result.token.id)).accessToken, 'implicit-token');
});

test('cancelled and refused sign-ins are reported', async () => {
  const started = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'authorization_code' },
        { key: 'redirect_uri', value: 'https://app.test/back' },
      ]),
    ),
  );
  const state = new URL(started.authorizationUrl).searchParams.get('state');
  const refused = await server.execute('oauth2.authorize', {
    action: 'complete',
    session: started.session,
    url: `https://app.test/back?error=access_denied&error_description=Denied&state=${state}`,
  });
  assert.equal(refused.state, 'error');
  assert.match(refused.error, /access_denied/);

  const other = await server.execute(
    'oauth2.authorize',
    inheriting(
      browserSettings([
        { key: 'grant_type', value: 'authorization_code' },
        { key: 'redirect_uri', value: 'https://app.test/back' },
      ]),
    ),
  );
  assert.deepEqual(
    await server.execute('oauth2.authorize', { action: 'cancel', session: other.session }),
    { state: 'cancelled' },
  );
  await assert.rejects(
    server.execute('oauth2.authorize', { action: 'status', session: other.session }),
    /no longer in progress/,
  );
});

test('stored tokens are listed, used by reference, protected and deleted', async () => {
  const token = await server.execute(
    'oauth2.token',
    inheriting([
      { key: 'grant_type', value: 'client_credentials' },
      { key: 'accessTokenUrl', value: '{{tokenUrl}}' },
      { key: 'tokenName', value: 'GOOD' },
    ]),
  );
  const { tokens } = await server.execute('oauth2.tokens', { action: 'list' });
  const listed = tokens.find((entry) => entry.id === token.id);
  assert.equal(listed.name, 'GOOD');
  assert.ok(!JSON.stringify(tokens).includes('new-token'));

  // A request uses the token through its vault reference; the value is redacted.
  const sent = await server.execute('request', {
    request: {
      url: `${provider.url}/echo`,
      auth: {
        type: 'oauth2',
        oauth2: [
          { key: 'accessToken', value: listed.reference },
          { key: 'oauth2TokenId', value: token.id },
        ],
      },
    },
  });
  assert.equal(JSON.parse(sent.body).authorization, 'Bearer [REDACTED]');
  assert.ok(!JSON.stringify(sent).includes('new-token'));

  // The token entries are hidden from the secrets list and cannot be changed there.
  const { names } = (await server.api('GET', '/secrets')).body;
  assert.ok(!names.some((name) => name.startsWith('nexo-oauth2')));
  assert.notEqual(
    (await server.api('PUT', `/secrets/nexo-oauth2:${token.id}`, { value: 'forged' })).status,
    200,
  );
  // The details, with the refresh token, cannot be referenced from a request.
  await assert.rejects(
    server.execute('request', {
      request: {
        url: `${provider.url}/echo`,
        headers: [{ key: 'X', value: `{{vault:nexo-oauth2-details:${token.id}}}`, enabled: true }],
      },
    }),
  );

  await server.execute('oauth2.tokens', { action: 'delete', id: token.id });
  const after = await server.execute('oauth2.tokens', { action: 'list' });
  assert.ok(!after.tokens.some((entry) => entry.id === token.id));
});

test('tokens about to expire are refreshed before sending, and $oauth2 variables resolve', async () => {
  const settings = [
    { key: 'grant_type', value: 'client_credentials' },
    { key: 'accessTokenUrl', value: '{{tokenUrl}}' },
    { key: 'scope', value: 'short' },
    { key: 'tokenName', value: 'SHORT' },
  ];
  const token = await server.execute('oauth2.token', inheriting(settings));
  assert.ok(token.expiresAt - Date.now() < 60_000);
  received.length = 0;
  const sent = await server.execute('request', {
    request: {
      url: `${provider.url}/echo`,
      headers: [{ key: 'X-Name', value: '{{$oauth2.SHORT.access_token}}', enabled: true }],
      auth: { type: 'inherit' },
    },
    variables: [{ key: 'tokenUrl', value: `${provider.url}/token`, enabled: true }],
    context: {
      ancestors: [
        {
          name: 'API',
          auth: {
            type: 'oauth2',
            oauth2: [
              ...settings,
              { key: 'accessToken', value: token.reference },
              { key: 'oauth2TokenId', value: token.id },
            ],
          },
        },
      ],
    },
  });
  assert.equal(received.at(-1).form.grant_type, 'refresh_token');
  assert.equal((await details(token.id)).accessToken, 'renewed-token');
  assert.equal(JSON.parse(sent.body).authorization, 'Bearer [REDACTED]');
  assert.ok(!JSON.stringify(sent).includes('renewed-token'));
});
