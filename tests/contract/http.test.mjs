// Contract tests for requests, runs, variables, scripts and their security boundaries.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture, startServer, until } from './server.mjs';

let server;
let echo;
before(async () => {
  server = await startServer();
  echo = await fixture((request, body, response) => {
    if (request.url === '/image') {
      response.setHeader('content-type', 'image/png');
      return response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    }
    if (request.url === '/latin1') {
      response.setHeader('content-type', 'text/plain; charset=iso-8859-1');
      return response.end(Buffer.from(`Espa\xf1a ${request.headers['x-a']}`, 'latin1'));
    }
    if (request.url === '/login') response.setHeader('set-cookie', 'session=abc; Path=/');
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        path: request.url,
        method: request.method,
        authorization: request.headers.authorization ?? null,
        token: request.headers['x-token'] ?? null,
        cookie: request.headers.cookie ?? null,
        body,
      }),
    );
  });
});
after(async () => {
  await echo?.close();
  await server?.stop();
});
const rows = (values) => Object.fromEntries(values.map((row) => [row.key, row.value]));

test('a request inherits collection variables, auth and scripts without leaking folder scope', async () => {
  const result = await server.execute('request', {
    request: {
      name: 'Users',
      method: 'GET',
      url: '{{host}}/{{resource}}',
      auth: { type: 'inherit' },
    },
    variables: [{ key: 'host', value: echo.url, enabled: true }],
    globals: [{ key: 'tenant', value: 'acme', enabled: true }],
    context: {
      ancestors: [
        {
          name: 'API',
          variable: [{ key: 'resource', value: 'root-resource' }],
          auth: { type: 'bearer', bearer: [{ key: 'token', value: 'collection-token' }] },
          event: [
            {
              listen: 'prerequest',
              script: { exec: ['pm.collectionVariables.set("visits", "1");'] },
            },
          ],
        },
        { name: 'Folder', variable: [{ key: 'resource', value: 'users' }] },
      ],
    },
  });
  const body = JSON.parse(result.body);
  assert.equal(body.path, '/users');
  assert.equal(body.authorization, 'Bearer collection-token');
  assert.deepEqual(
    result.variables.collection.find((row) => row.key === 'visits'),
    { key: 'visits', value: '1' },
  );
  assert.ok(
    !result.variables.collection.some((row) => row.key === 'resource' && row.value === 'users'),
  );
  assert.deepEqual(result.variables.globals.values, [
    { key: 'tenant', value: 'acme', enabled: true },
  ]);
});

test('scripts set and unset variables, keep their order and report assertions', async () => {
  const result = await server.execute('request', {
    request: {
      url: `${echo.url}/token`,
      tests: [
        'pm.environment.set("token", pm.response.json().path);',
        'pm.globals.set("seen", "yes");',
        'pm.environment.unset("stale");',
        'pm.test("status", () => pm.response.to.have.status(200));',
      ].join('\n'),
    },
    variables: [
      { key: 'stale', value: 'old', enabled: true },
      { key: 'keep', value: 'value', enabled: true },
    ],
  });
  assert.deepEqual(
    result.variables.environment.values.map((row) => row.key),
    ['keep', 'token'],
  );
  assert.deepEqual(rows(result.variables.environment.values), { keep: 'value', token: '/token' });
  assert.deepEqual(result.variables.globals.values, [{ key: 'seen', value: 'yes', enabled: true }]);
  assert.equal(result.assertions[0].passed, true);
});

test('query variables are substituted after encoding', async () => {
  const result = await server.execute('request', {
    request: {
      url: `${echo.url}/search`,
      query: [
        { key: 'tenant', value: '{{tenant}}', enabled: true },
        { key: 'q', value: 'a b&c', enabled: true },
      ],
    },
    variables: [{ key: 'tenant', value: 'acme', enabled: true }],
  });
  assert.equal(JSON.parse(result.body).path, '/search?tenant=acme&q=a%20b%26c');
});

test('path variables of a Postman URL are filled in, with their own variables resolved', async () => {
  const result = await server.execute('request', {
    item: {
      name: 'Claims',
      request: {
        method: 'GET',
        url: {
          raw: `${echo.url}/orders/:order/items?status=6`,
          variable: [{ key: 'order', value: '{{order}}' }],
        },
      },
    },
    variables: [{ key: 'order', value: '1234567', enabled: true }],
  });
  assert.equal(JSON.parse(result.body).path, '/orders/1234567/items?status=6');
});

