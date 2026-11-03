import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const directory = await mkdtemp(join(tmpdir(), 'nexo-server-test-'));
const fixture = http.createServer((req, res) => {
  let body = '';
  req.on('data', (x) => (body += x));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        body,
        fixture: req.headers['x-fixture'],
      }),
    );
  });
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const port = 18185;
const child = spawn(
  resolve(`target/release/nexo-server${process.platform === 'win32' ? '.exe' : ''}`),
  [],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NEXO_NODE: process.execPath,
      NEXO_DATA_DIR: directory,
      NEXO_MODE: 'server',
      NEXO_ALLOW_SIGNUP: 'true',
      NEXO_BIND: `127.0.0.1:${port}`,
      NEXO_ENGINE_SCRIPT: resolve('engine/dist/engine.mjs'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let logs = '';
child.stderr.on('data', (x) => (logs += x));
child.stdout.on('data', (x) => (logs += x));
async function api(method, path, payload, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}
const checks = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await api('GET', '/health')).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, logs);
  assert.equal((await api('GET', '/workspaces')).status, 401);
  checks.push('server requires authentication');
  const owner = (
    await api('POST', '/auth/register', {
      email: 'owner@nexo.test',
      name: 'Owner',
      password: 'Correct-Horse-Battery-42',
    })
  ).body;
  assert.ok(owner.token, JSON.stringify(owner));
  const viewer = (
    await api('POST', '/auth/register', {
      email: 'viewer@nexo.test',
      name: 'Viewer',
      password: 'Another-Good-Passphrase-42',
    })
  ).body;
  assert.ok(viewer.token);
  const workspaces = (await api('GET', '/workspaces', undefined, owner.token)).body;
  const workspace = workspaces[0].id;
  const collection = {
    id: 'collection-fixture',
    workspace_id: workspace,
    kind: 'collection',
    name: 'Fixture API',
    revision: 0,
    updated_at: 0,
    value: {
      info: {
        name: 'Fixture API',
        schema: 'urn:nexo:collection:1',
      },
      item: [],
    },
  };
  const saved = await api('PUT', '/documents', collection, owner.token);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.equal((await api('PUT', '/documents', collection, owner.token)).status, 409);
  checks.push('atomic revisions prevent lost writes');
  assert.equal(
    (await api('GET', `/documents/${collection.id}`, undefined, viewer.token)).status,
    403,
  );
  assert.equal(
    (
      await api(
        'POST',
        `/workspaces/${workspace}/members`,
        { email: 'viewer@nexo.test', role: 'viewer' },
        owner.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await api('GET', `/documents/${collection.id}`, undefined, viewer.token)).status,
    200,
  );
  assert.equal(
    (await api('PUT', '/documents', { ...saved.body, name: 'No permission' }, viewer.token)).status,
    403,
  );
  checks.push('workspace membership and viewer permissions');
  const execution = await api(
    'POST',
    '/execute/request',
    {
      request: {
        url: `http://127.0.0.1:${fixture.address().port}/echo`,
        method: 'POST',
        body: '{"hello":"Nexo"}',
        headers: [
          { key: 'Content-Type', value: 'application/json', enabled: true },
          { key: 'X-Fixture', value: '{{value}}', enabled: true },
        ],
        tests: 'pm.test("Status is 200", () => pm.response.to.have.status(200));',
      },
      variables: [{ key: 'value', value: 'from-environment', enabled: true }],
    },
    owner.token,
  );
  assert.equal(execution.status, 200, JSON.stringify(execution));
  assert.equal(execution.body.status, 200, JSON.stringify(execution));
  assert.equal(JSON.parse(execution.body.body).fixture, 'from-environment');
  assert.equal(execution.body.assertions[0].passed, true);
  checks.push('Rust → compatibility adapter → HTTP → scripts → response');
  assert.equal(
    (await api('PUT', '/secrets/test_token', { value: 'private-token' }, owner.token)).status,
    200,
  );
  checks.push('encrypted vault write');
  const mcp = await api(
    'POST',
    '/mcp',
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    owner.token,
  );
  assert.equal(mcp.body.result.tools.length, 2);
  checks.push('authenticated MCP tool discovery');
  await api('POST', '/auth/logout', {}, owner.token);
  assert.equal((await api('GET', '/workspaces', undefined, owner.token)).status, 401);
  checks.push('session revocation');
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
