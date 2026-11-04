// End-to-end verification of the local web service built in target/release.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixture = http.createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => (body += chunk));
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ path: request.url, fixture: request.headers['x-fixture'], body }),
    );
  });
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const port = await new Promise((resolvePort) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolvePort(port));
  });
});
const directory = await mkdtemp(join(tmpdir(), 'nexo-verify-'));
const token = 'verify-local-token';
const child = spawn(
  resolve(
    process.env.CARGO_TARGET_DIR ?? 'target',
    `release/nexo-server${process.platform === 'win32' ? '.exe' : ''}`,
  ),
  ['--api-only', '--port', String(port)],
  {
    env: {
      ...process.env,
      NEXO_DATA_DIR: directory,
      NEXO_LOCAL_TOKEN: token,
      NEXO_MASTER_KEY: '0'.repeat(64),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let logs = '';
child.stderr.on('data', (x) => (logs += x));
child.stdout.on('data', (x) => (logs += x));
const base = `http://127.0.0.1:${port}`;
async function api(method, path, { payload, headers = {}, auth = true } = {}) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    redirect: 'manual',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}
/** Raw HTTP request, so the Host header can be chosen. */
function rawStatus(path, host) {
  return new Promise((resolveStatus, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host, authorization: `Bearer ${token}` },
      },
      (response) => {
        response.resume();
        resolveStatus(response.statusCode);
      },
    );
    request.on('error', reject);
    request.end();
  });
}
const checks = [];
try {
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      if ((await api('GET', '/health', { auth: false })).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, logs);

  assert.equal((await api('GET', '/workspaces', { auth: false })).status, 401);
  assert.equal(
    (
      await api('GET', '/workspaces', {
        auth: false,
        headers: { authorization: 'Bearer wrong' },
      })
    ).status,
    401,
  );
  assert.equal(await rawStatus('/api/workspaces', `evil.example:${port}`), 401);
  assert.equal(
    (await api('GET', '/workspaces', { headers: { origin: 'https://evil.example' } })).status,
    401,
  );
  checks.push('requests need the local token, a loopback host and an allowed origin');

  const link = await api('POST', '/session/link');
  assert.equal(link.status, 200);
  const opened = await fetch(`${base}${link.body.path}`, { redirect: 'manual' });
  assert.equal(opened.status, 303);
  const cookie = opened.headers.get('set-cookie');
  assert.match(cookie, /nexo_session=\w+; HttpOnly; SameSite=Strict/);
  const session = cookie.split(';')[0];
  assert.equal((await fetch(`${base}${link.body.path}`, { redirect: 'manual' })).status, 401);
  const withCookie = (headers = {}) =>
    api('GET', '/workspaces', { auth: false, headers: { cookie: session, ...headers } });
  assert.equal((await withCookie({ 'x-nexo-client': 'nexo' })).status, 200);
  assert.equal((await withCookie()).status, 401);
  const closed = await api('POST', '/session/close', {
    auth: false,
    headers: { cookie: session, 'x-nexo-client': 'nexo' },
  });
  assert.equal(closed.status, 200);
  assert.equal((await withCookie({ 'x-nexo-client': 'nexo' })).status, 401);
  checks.push('one-time links create HttpOnly sessions that need the client header');

  const created = await api('POST', '/workspaces', { payload: { name: 'Work' } });
  assert.equal(created.status, 200);
  const renamed = await api('PUT', `/workspaces/${created.body.id}`, { payload: { name: 'Job' } });
  assert.equal(renamed.body.name, 'Job');
  const collection = {
    id: 'collection-fixture',
    workspace_id: created.body.id,
    kind: 'collection',
    name: 'Fixture API',
    revision: 0,
    updated_at: 0,
    value: { info: { name: 'Fixture API', schema: 'urn:nexo:collection:1' }, item: [] },
  };
  const saved = await api('PUT', '/documents', { payload: collection });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.equal((await api('PUT', '/documents', { payload: collection })).status, 409);
  const summaries = await api('GET', `/documents?workspace=${created.body.id}&summary=true`);
  assert.equal(summaries.body.length, 1);
  assert.equal('value' in summaries.body[0], false);
  assert.equal((await api('DELETE', `/workspaces/${created.body.id}`)).status, 200);
  assert.equal((await api('GET', `/documents/${collection.id}`)).status, 404);
  checks.push('workspaces, revisions, summaries and conflicts');

  const secret = await api('PUT', '/secrets/test_token', { payload: { value: 'private-token' } });
  assert.equal(secret.status, 200);
  const execution = await api('POST', '/execute/request', {
    payload: {
      workspace: 'local',
      request: {
        url: `http://127.0.0.1:${fixture.address().port}/echo`,
        method: 'POST',
        body: '{"hello":"Nexo"}',
        headers: [
          { key: 'Content-Type', value: 'application/json', enabled: true },
          { key: 'X-Fixture', value: '{{vault:test_token}}', enabled: true },
        ],
        tests: 'pm.test("Status is 200", () => pm.response.to.have.status(200));',
      },
    },
  });
  assert.equal(execution.status, 200, JSON.stringify(execution));
  assert.equal(execution.body.status, 200, JSON.stringify(execution));
  assert.equal(execution.body.assertions[0].passed, true);
  assert.ok(!JSON.stringify(execution.body).includes('private-token'), 'secrets are redacted');
  assert.deepEqual((await api('GET', '/secrets')).body.names, ['test_token']);
  checks.push('request with vault secret, scripts and redaction');

  const mcp = await api('POST', '/mcp', {
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  assert.equal(mcp.body.result.tools.length, 2);
  checks.push('MCP tool discovery');

  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
  await mkdir('.verification', { recursive: true });
  await writeFile(
    '.verification/server.json',
    JSON.stringify({ passed: checks.length, checks }, null, 2),
  );
} finally {
  child.kill();
  child.stdout.destroy();
  child.stderr.destroy();
  child.unref();
  fixture.closeAllConnections();
  await new Promise((r) => fixture.close(r));
  await new Promise((r) => setTimeout(r, 1000));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
