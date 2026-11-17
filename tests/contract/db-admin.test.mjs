// Contract tests of the administration of a server through Nexo (DB-21), on each engine of
// tools/sql-fixture.sh: a slow query of another session is listed and cancelled from the
// session manager, two transactions that block each other are listed as waiting and
// blocking and ending the first frees the second, Nexo's own session is never ended, and a
// read-only connection ends none.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  admin,
  connect,
  drop,
  engines,
  execute,
  nexo,
  run,
  sessions,
  skip,
  start,
  stop,
  until,
} from './db-admin-fixture.mjs';

before(start);
after(stop);

for (const engine of engines) {
  test(
    `${engine.id}: a slow query is listed and cancelled; the own session is never ended`,
    { skip },
    async () => {
      const [watch, slow] = [`adm-${engine.id}`, `slow-${engine.id}`];
      await connect(engine.id, engine, watch);
      await connect(engine.id, engine, slow);
      const started = Date.now();
      const running = execute(slow, engine.slow);
      const target = await until(async () => {
        const list = await sessions(watch);
        return list.sessions.find((each) => each.sql?.includes('nexo_admin_probe') && !each.own);
      }, `running ${engine.slow}`);
      assert.ok(target.user, 'a session says its user');
      const list = await sessions(watch);
      const own = list.sessions.find((each) => each.own);
      assert.ok(own, 'the session that asks is marked');

      const refused = await admin('db.session.kill', watch, {
        target: own.id,
        mode: 'terminate',
        confirm: true,
      });
      assert.equal(refused.status, 400, JSON.stringify(refused.body));
      assert.match(JSON.stringify(refused.body), /own session/);

      const killed = await admin('db.session.kill', watch, {
        target: target.id,
        mode: engine.cancel,
        confirm: true,
      });
      assert.equal(killed.status, 200, JSON.stringify(killed.body));
      assert.equal(killed.body.done, true);
      const ended = await running;
      // MySQL's SLEEP answers 1 when it is interrupted, instead of failing.
      const stopped = ended.status !== 200 || String(ended.body.rows?.[0]?.[0]) === '1';
      assert.ok(stopped, `the slow query stopped: ${JSON.stringify(ended.body)}`);
      assert.ok(Date.now() - started < 25_000, 'long before it would have ended');

      await connect(`${engine.id}-read`, engine, `read-${engine.id}`);
      const readOnly = await admin('db.session.kill', `read-${engine.id}`, {
        target: target.id,
        mode: 'terminate',
        confirm: true,
      });
      assert.equal(readOnly.status, 400);
      assert.match(JSON.stringify(readOnly.body), /read-only/);
      for (const session of [watch, slow, `read-${engine.id}`])
        await nexo().execute('db.disconnect', { session });
    },
  );

  test(
    `${engine.id}: who waits for whom, and ending the blocker frees the waiting one`,
    { skip },
    async () => {
      const [watch, first, second] = [`lw-${engine.id}`, `la-${engine.id}`, `lb-${engine.id}`];
      for (const session of [watch, first, second]) await connect(engine.id, engine, session);
      for (const sql of engine.tables) await run(watch, sql);
      await nexo().execute('db.transaction', { session: first, action: 'begin' });
      await run(first, 'UPDATE nexo_admin.admin_locks SET n = n + 1 WHERE id = 1');
      const waiting = execute(second, 'UPDATE nexo_admin.admin_locks SET n = n + 10 WHERE id = 1');
      const wait = await until(async () => {
        const answer = await admin('db.locks', watch);
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        return answer.body.waits.find((each) => each.waitingSql?.includes('n + 10'));
      }, 'waiting for the lock');
      assert.notEqual(wait.waiting, wait.blocking);
      assert.ok(wait.seconds >= 0);

      const ended = await admin('db.session.kill', watch, {
        target: wait.blocking,
        mode: 'terminate',
        confirm: true,
      });
      assert.equal(ended.status, 200, JSON.stringify(ended.body));
      const freed = await waiting;
      assert.equal(freed.status, 200, JSON.stringify(freed.body));
      const after = await until(async () => {
        const answer = await admin('db.locks', watch);
        return answer.body.waits.length === 0 && answer.body;
      }, 'left waiting');
      assert.deepEqual(after.waits, []);
      for (const sql of engine.cleanup) await drop(watch, sql);
      for (const session of [watch, first, second])
        await nexo().api('POST', '/execute/db.disconnect', { session });
    },
  );
}