test('runs keep folder variables in their folder, order test scripts and iterate data', async () => {
  const script = (listen, line) => ({ listen, script: { exec: [line] } });
  const started = await server.execute('run', {
    iterations: 2,
    data: [{ n: 1 }, { n: 2 }],
    collection: {
      info: { name: 'Order' },
      variable: [{ key: 'base', value: echo.url }],
      event: [script('test', 'pm.collectionVariables.set("order", "collection");')],
      item: [
        {
          name: 'A',
          variable: [{ key: 'scoped', value: 'from-a' }],
          event: [
            script(
              'test',
              'pm.collectionVariables.set("order", pm.collectionVariables.get("order") + ",folder");',
            ),
          ],
          item: [
            {
              name: 'first',
              request: { method: 'POST', url: '{{base}}/a', body: { mode: 'raw', raw: 'n={{n}}' } },
              event: [
                script(
                  'test',
                  'pm.test("outer first", () => pm.expect(pm.collectionVariables.get("order")).to.equal("collection,folder"));',
                ),
                script(
                  'test',
                  'pm.test("data", () => pm.expect(pm.response.json().body).to.equal("n=" + pm.iterationData.get("n")));',
                ),
              ],
            },
          ],
        },
        {
          name: 'B',
          item: [
            {
              name: 'second',
              request: { method: 'GET', url: '{{base}}/b' },
              event: [
                script(
                  'test',
                  'pm.test("folder variable hidden", () => pm.expect(pm.collectionVariables.get("scoped")).to.equal(undefined));',
                ),
              ],
            },
          ],
        },
      ],
    },
  });
  const status = await until(async () => {
    const current = await server.execute('run', { action: 'status', id: started.id });
    return current.state !== 'running' && current;
  });
  assert.equal(status.state, 'completed', status.error);
  assert.equal(status.results.length, 4);
  assert.equal(status.assertions.length, 6);
  assert.ok(
    status.assertions.every((assertion) => assertion.passed),
    JSON.stringify(status.assertions),
  );
});

test('cookies persist per workspace and can be listed and cleared', async () => {
  await server.execute('request', { request: { url: `${echo.url}/login` } });
  const result = await server.execute('request', { request: { url: `${echo.url}/after` } });
  assert.equal(JSON.parse(result.body).cookie, 'session=abc');
  const { cookies } = await server.execute('cookies.list');
  assert.equal(cookies[0].name, 'session');
  assert.equal(cookies[0].expires, null, 'a session cookie is kept');
  await server.execute('cookies.clear');
  assert.deepEqual((await server.execute('cookies.list')).cookies, []);
});

test('the cookie manager adds, edits and deletes cookies that the next request sends', async () => {
  const domain = new URL(echo.url).hostname;
  const cookieOf = async () =>
    JSON.parse((await server.execute('request', { request: { url: `${echo.url}/after` } })).body)
      .cookie;
  const { cookie } = await server.execute('cookies.set', {
    name: 'theme',
    value: 'dark',
    domain,
    path: '/',
    expires: Date.now() + 3_600_000,
    httpOnly: true,
    sameSite: 'Lax',
  });
  assert.equal(cookie.domain, domain);
  assert.equal(cookie.hostOnly, true);
  assert.equal(cookie.sameSite, 'Lax');
  assert.equal(await cookieOf(), 'theme=dark');

  await server.execute('cookies.set', {
    name: 'mode',
    value: 'light',
    domain,
    original: { domain, path: '/', name: 'theme' },
  });
  assert.equal(await cookieOf(), 'mode=light');
  assert.deepEqual(
    (await server.execute('cookies.list')).cookies.map((c) => c.name),
    ['mode'],
  );

  assert.equal(
    (await server.execute('cookies.delete', { domain, path: '/', name: 'mode' })).deleted,
    true,
  );
  assert.equal(await cookieOf(), null);

  await assert.rejects(
    server.execute('cookies.set', { name: 'a', value: 'b', domain: 'https://x.test/' }),
    /is not a domain/,
  );
  await assert.rejects(
    server.execute('cookies.set', { name: 'a b', value: 'b', domain }),
    /name cannot contain/,
  );
  await assert.rejects(
    server.execute('cookies.set', { name: 'a', value: 'b', domain, expires: 1 }),
    /already passed/,
  );
  await assert.rejects(server.execute('cookies.delete', { domain }), /path/);
  await assert.rejects(
    server.execute('cookies.set', { name: 'a', value: 'b', domain, unknown: true }),
    /unknown/,
  );
});

