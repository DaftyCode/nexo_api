// Contract tests for Akamai EdgeGrid, WSSE and netrc, against servers that check them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, verify } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, startServer } from './server.mjs';
import { server, digest, hash, fields, send } from './auth-fixture.mjs';

function edgegridVerifier({ secret, host, headersToSign, maxBody }) {
  const hmac = (key, data) => createHmac('sha256', key).update(data).digest('base64');
  return (request, body, response) => {
    const header = request.headers.authorization ?? '';
    const [unsigned, signature] = header.split('signature=');
    const fields = Object.fromEntries(
      unsigned
        .replace('EG1-HMAC-SHA256 ', '')
        .split(';')
        .filter(Boolean)
        .map((pair) => pair.split(/=(.*)/s).slice(0, 2)),
    );
    const canonical = headersToSign
      .filter((name) => request.headers[name])
      .map((name) => `${name}:${request.headers[name].trim().replace(/\s+/g, ' ')}`)
      .join('\t');
    const hash =
      request.method === 'POST' && body
        ? createHash('sha256').update(Buffer.from(body).subarray(0, maxBody)).digest('base64')
        : '';
    const data = [request.method, 'http', host, request.url, canonical, hash, unsigned].join('\t');
    const ok = signature === hmac(hmac(secret, fields.timestamp), data);
    response.statusCode = ok ? 200 : 401;
    response.end(JSON.stringify({ ok, fields }));
  };
}

test('Akamai EdgeGrid signatures verify, with signed headers, body limit and base URL', async () => {
  const secret = 'edgegrid-secret=';
  const local = await fixture((request, body, response) => handler(request, body, response));
  let handler;
  const edgegrid = (values) => ({
    type: 'edgegrid',
    edgegrid: Object.entries(values).map(([key, value]) => ({ key, value })),
  });
  try {
    const host = new URL(local.url).host;
    for (const [label, values, expectedHost] of [
      ['request host', {}, host],
      [
        'base URL host',
        { baseURL: 'https://akaa-example.luna.akamaiapis.net/' },
        'akaa-example.luna.akamaiapis.net',
      ],
    ]) {
      handler = edgegridVerifier({
        secret,
        host: expectedHost,
        headersToSign: ['x-test1', 'x-test2'],
        maxBody: 16,
      });
      const result = await server.execute('request', {
        request: {
          url: `${local.url}/papi/v1/properties?contractId=ctr_1`,
          method: 'POST',
          headers: [
            { key: 'X-Test1', value: '  spaced    value ', enabled: true },
            { key: 'X-Other', value: 'not signed', enabled: true },
          ],
          body: 'a body longer than sixteen bytes',
          auth: edgegrid({
            accessToken: 'akab-access',
            clientToken: 'akab-client',
            clientSecret: '{{edgegridSecret}}',
            headersToSign: 'X-Test1, X-Test2',
            maxBodySize: '16',
            ...values,
          }),
        },
        variables: [{ key: 'edgegridSecret', value: secret, enabled: true }],
      });
      assert.equal(result.status, 200, `${label}: ${result.body}`);
      const { fields } = JSON.parse(result.body);
      assert.equal(fields.client_token, 'akab-client', label);
      assert.match(fields.timestamp, /^\d{8}T\d{2}:\d{2}:\d{2}\+0000$/, label);
      assert.match(fields.nonce, /^[0-9a-f-]{36}$/, label);
    }
  } finally {
    await local.close();
  }
});

// A WSSE server: recomputes Bruno's digest (Base64 of the hexadecimal SHA-1) with the password.
test('WSSE UsernameToken digests verify like Bruno sends them', async () => {
  const verifier = await fixture((request, body, response) => {
    const header = request.headers['x-wsse'] ?? '';
    const f = Object.fromEntries([...header.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    const hex = createHash('sha1').update(`${f.Nonce}${f.Created}wsse-password`).digest('hex');
    const ok =
      header.startsWith('UsernameToken ') &&
      f.PasswordDigest === Buffer.from(hex).toString('base64');
    response.statusCode = ok ? 200 : 401;
    response.end(JSON.stringify({ ok, username: f.Username, nonce: f.Nonce, created: f.Created }));
  });
  try {
    const nonces = new Set();
    for (let i = 0; i < 2; i++) {
      const result = await server.execute('request', {
        request: {
          url: `${verifier.url}/soap`,
          auth: {
            type: 'wsse',
            wsse: [
              { key: 'username', value: 'bob' },
              { key: 'password', value: 'wsse-password' },
            ],
          },
        },
      });
      assert.equal(result.status, 200, result.body);
      const answer = JSON.parse(result.body);
      assert.equal(answer.username, 'bob');
      assert.match(answer.nonce, /^[0-9a-f]{32}$/);
      assert.match(answer.created, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      nonces.add(answer.nonce);
    }
    assert.equal(nonces.size, 2, 'a new nonce on every send');
  } finally {
    await verifier.close();
  }
});

// Netrc reads only the file the server was started with (NEXO_NETRC stands for ~/.netrc).
test('netrc sends the machine or default login, and nothing without a match', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nexo-netrc-'));
  const echoAuthorization = await fixture((request, body, response) => {
    response.end(JSON.stringify({ authorization: request.headers.authorization ?? null }));
  });
  const servers = [];
  try {
    const host = new URL(echoAuthorization.url).hostname;
    const send = async (netrc) => {
      const file = join(directory, `netrc-${servers.length}`);
      await writeFile(file, netrc);
      const started = await startServer({ NEXO_NETRC: file });
      servers.push(started);
      const result = await started.execute('request', {
        request: { url: `${echoAuthorization.url}/files`, auth: { type: 'netrc', netrc: [] } },
      });
      return JSON.parse(result.body).authorization;
    };
    const basic = (credentials) => `Basic ${Buffer.from(credentials).toString('base64')}`;
    assert.equal(
      await send(
        `machine ${host} login ada password "s3cret pass"\ndefault login anon password guest\n`,
      ),
      basic('ada:s3cret pass'),
    );
    assert.equal(
      await send(
        'machine other.example.com login ada password x\ndefault login anon password guest\n',
      ),
      basic('anon:guest'),
    );
    assert.equal(await send('machine other.example.com login ada password x\n'), null);
  } finally {
    await echoAuthorization.close();
    for (const started of servers) await started.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
