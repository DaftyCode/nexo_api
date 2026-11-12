// Contract tests for Digest, Basic, Bearer and API key authorization.
import test from 'node:test';
import assert from 'node:assert/strict';
import { server, digest, echo, REALM, digestAuth, send } from './auth-fixture.mjs';

test('digest answers the challenge with MD5, SHA-256 and auth-int', async () => {
  for (const query of ['', '?algorithm=SHA-256', '?qop=auth-int', '?status=403']) {
    const algorithm = query.includes('SHA-256') ? [{ key: 'algorithm', value: 'SHA-256' }] : [];
    const result = await send(`${digest.url}/secret${query}`, digestAuth(algorithm), {
      method: 'POST',
      body: 'payload',
    });
    assert.equal(result.status, 200, `${query}: ${result.body}`);
    assert.equal(result.body, 'welcome');
  }
});

test('digest can skip the retry, and signs up front with a known realm', async () => {
  const skipped = await send(
    `${digest.url}/secret`,
    digestAuth([{ key: 'disableRetryRequest', value: true }]),
  );
  assert.equal(skipped.status, 401);
  // With realm and nonce typed in, the first request is already signed (and this server
  // rejects it, because it did not issue that nonce).
  const upFront = await send(
    `${digest.url}/secret`,
    digestAuth([
      { key: 'realm', value: REALM },
      { key: 'nonce', value: 'made-up' },
    ]),
  );
  assert.equal(upFront.status, 403);
});

test('basic, bearer and API key options from Insomnia and Bruno', async () => {
  const latin1 = await send(echo.url, {
    type: 'basic',
    basic: [
      { key: 'username', value: 'José' },
      { key: 'password', value: 'pw' },
      { key: 'useISO88591', value: true },
    ],
  });
  assert.equal(
    JSON.parse(latin1.body).authorization,
    `Basic ${Buffer.from('José:pw', 'latin1').toString('base64')}`,
  );
  const prefixed = await send(echo.url, {
    type: 'bearer',
    bearer: [
      { key: 'token', value: 't' },
      { key: 'prefix', value: 'JWT' },
    ],
  });
  assert.equal(JSON.parse(prefixed.body).authorization, 'JWT t');
  const query = await send(`${echo.url}/a?api_key=old`, {
    type: 'apikey',
    apikey: [
      { key: 'key', value: 'api_key' },
      { key: 'value', value: 'new' },
      { key: 'in', value: 'query' },
    ],
  });
  assert.equal(JSON.parse(query.body).url, '/a?api_key=new');
});

// An OAuth 1.0 server that recomputes the signature (RFC 5849) and verifies it.