test('vault secrets reach the request, stay hidden from scripts and are redacted', async () => {
  assert.equal(
    (await server.api('PUT', '/secrets/token', { value: 'super-secret-value' })).status,
    200,
  );
  const result = await server.execute('request', {
    request: {
      url: `${echo.url}/secret`,
      headers: [{ key: 'X-Token', value: '{{vault:token}}', enabled: true }],
      prerequest: [
        'pm.environment.set("leak", String(pm.variables.get("vault:token")));',
        'pm.environment.set("replaced", pm.variables.replaceIn("{{vault:token}}"));',
      ].join('\n'),
    },
  });
  assert.equal(JSON.parse(result.body).token, '[REDACTED]');
  assert.ok(!JSON.stringify(result).includes('super-secret-value'));
  const environment = rows(result.variables.environment.values);
  assert.equal(environment.leak, 'undefined');
  assert.equal(environment.replaced, '{{vault:token}}');
  assert.deepEqual((await server.api('GET', '/secrets')).body.names, ['token']);
});

test('overridden built-ins cannot capture vault secrets while the engine fills them', async () => {
  await server.api('PUT', '/secrets/token', { value: 'super-secret-value' });
  // Reversed, so that redaction does not hide a capture from the assertion.
  const reversed = 'super-secret-value'.split('').reverse().join('');
  const result = await server.execute('request', {
    request: {
      url: `${echo.url}/secret`,
      headers: [{ key: 'X-Token', value: '{{vault:token}}', enabled: true }],
      prerequest: [
        'globalThis.seen = [];',
        'const own = Object.hasOwn;',
        'Object.hasOwn = (o, k) => { seen.push(JSON.stringify(o)); return own(o, k); };',
        'const replace = String.prototype.replace;',
        'String.prototype.replace = function (p, f) {',
        '  if (typeof f === "function") seen.push(f("{{vault:token}}", "vault:token"));',
        '  return replace.call(this, p, f);',
        '};',
      ].join('\n'),
      tests: [
        'const text = seen.join("|");',
        'pm.environment.set("capture", text.split("").reverse().join(""));',
        'pm.sendRequest({ url: pm.variables.replaceIn("{{echo}}/send"), method: "POST",',
        '  header: [{ key: "X-Token", value: "{{vault:token}}" }] },',
        '  (error, response) => pm.environment.set("sent", response.json().token));',
      ].join('\n'),
    },
    variables: [{ key: 'echo', value: echo.url, enabled: true }],
  });
  assert.equal(JSON.parse(result.body).token, '[REDACTED]', 'the request itself gets the secret');
  assert.ok(!JSON.stringify(result).includes(reversed), 'a script captured the secret');
  const environment = rows(result.variables.environment.values);
  assert.equal(environment.sent, '{{vault:token}}', 'script requests carry no secrets');
});

test('scripts have no host access, cannot generate code and stop at the time limit', async () => {
  const result = await server.execute('request', {
    request: {
      url: `${echo.url}/sandbox`,
      tests: [
        'pm.test("no host", () => { pm.expect(typeof process).to.equal("undefined"); pm.expect(typeof require).to.equal("undefined"); });',
        'pm.test("no code generation", () => pm.expect(() => ({}).constructor.constructor("return 1")()).to.throw());',
      ].join('\n'),
    },
  });
  assert.ok(
    result.assertions.every((assertion) => assertion.passed),
    JSON.stringify(result.assertions),
  );
  await assert.rejects(
    server.execute('request', {
      request: { url: `${echo.url}/loop`, prerequest: 'while (true) {}' },
    }),
    /5 second/,
  );
});

