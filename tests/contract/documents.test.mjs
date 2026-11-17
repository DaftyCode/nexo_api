// Contract tests for document listings, revisions and workspace scoping.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});
const document = (id, kind, value) => ({
  id,
  workspace_id: 'local',
  kind,
  name: `${kind} ${id}`,
  revision: 0,
  updated_at: 0,
  value,
});

test('the light listing omits history and run values, which load on demand', async () => {
  const big = 'x'.repeat(200 * 1024);
  for (const saved of [
    document('c1', 'collection', { info: { name: 'c' }, item: [] }),
    document('h1', 'history', { request: { method: 'GET' }, response: { body: big } }),
    document('r1', 'run', { results: [{ body: big }] }),
  ])
    assert.equal((await server.api('PUT', '/documents', saved)).status, 200);
  const listing = await server.api('GET', '/documents?workspace=local&lite=true');
  const byId = Object.fromEntries(listing.body.map((d) => [d.id, d]));
  assert.deepEqual(byId.c1.value, { info: { name: 'c' }, item: [] });
  assert.equal(byId.h1.value, null);
  assert.equal(byId.r1.value, null);
  assert.ok(JSON.stringify(listing.body).length < 10 * 1024, 'listing stays small');
  const entry = await server.api('GET', '/documents/h1');
  assert.equal(entry.body.value.response.body.length, big.length);
  assert.deepEqual((await server.api('GET', '/documents/h1/revisions')).body, []);
});

test('documents are validated by kind and saves detect conflicts', async () => {
  const invalid = await server.api(
    'PUT',
    '/documents',
    document('e1', 'environment', { name: 'x' }),
  );
  assert.equal(invalid.status, 400);
  const saved = await server.api(
    'PUT',
    '/documents',
    document('e2', 'environment', { values: [] }),
  );
  assert.equal(saved.body.revision, 1);
  const stale = await server.api('PUT', '/documents', { ...saved.body, revision: 0 });
  assert.equal(stale.status, 409);
  const missing = await server.api('GET', '/documents?workspace=missing&lite=true');
  assert.equal(missing.status, 404);
});

test('a workspace keeps one session, saved over without revisions', async () => {
  const value = (active) => ({
    tabs: [
      { id: 't1', documentId: 'c1', path: [0] },
      { id: active, documentId: '', path: [] },
    ],
    activeTab: active,
    collections: ['c1'],
  });
  const other = await server.api('PUT', '/documents', document('s1', 'session', value('t2')));
  assert.equal(other.status, 400, 'a session has the id of its workspace');
  const first = await server.api(
    'PUT',
    '/documents',
    document('session-local', 'session', value('t2')),
  );
  assert.equal(first.status, 200);
  const second = await server.api('PUT', '/documents', { ...first.body, value: value('t3') });
  assert.equal(second.body.revision, 2);
  const listing = await server.api('GET', '/documents?workspace=local&lite=true');
  const session = listing.body.find((d) => d.kind === 'session');
  assert.equal(session.value.activeTab, 't3', 'listed with its value, ready to restore');
  assert.deepEqual((await server.api('GET', '/documents/session-local/revisions')).body, []);
});

test('a database diagram keeps its revisions and is listed with its tables', async () => {
  const value = {
    connectionId: 'c1',
    notation: 'idef1x',
    detail: 'all',
    types: true,
    entities: [{ path: ['tables', 'orders'], name: 'orders', x: 10, y: 20 }],
    notes: [{ id: 'n1', text: 'Billing', x: 0, y: 0 }],
  };
  const first = await server.api('PUT', '/documents', document('d1', 'db-diagram', value));
  assert.equal(first.status, 200);
  const moved = { ...value, entities: [{ ...value.entities[0], x: 40 }] };
  const second = await server.api('PUT', '/documents', { ...first.body, value: moved });
  assert.equal(second.body.revision, 2);
  const listing = await server.api('GET', '/documents?workspace=local&lite=true');
  const listed = listing.body.find((d) => d.id === 'd1');
  assert.deepEqual(listed.value.entities[0], {
    path: ['tables', 'orders'],
    name: 'orders',
    x: 40,
    y: 20,
  });
  const revisions = await server.api('GET', '/documents/d1/revisions');
  const kept = Object.fromEntries(revisions.body.map((each) => [each.revision, each.value.value]));
  assert.equal(kept[1].entities[0].x, 10, 'the place it had before is kept');
  assert.equal(kept[2].entities[0].x, 40);
});

test('every response carries a request id for the logs', async () => {
  const first = await fetch(`${server.base}/health`);
  const second = await fetch(`${server.base}/health`);
  const ids = [first.headers.get('x-request-id'), second.headers.get('x-request-id')];
  assert.match(ids[0] ?? '', /^[0-9a-f-]{36}$/);
  assert.notEqual(ids[0], ids[1]);
});
