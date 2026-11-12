// Contract tests for cookies, vault secrets and the script sandbox.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { server, echo, rows } from './http-fixture.mjs';

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
