// Contract tests for OAuth 1.0 and AWS Signature v4, against servers that verify them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, createVerify, generateKeyPairSync } from 'node:crypto';
import { fixture } from './server.mjs';
import { server, hash } from './auth-fixture.mjs';

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
