// Contract tests for JWT Bearer and Atlassian ASAP tokens, against servers that verify them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, constants, generateKeyPairSync, verify } from 'node:crypto';
import { fixture } from './server.mjs';
import { server, hash, send } from './auth-fixture.mjs';

function jwtVerifier(keys) {
  const hashOf = (algorithm) => `sha${algorithm.slice(2)}`;
  return (request, body, response) => {
    const url = new URL(request.url, 'http://verifier');
    const authorization = request.headers.authorization ?? '';
    const token = url.searchParams.get('access_token') ?? authorization.replace(/^Bearer /, '');
    const [header64, payload64, signature64] = token.split('.');
    const header = JSON.parse(Buffer.from(header64, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(payload64, 'base64url').toString());
    const input = Buffer.from(`${header64}.${payload64}`);
    const signature = Buffer.from(signature64, 'base64url');
    const { alg } = header;
    const hash = hashOf(alg);
    let ok;
    if (alg.startsWith('HS')) {
      ok = createHmac(hash, keys.secret).update(input).digest().equals(signature);
    } else if (alg.startsWith('RS')) {
      ok = verify(hash, input, keys.rsa, signature);
    } else if (alg.startsWith('PS')) {
      ok = verify(
        hash,
        input,
        {
          key: keys.rsa,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: Number(alg.slice(2)) / 8,
        },
        signature,
      );
    } else {
      ok = verify(hash, input, { key: keys[alg], dsaEncoding: 'ieee-p1363' }, signature);
    }
    response.statusCode = ok ? 200 : 401;
    response.end(
      JSON.stringify({
        ok,
        header,
        payload,
        where: url.searchParams.has('access_token') ? 'query' : 'header',
      }),
    );
  };
}

test('JWT Bearer tokens of every algorithm verify', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = Object.fromEntries(
    [
      ['ES256', 'prime256v1'],
      ['ES384', 'secp384r1'],
      ['ES512', 'secp521r1'],
    ].map(([alg, namedCurve]) => [alg, generateKeyPairSync('ec', { namedCurve })]),
  );
  const verifier = await fixture(
    jwtVerifier({
      secret: 'jwt-secret',
      rsa: rsa.publicKey,
      ...Object.fromEntries(Object.entries(ec).map(([alg, pair]) => [alg, pair.publicKey])),
    }),
  );
  try {
    const algorithms = [
      'HS256',
      'HS384',
      'HS512',
      'RS256',
      'RS384',
      'RS512',
      'PS256',
      'PS384',
      'PS512',
      'ES256',
      'ES384',
      'ES512',
    ];
    for (const [index, algorithm] of algorithms.entries()) {
      // PKCS#8 keys as Postman takes; PKCS#1 (RSA) and SEC1 (EC) keys every other time.
      const pkcs8 = index % 2 === 0;
      const privateKey = algorithm.startsWith('HS')
        ? ''
        : algorithm.startsWith('ES')
          ? ec[algorithm].privateKey.export({ type: pkcs8 ? 'pkcs8' : 'sec1', format: 'pem' })
          : rsa.privateKey.export({ type: pkcs8 ? 'pkcs8' : 'pkcs1', format: 'pem' });
      const inQuery = algorithm.endsWith('384');
      const result = await server.execute('request', {
        request: {
          url: `${verifier.url}/me`,
          auth: {
            type: 'jwt',
            jwt: [
              { key: 'algorithm', value: algorithm },
              { key: 'secret', value: Buffer.from('jwt-secret').toString('base64') },
              { key: 'isSecretBase64Encoded', value: true },
              { key: 'privateKey', value: privateKey },
              { key: 'payload', value: '{"sub":"{{user}}","admin":true}' },
              { key: 'header', value: '{"kid":"key-1"}' },
              { key: 'addTokenTo', value: inQuery ? 'queryParam' : 'header' },
              { key: 'queryParamKey', value: 'access_token' },
            ],
          },
        },
        variables: [{ key: 'user', value: 'ada', enabled: true }],
      });
      assert.equal(result.status, 200, `${algorithm}: ${result.body}`);
      const answer = JSON.parse(result.body);
      assert.deepEqual(answer.header, { kid: 'key-1', alg: algorithm });
      assert.deepEqual(answer.payload, { sub: 'ada', admin: true });
      assert.equal(answer.where, inQuery ? 'query' : 'header', algorithm);
    }
  } finally {
    await verifier.close();
  }
});

// An ASAP resource server: verifies the token with the issuer's public key and reads its claims.
function asapVerifier(publicKeys) {
  return (request, body, response) => {
    const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
    const [header64, payload64, signature64] = token.split('.');
    const header = JSON.parse(Buffer.from(header64, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(payload64, 'base64url').toString());
    const hash = `sha${header.alg.slice(2)}`;
    const key = publicKeys[header.kid];
    const options = header.alg.startsWith('PS')
      ? {
          key,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: Number(header.alg.slice(2)) / 8,
        }
      : header.alg.startsWith('ES')
        ? { key, dsaEncoding: 'ieee-p1363' }
        : key;
    const ok = verify(
      hash,
      Buffer.from(`${header64}.${payload64}`),
      options,
      Buffer.from(signature64, 'base64url'),
    );
    response.statusCode = ok ? 200 : 401;
    response.end(JSON.stringify({ ok, header, payload }));
  };
}

test('Atlassian ASAP tokens verify and carry fresh claims', async () => {
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const verifier = await fixture(
    asapVerifier({ 'nexo/rsa': rsa.publicKey, 'nexo/ec': ec.publicKey }),
  );
  const asap = (values) => ({
    type: 'asap',
    asap: Object.entries(values).map(([key, value]) => ({ key, value })),
  });
  const ecUri = `data:application/pkcs8;kid=${encodeURIComponent('nexo/ec')};base64,${ec.privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .toString('base64')}`;
  try {
    const seen = new Set();
    for (const [alg, kid, privateKey] of [
      ['RS256', 'nexo/rsa', rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })],
      ['PS384', 'nexo/rsa', rsa.privateKey.export({ type: 'pkcs8', format: 'pem' })],
      ['ES256', 'nexo/ec', ecUri],
      ['ES256', 'nexo/ec', ecUri],
    ]) {
      const result = await server.execute('request', {
        request: {
          url: `${verifier.url}/rest/api`,
          auth: asap({ alg, kid, iss: 'nexo', aud: '{{audience}}', privateKey }),
        },
        variables: [{ key: 'audience', value: 'jira', enabled: true }],
      });
      assert.equal(result.status, 200, `${alg}: ${result.body}`);
      const { header, payload } = JSON.parse(result.body);
      assert.deepEqual(header, { alg, kid });
      assert.equal(payload.iss, 'nexo');
      assert.equal(payload.sub, 'nexo');
      assert.equal(payload.aud, 'jira');
      assert.equal(payload.exp - payload.iat, 3600);
      assert.ok(Math.abs(payload.iat - Date.now() / 1000) < 60, 'issued now');
      assert.match(payload.jti, /^[0-9a-f-]{36}$/);
      assert.ok(!seen.has(payload.jti), 'a new jti on every send');
      seen.add(payload.jti);
    }
  } finally {
    await verifier.close();
  }
});

// An Akamai-like server: recomputes the EG1-HMAC-SHA256 signature for the host it was told to
// expect, the headers to sign and the POST body cut to the maximum size.
