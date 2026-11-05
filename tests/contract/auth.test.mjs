// Contract tests for request authorization types, against servers that check them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,
  createHmac,
  createVerify,
  constants,
  generateKeyPairSync,
  randomBytes,
  verify,
} from 'node:crypto';
import { fixture, startServer } from './server.mjs';

let server;
let digest;
let echo;
const USER = 'Mufasa';
const PASSWORD = 'Circle Of Life';
const REALM = 'nexo@test';

const hash = (algorithm, text) =>
  createHash(algorithm === 'SHA-256' ? 'sha256' : 'md5')
    .update(text)
    .digest('hex');
function fields(header) {
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

const digestAuth = (extra = []) => ({
  type: 'digest',
  digest: [{ key: 'username', value: USER }, { key: 'password', value: PASSWORD }, ...extra],
});
const send = (url, auth, extra = {}) =>
  server.execute('request', { request: { url, auth, ...extra } });

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
const enc = (value) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
function oauth1Verifier(secrets) {
  return (request, body, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const params = [...url.searchParams];
    const header = request.headers.authorization ?? '';
    if (header.startsWith('OAuth ')) {
      for (const [, key, value] of header.matchAll(/(\w+)="([^"]*)"/g))
        if (key !== 'realm') params.push([decodeURIComponent(key), decodeURIComponent(value)]);
    }
    if ((request.headers['content-type'] ?? '').includes('x-www-form-urlencoded'))
      params.push(...new URLSearchParams(body));
    const map = Object.fromEntries(params);
    const normalized = params
      .filter(([key]) => key !== 'oauth_signature')
      .map(([k, v]) => [enc(k), enc(v)])
      .sort((a, b) => (`${a[0]} ${a[1]}` < `${b[0]} ${b[1]}` ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const base = [request.method, `http://${request.headers.host}${url.pathname}`, normalized]
      .map(enc)
      .join('&');
    const method = map.oauth_signature_method;
    let ok;
    if (method.startsWith('HMAC')) {
      const key = `${enc(secrets.consumer)}&${enc(secrets.token ?? '')}`;
      const algorithm = method.slice(5).replace('-', '').toLowerCase();
      ok = createHmac(algorithm, key).update(base).digest('base64') === map.oauth_signature;
    } else {
      ok = createVerify(`RSA-${method.slice(4).replace('-', '')}`)
        .update(base)
        .verify(secrets.publicKey, map.oauth_signature, 'base64');
    }
    response.statusCode = ok ? 200 : 401;
    response.end(
      JSON.stringify({ ok, where: header ? 'header' : body.includes('oauth_') ? 'body' : 'query' }),
    );
  };
}

test('OAuth 1.0 signatures are accepted by a verifying server', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' });
  const verifier = await fixture(
    oauth1Verifier({ consumer: 'consumer-secret', token: 'token-secret', publicKey }),
  );
  try {
    const cases = [
      { method: 'HMAC-SHA256', header: true },
      { method: 'HMAC-SHA1', header: false },
      { method: 'HMAC-SHA512', header: false, form: true },
      { method: 'RSA-SHA1', header: true, key: pkcs8 },
      { method: 'RSA-SHA256', header: false, key: pkcs1 },
      { method: 'RSA-SHA512', header: true, key: pkcs8 },
    ];
    for (const { method, header, form, key } of cases) {
      const result = await server.execute('request', {
        request: {
          url: `${verifier.url}/resource?a=1&b=x%20y`,
          method: form ? 'POST' : 'GET',
          ...(form
            ? {
                bodyMode: 'urlencoded',
                form: [{ key: 'status', value: 'Hello + bye!', enabled: true }],
              }
            : {}),
          auth: {
            type: 'oauth1',
            oauth1: [
              { key: 'consumerKey', value: 'consumer' },
              { key: 'consumerSecret', value: 'consumer-secret' },
              { key: 'token', value: 'token' },
              { key: 'tokenSecret', value: 'token-secret' },
              { key: 'signatureMethod', value: method },
              { key: 'privateKey', value: key ?? '' },
              { key: 'version', value: '1.0' },
              { key: 'addParamsToHeader', value: header },
            ],
          },
        },
      });
      const body = JSON.parse(result.body);
      assert.equal(result.status, 200, `${method}: ${result.body}`);
      assert.equal(body.where, header ? 'header' : form ? 'body' : 'query', method);
    }
  } finally {
    await verifier.close();
  }
});

// An AWS server that rebuilds the canonical request (Signature Version 4) and checks it.
function sigv4Verifier(secret) {
  const enc = (value) =>
    encodeURIComponent(value).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  const sha256 = (data) => createHash('sha256').update(data).digest('hex');
  const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
  return (request, body, response) => {
    const url = new URL(request.url, 'http://verifier');
    let params = [...url.searchParams];
    const header = request.headers.authorization ?? '';
    let fieldsOf;
    let date;
    if (header.startsWith('AWS4-HMAC-SHA256 ')) {
      fieldsOf = Object.fromEntries(
        header
          .slice(17)
          .split(', ')
          .map((part) => part.split('=')),
      );
      date = request.headers['x-amz-date'];
    } else {
      const query = Object.fromEntries(params);
      fieldsOf = {
        Credential: query['X-Amz-Credential'],
        SignedHeaders: query['X-Amz-SignedHeaders'],
        Signature: query['X-Amz-Signature'],
      };
      date = query['X-Amz-Date'];
      params = params.filter(([key]) => key !== 'X-Amz-Signature');
    }
    const [, day, region, service] = fieldsOf.Credential.split('/');
    const s3 = service === 's3';
    const path = s3
      ? url.pathname
      : url.pathname
          .split('/')
          .map((segment) => enc(segment))
          .join('/');
    const query = params
      .map(([key, value]) => `${enc(key)}=${enc(value)}`)
      .sort()
      .join('&');
    const headers = fieldsOf.SignedHeaders.split(';')
      .map((name) => `${name}:${String(request.headers[name]).trim().replace(/\s+/g, ' ')}\n`)
      .join('');
    const sent = request.headers['x-amz-content-sha256'];
    const payload = s3 && !header ? 'UNSIGNED-PAYLOAD' : sha256(body);
    const canonical = [request.method, path, query, headers, fieldsOf.SignedHeaders, payload].join(
      '\n',
    );
    const scope = `${day}/${region}/${service}/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256(canonical)].join('\n');
    let key = `AWS4${secret}`;
    for (const part of [day, region, service, 'aws4_request']) key = hmac(key, part);
    const ok =
      createHmac('sha256', key).update(toSign).digest('hex') === fieldsOf.Signature &&
      (sent === undefined || sent === sha256(body));
    response.statusCode = ok ? 200 : 403;
    response.end(
      JSON.stringify({
        ok,
        where: header ? 'header' : 'query',
        scope,
        signed: fieldsOf.SignedHeaders,
        token:
          request.headers['x-amz-security-token'] ?? url.searchParams.get('X-Amz-Security-Token'),
      }),
    );
  };
}

test('AWS Signature v4 is accepted by a verifying server', async () => {
  const verifier = await fixture(sigv4Verifier('aws-secret'));
  try {
    const cases = [
      { service: '', token: 'session', method: 'POST', body: '{"name":"a b"}' },
      { service: 'execute-api', method: 'GET', query: true },
      { service: 's3', method: 'PUT', body: 'object body' },
      { service: 's3', method: 'GET', query: true, token: 'session' },
    ];
    for (const { service, token, method, body, query } of cases) {
      const result = await server.execute('request', {
        request: {
          // Postman's aws4 signs only the first value of a repeated name for S3.
          url: `${verifier.url}/items/a%20b/./c?z=1&a=x%20y${service === 's3' ? '' : '&a=b'}`,
          method,
          headers: [{ key: 'X-Custom', value: '  spaced   value ', enabled: true }],
          ...(body ? { body } : {}),
          auth: {
            type: 'awsv4',
            awsv4: [
              { key: 'accessKey', value: 'AKID' },
              { key: 'secretKey', value: 'aws-secret' },
              { key: 'region', value: 'eu-west-1' },
              { key: 'service', value: service },
              { key: 'sessionToken', value: token ?? '' },
              { key: 'addAuthDataToQuery', value: !!query },
            ],
          },
        },
      });
      const label = `${service || 'default'} ${method}${query ? ' presigned' : ''}`;
      assert.equal(result.status, 200, `${label}: ${result.body}`);
      const answer = JSON.parse(result.body);
      assert.equal(answer.where, query ? 'query' : 'header', label);
      assert.match(
        answer.scope,
        new RegExp(`/eu-west-1/${service || 'execute-api'}/aws4_request$`),
      );
      assert.ok(answer.signed.split(';').includes('x-custom'), label);
      assert.equal(answer.token, token ?? null, label);
    }
  } finally {
    await verifier.close();
  }
});

// A Hawk server: recomputes the MAC (and the payload hash when sent) as the specification says.
function hawkVerifier(key) {
  return (request, body, response) => {
    const header = request.headers.authorization ?? '';
    const attributes = Object.fromEntries(
      [...header.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map(([, name, value]) => [
        name,
        value.replace(/\\(.)/g, '$1'),
      ]),
    );
    const algorithm = attributes.id === 'sha1-id' ? 'sha1' : 'sha256';
    const [host, port] = request.headers.host.split(':');
    const normalized =
      [
        'hawk.1.header',
        attributes.ts,
        attributes.nonce,
        request.method,
        request.url,
        host,
        port,
        attributes.hash ?? '',
        (attributes.ext ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n'),
      ].join('\n') +
      '\n' +
      (attributes.app ? `${attributes.app}\n${attributes.dlg ?? ''}\n` : '');
    const mac = createHmac(algorithm, key).update(normalized).digest('base64');
    const mediaType = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    const payload = createHash(algorithm)
      .update(`hawk.1.payload\n${mediaType}\n${body}\n`)
      .digest('base64');
    const ok =
      header.startsWith('Hawk ') &&
      mac === attributes.mac &&
      (attributes.hash === undefined || attributes.hash === payload);
    response.statusCode = ok ? 200 : 401;
    response.end(
      JSON.stringify({ ok, hashed: attributes.hash !== undefined, app: attributes.app }),
    );
  };
}

test('Hawk requests are accepted by a verifying server', async () => {
  const key = 'werxhqb98rpaxn39848xrunpaw3489ruxnpa98w4rxn';
  const verifier = await fixture(hawkVerifier(key));
  try {
    const cases = [
      { id: 'sha256-id', algorithm: 'sha256', method: 'GET', ext: 'say "hi" \\ there' },
      {
        id: 'sha1-id',
        algorithm: 'sha1',
        method: 'POST',
        body: '{"a":1}',
        payload: true,
        app: 'my-app',
        dlg: 'their-app',
      },
    ];
    for (const { id, algorithm, method, ext, body, payload, app, dlg } of cases) {
      const result = await server.execute('request', {
        request: {
          url: `${verifier.url}/resource/1?b=1&a=x%20y`,
          method,
          headers: [
            { key: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true },
          ],
          ...(body ? { body } : {}),
          auth: {
            type: 'hawk',
            hawk: [
              { key: 'authId', value: id },
              { key: 'authKey', value: key },
              { key: 'algorithm', value: algorithm },
              { key: 'extraData', value: ext ?? '' },
              { key: 'app', value: app ?? '' },
              { key: 'delegation', value: dlg ?? '' },
              { key: 'includePayloadHash', value: !!payload },
            ],
          },
        },
      });
      assert.equal(result.status, 200, `${algorithm}: ${result.body}`);
      const answer = JSON.parse(result.body);
      assert.equal(answer.hashed, !!payload, algorithm);
      assert.equal(answer.app, app, algorithm);
    }
  } finally {
    await verifier.close();
  }
});

// An NTLM server ([MS-NLMP]): asks for NTLM, sends a challenge, and checks the NTLMv2 proof of
// the authenticate message, which must arrive on the same connection as the negotiate message.
// Node has no MD4, so the NT hash of "Password" comes from the [MS-NLMP] examples.
const NT_HASH_OF_PASSWORD = Buffer.from('a4f49c406510bdcab6824ee7c30fd852', 'hex');
function ntlmVerifier({ schemes = ['NTLM'] } = {}) {
  const hmacMd5 = (key, data) => createHmac('md5', key).update(data).digest();
  const serverChallenge = Buffer.from('0123456789abcdef', 'hex');
  const pending = new WeakMap();
  const challenge = () => {
    const name = Buffer.from('NEXO', 'utf16le');
    const info = Buffer.concat([Buffer.from([2, 0, name.length, 0]), name, Buffer.alloc(4)]);
    const header = Buffer.alloc(48);
    header.write('NTLMSSP\0', 0, 'latin1');
    header.writeUInt32LE(2, 8);
    header.writeUInt32LE(0x00888205, 20); // Unicode, NTLM, extended security, target info.
    serverChallenge.copy(header, 24);
    header.writeUInt16LE(info.length, 40);
    header.writeUInt16LE(info.length, 42);
    header.writeUInt32LE(48, 44);
    return `NTLM ${Buffer.concat([header, info]).toString('base64')}`;
  };
  return (request, body, response) => {
    const authorization = request.headers.authorization ?? '';
    const message = authorization.startsWith('NTLM ')
      ? Buffer.from(authorization.slice(5), 'base64')
      : undefined;
    const type = message?.readUInt32LE(8);
    if (!message) {
      response.statusCode = 401;
      response.setHeader('WWW-Authenticate', schemes);
      return response.end('who are you?');
    }
    if (type === 1) {
      pending.set(request.socket, body);
      response.statusCode = 401;
      response.setHeader('WWW-Authenticate', challenge());
      return response.end('prove it');
    }
    const field = (at) =>
      message.subarray(
        message.readUInt32LE(at + 4),
        message.readUInt32LE(at + 4) + message.readUInt16LE(at),
      );
    const nt = field(20);
    const domain = field(28).toString('utf16le');
    const user = field(36).toString('utf16le');
    const key = hmacMd5(NT_HASH_OF_PASSWORD, Buffer.from(user.toUpperCase() + domain, 'utf16le'));
    const proof = hmacMd5(key, Buffer.concat([serverChallenge, nt.subarray(16)]));
    const sameConnection = pending.has(request.socket);
    const ok = type === 3 && sameConnection && proof.equals(nt.subarray(0, 16));
    response.statusCode = ok ? 200 : 401;
    response.end(JSON.stringify({ ok, user, domain, sameConnection, body }));
  };
}

test('NTLM authenticates over one connection like Postman', async () => {
  const ntlm = (values) => ({
    type: 'ntlm',
    ntlm: Object.entries(values).map(([key, value]) => ({ key, value })),
  });
  const verifier = await fixture(ntlmVerifier());
  const negotiate = await fixture(ntlmVerifier({ schemes: ['Negotiate'] }));
  try {
    const sent = await server.execute('request', {
      request: {
        url: `${verifier.url}/secure`,
        method: 'POST',
        body: 'same body every time',
        auth: ntlm({ username: 'User', password: 'Password', domain: 'Domain', workstation: 'PC' }),
      },
    });
    assert.equal(sent.status, 200, sent.body);
    assert.deepEqual(JSON.parse(sent.body), {
      ok: true,
      user: 'User',
      domain: 'DOMAIN',
      sameConnection: true,
      body: 'same body every time',
    });

    // The domain can come with the username, and Negotiate also asks for NTLM.
    for (const [url, username] of [
      [verifier.url, 'Corp\\User'],
      [negotiate.url, 'User@corp.local'],
    ]) {
      const result = await server.execute('request', {
        request: { url: `${url}/secure`, auth: ntlm({ username, password: 'Password' }) },
      });
      assert.equal(result.status, 200, result.body);
      assert.equal(JSON.parse(result.body).domain, username.includes('@') ? 'CORP.LOCAL' : 'CORP');
    }

    // A wrong password ends with the server's answer, and the retry can be turned off.
    const wrong = await server.execute('request', {
      request: {
        url: `${verifier.url}/secure`,
        auth: ntlm({ username: 'User', password: 'nope' }),
      },
    });
    assert.equal(wrong.status, 401);
    assert.equal(JSON.parse(wrong.body).ok, false);
    const disabled = await server.execute('request', {
      request: {
        url: `${verifier.url}/secure`,
        auth: ntlm({ username: 'User', password: 'Password', disableRetryRequest: true }),
      },
    });
    assert.equal(disabled.status, 401);
    assert.equal(disabled.body, 'who are you?');
  } finally {
    await verifier.close();
    await negotiate.close();
  }
});

// A server that verifies JWTs with Node's crypto: every algorithm of Postman's JWT Bearer.
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
