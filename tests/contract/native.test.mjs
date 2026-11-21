// Contract tests of the local client tools (DB-23): they run programs of the computer with
// files chosen in native dialogs, so only the desktop app has them; the web version (which
// the contract tests start) refuses every native.* operation before anything runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { server } from './http-fixture.mjs';

test('the web version has no local client tools', async () => {
  const saved = await server.api('PUT', '/documents', {
    id: 'native-contract',
    workspace_id: 'local',
    kind: 'connection',
    name: 'Native contract',
    revision: 0,
    updated_at: 0,
    value: {
      driver: 'postgres',
      host: '127.0.0.1',
      port: 5432,
      database: 'shop',
      localClient: '/opt/pg/bin',
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const connection = { id: 'native-contract' };
  for (const [operation, payload] of [
    ['native.locate', { connection: connection.id }],
    ['native.backup', { connection: connection.id, options: { path: '/tmp/x.sql' } }],
    [
      'native.restore',
      { connection: connection.id, options: { path: '/tmp/x.sql' }, confirmName: 'shop' },
    ],
    ['native.script', { connection: connection.id, options: { path: '/tmp/x.sql' } }],
    ['native.status', { id: 'run' }],
    ['native.cancel', { id: 'run' }],
  ])
    await assert.rejects(
      server.execute(operation, { workspace: 'local', ...payload }),
      /in the desktop app/,
      operation,
    );
});
