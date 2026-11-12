// Contract tests for Hawk and NTLM, against servers that verify them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { fixture } from './server.mjs';
import { server, hash } from './auth-fixture.mjs';

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
