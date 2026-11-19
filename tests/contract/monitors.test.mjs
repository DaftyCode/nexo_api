// Contract tests for monitors: a collection run on a schedule while Nexo is open. Run by
// hand here (the minute ticks are tested with a paused clock in the application); its
// history keeps counts and failures, an environment that asks first refuses its changes
// unless the monitor allows them, and the history goes with the monitor.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, startServer, until } from './server.mjs';

let server;
let echo;
const received = [];
before(async () => {
  server = await startServer();
  echo = await fixture((request, body, response) => {
    received.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  });
  const documents = [
    {
      id: 'orders',
      kind: 'collection',
      value: {
        info: { name: 'Orders' },
        item: [
          {
            id: 'list',
            name: 'List orders',
            request: { method: 'GET', url: `${echo.url}/orders` },
            event: [
              {
                listen: 'test',
                script: {
                  exec: [
                    'pm.test("is 200", () => pm.response.to.have.status(200));',
                    'pm.test("has three", () => pm.expect(1).to.equal(3));',
                  ],
                },
              },
            ],
          },
          {
            id: 'admin',
            name: 'Admin',
            item: [
              {
                id: 'purge',
                name: 'Purge',
                request: { method: 'DELETE', url: `${echo.url}/orders/1` },
              },
            ],
          },
        ],
      },
    },
    { id: 'stage', kind: 'environment', value: { values: [], protection: 'confirm' } },
    {
      id: 'check',
      kind: 'monitor',
      value: {
        collection: 'orders',
        environment: 'stage',
        schedule: { every: 1, unit: 'minutes' },
        paused: true,
        notify: true,
      },
    },
  ];
  for (const { id, kind, value } of documents) {
    const saved = await server.api('PUT', '/documents', {
      id,
      workspace_id: 'local',
      kind,
      name: id === 'stage' ? 'Staging' : id,
      revision: 0,
      updated_at: 0,
      value,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
});
after(async () => {
  await echo?.close();
  await server?.stop();
});

/** Runs monitor `check` by hand and waits for its history to grow. */
async function runOnce() {
  const before = await server.api('GET', '/documents/check~history');
  const count = before.status === 200 ? before.body.value.runs.length : 0;
  assert.deepEqual(await server.execute('monitor.run', { id: 'check' }), { state: 'running' });
  // Its history has the run before the monitor stops running.
  const history = await until(
    async () => {
      const answer = await server.api('GET', '/documents/check~history');
      const running = (await server.execute('monitor.status')).monitors[0].running;
      return (
        !running && answer.status === 200 && answer.body.value.runs.length > count && answer.body
      );
    },
    { attempts: 400, delay: 50 },
  );
  assert.equal(history.kind, 'monitor-history');
  return history.value.runs[0];
}

test('a monitor is checked when saved and tells when it runs next', async () => {
  const invalid = await server.api('PUT', '/documents', {
    id: 'wrong',
    workspace_id: 'local',
    kind: 'monitor',
    name: 'wrong',
    revision: 0,
    updated_at: 0,
    value: { collection: 'orders', schedule: { every: 7, unit: 'minutes' } },
  });
  assert.equal(invalid.status, 400);
  const status = await server.execute('monitor.status');
  assert.equal(status.scheduler, true);
  assert.deepEqual(status.monitors, [{ id: 'check', running: false, next: null }]);
});

test('a run by hand keeps its counts and failures, and asks nobody in a protected environment', async () => {
  received.length = 0;
  const run = await runOnce();
  assert.equal(run.trigger, 'manual');
  assert.equal(run.state, 'error');
  assert.equal(
    run.error,
    'The environment «Staging» asks before sending changes and a monitor cannot ask: DELETE requests are not sent',
  );
  assert.equal(run.requests, 2);
  assert.equal(run.failedRequests, 1);
  assert.equal(run.passedAssertions, 1);
  assert.equal(run.failedAssertions, 1);
  assert.equal(run.failures.find((failure) => failure.assertion)?.assertion, 'has three');
  assert.ok(run.duration >= 0 && run.startedAt > 0);
  assert.deepEqual(received, ['GET /orders'], 'the DELETE was never sent');

  const { finished, sequence } = await server.execute('monitor.status');
  assert.equal(finished.at(-1).monitor, 'check');
  assert.equal(finished.at(-1).state, 'error');
  assert.equal(finished.at(-1).notify, true);
  assert.deepEqual((await server.execute('monitor.status', { after: sequence })).finished, []);
});

test('allowed to send changes, a monitor of one folder sends them', async () => {
  const current = await server.api('GET', '/documents/check');
  const saved = await server.api('PUT', '/documents', {
    ...current.body,
    value: { ...current.body.value, folder: 'admin', allowChanges: true },
  });
  assert.equal(saved.status, 200);
  received.length = 0;
  const run = await runOnce();
  assert.equal(run.state, 'passed');
  assert.equal(run.requests, 1);
  assert.deepEqual(received, ['DELETE /orders/1']);
});

test('a monitor runs once at a time, and its history goes with it', async () => {
  await server.execute('monitor.run', { id: 'check' });
  await assert.rejects(server.execute('monitor.run', { id: 'check' }), /still running/);
  await until(
    async () =>
      (await server.execute('monitor.status')).monitors[0].running === false &&
      (await server.api('GET', '/documents/check~history')).body.value.runs.length === 3,
    { attempts: 400, delay: 50 },
  );
  await assert.rejects(server.execute('monitor.run', { id: 'orders' }), /not found/i);
  const current = await server.api('GET', '/documents/check');
  const deleted = await server.api('DELETE', `/documents/check?revision=${current.body.revision}`);
  assert.equal(deleted.status, 200);
  assert.equal((await server.api('GET', '/documents/check~history')).status, 404);
});
