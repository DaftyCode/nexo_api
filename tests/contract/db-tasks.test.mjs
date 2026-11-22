// Contract tests of saved database tasks (DB-31) through Nexo, on the SQLite module: a task of
// scripts runs on sessions of its own and keeps its run in its history; what asks for a
// confirmation runs only when the task authorizes it; tasks of tasks stop at a failure; and a
// task of another workspace is not found.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
let server;
let folder;
const put = async (id, kind, name, value) =>
  assert.equal(
    (
      await server.api('PUT', '/documents', {
        id,
        workspace_id: 'local',
        kind,
        name,
        revision: 0,
        updated_at: 0,
        value,
      })
    ).status,
    200,
  );
const runTask = (id, workspace = 'local') =>
  server.api('POST', '/execute/db.task.run', { workspace, id });
const history = async (id) => (await server.api('GET', `/documents/${id}~history`)).body;

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-tasks-contract-'));
  await put('shop', 'connection', 'Shop', {
    driver: 'sqlite',
    database: join(folder, 'shop.db'),
    params: { create: 'true' },
  });
  await put('setup', 'sql-script', 'Setup', {
    connectionId: 'shop',
    sql: 'CREATE TABLE IF NOT EXISTS logs (id integer);\nINSERT INTO logs VALUES (1), (2);\nSELECT * FROM logs;',
  });
  await put('wipe', 'sql-script', 'Wipe', { connectionId: 'shop', sql: 'DELETE FROM logs;' });
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a task of scripts runs them on its own session and keeps its run', async () => {
  await put('fill', 'db-task', 'Fill', {
    type: 'script',
    scripts: ['setup'],
    connections: ['shop'],
    onError: 'stop',
    transaction: true,
  });
  const answer = await runTask('fill');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.state, 'passed');
  assert.equal(answer.body.trigger, 'manual');
  assert.equal(answer.body.statements, 3);
  assert.equal(answer.body.rows >= 4, true);
  const kept = await history('fill');
  assert.equal(kept.kind, 'monitor-history');
  assert.equal(kept.value.runs[0].state, 'passed');
});

test('what asks for a confirmation runs only when the task authorizes it', async () => {
  await put('clean', 'db-task', 'Clean', {
    type: 'script',
    scripts: ['wipe'],
    connections: ['shop'],
  });
  const refused = await runTask('clean');
  assert.equal(refused.status, 200);
  assert.equal(refused.body.state, 'failed');
  assert.match(refused.body.error, /does not authorize statements on every row/);
  assert.match(refused.body.statement, /^DELETE FROM logs/);
  await put('clean2', 'db-task', 'Clean all', {
    type: 'script',
    scripts: ['wipe'],
    connections: ['shop'],
    authorize: { everyRow: true },
  });
  const allowed = await runTask('clean2');
  assert.equal(allowed.body.state, 'passed', JSON.stringify(allowed.body));
});

test('tasks of tasks stop at the first failure, and go on when asked', async () => {
  await put('both', 'db-task', 'Both', { type: 'composite', tasks: ['clean', 'fill'] });
  const stopped = await runTask('both');
  assert.equal(stopped.body.state, 'failed');
  assert.match(stopped.body.error, /^Clean: /);
  assert.equal(stopped.body.statements, 0);
  await put('both2', 'db-task', 'Both, going on', {
    type: 'composite',
    tasks: ['clean', 'fill'],
    onError: 'continue',
  });
  const went = await runTask('both2');
  assert.equal(went.body.state, 'failed');
  assert.equal(went.body.statements, 3);
});

test('a task runs only in its workspace, and a missing script fails it', async () => {
  assert.equal((await runTask('fill', 'other')).status >= 400, true);
  assert.equal((await runTask('nothing')).status, 404);
  await put('lost', 'db-task', 'Lost', {
    type: 'script',
    scripts: ['gone'],
    connections: ['shop'],
  });
  const lost = await runTask('lost');
  assert.equal(lost.body.state, 'failed');
});
