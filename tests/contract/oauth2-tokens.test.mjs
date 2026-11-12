// Contract tests for stored, pasted, refreshed and automatically fetched OAuth 2.0 tokens.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  server,
  provider,
  received,
  details,
  inheriting,
  browserSettings,
} from './oauth2-fixture.mjs';

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

test('a pasted token is kept like an obtained one: sent by reference and refreshed', async () => {
  // A JWT that expires in an hour, as a web front keeps it in a cookie.
  const claims = Buffer.from(
    JSON.stringify({ sub: 'ada', exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${claims.toString('base64url')}.signature`;
  const token = await server.execute('oauth2.tokens', {
    action: 'add',
    name: 'FROM-BROWSER',
    accessToken: `Bearer ${jwt}`,
    refreshToken: 'refresh-1',
  });
  assert.equal(token.name, 'FROM-BROWSER');
  assert.equal(token.hasRefreshToken, true);
  assert.ok(Math.abs(token.expiresAt - JSON.parse(claims).exp * 1000) < 1000);
  assert.ok(!JSON.stringify(token).includes(jwt), 'values stay in the vault');
  assert.equal((await details(token.id)).accessToken, jwt);

  const sent = await server.execute('request', {
    request: {
      url: `${provider.url}/echo`,
      auth: {
        type: 'oauth2',
        oauth2: [
          { key: 'accessToken', value: token.reference },
          { key: 'oauth2TokenId', value: token.id },
        ],
      },
    },
  });
  assert.equal(JSON.parse(sent.body).authorization, 'Bearer [REDACTED]');

  // Its refresh token renews it at the authorization's token endpoint.
  received.length = 0;
  const settings = [
    { key: 'grant_type', value: 'authorization_code' },
    { key: 'accessTokenUrl', value: '{{tokenUrl}}' },
    { key: 'clientId', value: 'app' },
  ];
  const renewed = await server.execute('oauth2.token', inheriting(settings, { tokenId: token.id }));
  assert.equal(renewed.id, token.id);
  assert.equal(received[0].form.refresh_token, 'refresh-1');
  assert.equal((await details(token.id)).accessToken, 'renewed-token');

  await assert.rejects(
    server.execute('oauth2.tokens', { action: 'add', name: 'EMPTY', refreshToken: 'r' }),
    /Paste the access token/,
  );
  await server.execute('oauth2.tokens', { action: 'delete', id: token.id });
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

test('Auto-fetch token gets a token once, reuses it by name, and scripts can only reset it', async () => {
  const settings = (extra = []) => [
    { key: 'grant_type', value: 'client_credentials' },
    { key: 'accessTokenUrl', value: '{{tokenUrl}}' },
    { key: 'tokenName', value: 'AUTO' },
    ...extra,
  ];
  const send = (auth, prerequest) =>
    server.execute('request', {
      request: {
        url: `${provider.url}/echo`,
        auth: { type: 'inherit' },
        ...(prerequest ? { prerequest } : {}),
      },
      variables: [{ key: 'tokenUrl', value: `${provider.url}/token`, enabled: true }],
      context: { ancestors: [{ name: 'API', auth: { type: 'oauth2', oauth2: auth } }] },
    });
  const named = async () =>
    (await server.execute('oauth2.tokens', { action: 'list' })).tokens.filter(
      (token) => token.name === 'AUTO',
    );
  const tokenRequests = () => received.filter((entry) => entry.url === '/token').length;

  // No token yet: one is obtained, stored under its name and sent (redacted in the result).
  received.length = 0;
  const first = await send(settings([{ key: 'autoFetchToken', value: true }]));
  assert.equal(JSON.parse(first.body).authorization, 'Bearer [REDACTED]');
  assert.equal(tokenRequests(), 1);
  assert.equal((await named()).length, 1);

  // The next send reuses it.
  await send(settings([{ key: 'autoFetchToken', value: true }]));
  assert.equal(tokenRequests(), 1);

  // A script resets it (it cannot read it): the next send gets a new one.
  const reset = await send(
    settings([{ key: 'autoFetchToken', value: true }]),
    "nx.oauth2.reset('AUTO'); nx.test('no token API', () => nx.expect(nx.oauth2.token).to.equal(undefined));",
  );
  assert.ok(
    reset.assertions.every((assertion) => assertion.passed),
    JSON.stringify(reset.assertions),
  );
  assert.equal((await named()).length, 0);
  await send(settings([{ key: 'autoFetchToken', value: true }]));
  assert.equal(tokenRequests(), 2);
  const [current] = await named();

  // Without Auto-fetch, a deleted token is not sent (no error, no reference in the header).
  await server.execute('oauth2.tokens', { action: 'delete', id: current.id });
  const without = await send(
    settings([
      { key: 'accessToken', value: current.reference },
      { key: 'oauth2TokenId', value: current.id },
    ]),
  );
  assert.equal(without.status, 200);
  assert.equal(JSON.parse(without.body).authorization, null);
  assert.equal(tokenRequests(), 2);

  // Browser grants are signed in by the interface: the engine sends without a token.
  const browser = await send([
    ...browserSettings([{ key: 'tokenName', value: 'AUTO-BROWSER' }]),
    { key: 'autoFetchToken', value: true },
  ]);
  assert.equal(JSON.parse(browser.body).authorization, null);
  assert.equal(tokenRequests(), 2);
});