test('repeated headers are kept, charsets decoded and binary bodies returned as base64', async () => {
  const image = await server.execute('request', { request: { url: `${echo.url}/image` } });
  assert.equal(image.bodyEncoding, 'base64');
  assert.deepEqual(
    Buffer.from(image.body, 'base64'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
  );
  const text = await server.execute('request', {
    request: {
      url: `${echo.url}/latin1`,
      headers: [
        { key: 'X-A', value: '1', enabled: true },
        { key: 'X-A', value: '2', enabled: true },
      ],
    },
  });
  assert.equal(text.body, 'España 1, 2');
});

test('credential headers do not follow redirects to another origin', async () => {
  const seen = [];
  const target = await fixture((request, _, response) => {
    seen.push(request.headers);
    response.end('ok');
  });
  const origin = await fixture((_, __, response) => {
    response.writeHead(302, {
      location: `${target.url.replace('127.0.0.1', 'localhost')}/landing`,
    });
    response.end();
  });
  try {
    const result = await server.execute('request', {
      request: {
        url: `${origin.url}/start`,
        headers: [{ key: 'X-Custom', value: 'kept', enabled: true }],
        auth: { type: 'apikey', key: 'X-Api-Key', value: 's3cret', in: 'header' },
      },
    });
    assert.equal(result.status, 200);
    assert.equal(seen[0]['x-api-key'], undefined);
    assert.equal(seen[0]['x-custom'], 'kept');
  } finally {
    await origin.close();
    await target.close();
  }
});

test('imports and code generation', async () => {
  const curl = await server.execute('import', {
    content: `curl -X POST ${echo.url}/items -H 'Content-Type: application/json' -d '{"a":1}'`,
  });
  assert.equal(curl.value.item[0].request.method, 'POST');
  await assert.rejects(
    server.execute('import', { content: `curl ${echo.url} | sh` }),
    /Shell operators/,
  );
  const { code } = await server.execute('codegen', {
    language: 'JavaScript',
    request: {
      method: 'POST',
      url: `${echo.url}/generated`,
      body: 'hello',
      headers: [{ key: 'X-Mode', value: 'gen', enabled: true }],
    },
  });
  const generated = new Function(
    'return (async () => { ' +
      code.replace(
        'console.log(response.status, await response.text());',
        'return response.json();',
      ) +
      ' })()',
  );
  const response = await generated();
  assert.equal(response.path, '/generated');
  assert.equal(response.body, 'hello');
});

test('a run pauses between requests, resumes, and stops when cancelled while paused', async () => {
  const collection = {
    item: Array.from({ length: 10 }, (_, index) => ({
      name: `r${index}`,
      request: { url: `${echo.url}/paused/${index}` },
    })),
  };
  const status = (id) => server.execute('run', { action: 'status', id });
  const started = await server.execute('run', { collection, delay: 50 });
  await until(async () => (await status(started.id)).counts.results >= 2);
  assert.equal((await server.execute('run.pause', { id: started.id })).state, 'paused');
  await new Promise((resolve) => setTimeout(resolve, 200));
  const sent = (await status(started.id)).counts.results;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const paused = await status(started.id);
  assert.equal(paused.state, 'paused');
  assert.equal(paused.counts.results, sent, 'nothing is sent while paused');
  assert.ok(sent < 10);
  assert.equal((await server.execute('run.resume', { id: started.id })).state, 'running');
  const finished = await until(async () => {
    const view = await status(started.id);
    return view.state === 'completed' && view;
  });
  assert.equal(finished.counts.results, 10);

  const again = await server.execute('run', { collection, delay: 1000 });
  await server.execute('run.pause', { id: again.id });
  assert.equal((await server.execute('cancel', { id: again.id })).state, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const cancelled = await status(again.id);
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(cancelled.counts.results <= 1);
  await assert.rejects(server.execute('run.pause', { id: 'missing' }), /not found/);
});

test('cancelled runs stop and unknown executions are reported', async () => {
  const started = await server.execute('run', {
    collection: {
      item: [
        {
          name: 'slow',
          request: { url: `${echo.url}/x` },
          event: [
            {
              listen: 'prerequest',
              script: { exec: ['const end = Date.now() + 3000; while (Date.now() < end) {}'] },
            },
          ],
        },
      ],
    },
  });
  const cancelled = await server.execute('cancel', { id: started.id });
  assert.equal(cancelled.state, 'cancelled');
  await assert.rejects(server.execute('run', { action: 'status', id: 'missing' }), /not found/);
  await assert.rejects(server.execute('unknown.operation'), /Unknown execution operation/);
});

test('the deny-private egress policy blocks private destinations', async () => {
  const restricted = await startServer({ NEXO_EGRESS: 'deny-private' });
  try {
    for (const url of [`${echo.url}/private`, 'http://169.254.169.254/latest', 'http://[::1]:9/']) {
      const blocked = await restricted.execute('request', { request: { url } });
      assert.equal(blocked.status, 0, url);
      assert.match(blocked.error, /egress policy/, url);
    }
    const scripted = await restricted.execute('request', {
      request: {
        url: `${echo.url}/blocked`,
        prerequest: [
          `pm.sendRequest("${echo.url}/from-script", (error) =>`,
          '  pm.environment.set("scriptError", error ? error.message : "sent"));',
        ].join('\n'),
      },
    });
    assert.match(
      rows(scripted.variables.environment.values).scriptError,
      /egress policy/,
      'pm.sendRequest follows the egress policy',
    );
    await assert.rejects(
      restricted.execute('oauth.token', { url: `${echo.url}/token`, fields: { grant_type: 'x' } }),
      /egress policy/,
    );
    await assert.rejects(
      restricted.execute('realtime.connect', { protocol: 'websocket', url: 'ws://127.0.0.1:9' }),
      /egress policy/,
    );
    const mock = await restricted.execute('mock.start', {
      examples: [{ path: '/own', body: { ok: true } }],
    });
    const own = await restricted.execute('request', { request: { url: `${mock.url}/own` } });
    assert.equal(own.status, 200, 'requests may reach the user’s own mocks');
  } finally {
    await restricted.stop();
  }
});

test('the server accepts every operation of the generated TypeScript contract', async () => {
  const source = await readFile('src/app/application/operations.ts', 'utf8');
  const block = source.slice(source.indexOf('EXECUTION_OPERATIONS'), source.indexOf('] as const'));
  const operations = [...block.matchAll(/'([a-z.]+)'/g)].map((match) => match[1]);
  assert.ok(operations.length > 20);
  for (const operation of operations) {
    if (operation === 'performance') continue; // starts a load test with no request: rejected below
    const response = await server.api('POST', `/execute/${operation}`, { workspace: 'local' });
    assert.notEqual(response.body?.error, 'Unknown execution operation', operation);
  }
  const unknown = await server.api('POST', '/execute/shell.exec', { workspace: 'local' });
  assert.equal(unknown.body.error, 'Unknown execution operation');
});

test('typed payloads are refused at the edge, naming the field', async () => {
  const misspelled = await server.api('POST', '/execute/request', {
    workspace: 'local',
    request: { url: `${echo.url}/never` },
    strictSsl: false,
  });
  assert.equal(misspelled.status, 400);
  assert.equal(misspelled.body.code, 'validation');
  assert.match(
    misspelled.body.error,
    /^Invalid request payload at strictSsl: unknown field `strictSsl`/,
  );
  const wrongType = await server.api('POST', '/execute/run', {
    workspace: 'local',
    collection: { info: { name: 'C' }, item: [] },
    iterations: 'many',
  });
  assert.equal(wrongType.status, 400);
  assert.match(
    wrongType.body.error,
    /^Invalid run payload at iterations: invalid type: string "many"/,
  );
  const row = await server.api('POST', '/execute/request', {
    workspace: 'local',
    request: { url: `${echo.url}/never` },
    variables: [{ value: 'no key' }],
  });
  assert.match(row.body.error, /at variables\[0\]: missing field `key`/);
  // Postman documents inside stay open: unknown item fields still reach the engine.
  const sent = await server.execute('request', {
    request: { url: `${echo.url}/typed`, nexoNote: 'kept' },
    variables: [{ key: 'a', value: '1', type: 'default', description: 'Postman field' }],
  });
  assert.equal(sent.status, 200);
});

test('run status returns only entries after the cursor', async () => {
  const started = await server.execute('run', {
    iterations: 3,
    collection: {
      item: [
        {
          name: 'r',
          request: { url: `${echo.url}/cursor` },
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {});'] } }],
        },
      ],
    },
  });
  const done = await until(async () => {
    const current = await server.execute('run', { action: 'status', id: started.id });
    return current.state !== 'running' && current;
  });
  assert.deepEqual(done.counts, { results: 3, assertions: 3, logs: 0 });
  const later = await server.execute('run', {
    action: 'status',
    id: started.id,
    after: { results: 2, assertions: 3 },
  });
  assert.equal(later.results.length, 1);
  assert.equal(later.assertions.length, 0);
  assert.equal(later.results[0].iteration, 2);
});
