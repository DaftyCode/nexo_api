// Contract tests for OAuth 2.0 grants without a browser and their errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { server, provider, received, details, inheriting } from './oauth2-fixture.mjs';

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
