// Contract tests of the dashboards of a server through Nexo (DB-22), on each engine of
// tools/sql-fixture.sh: the driver offers its panels, each one reads numbers through
// `db.dashboard.read`, a query that writes is refused, a load shows in the transactions a
// few seconds later, and once the dashboard's session is closed its queries stop on the
// server.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
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

const read = (session, sql) =>
  nexo().api('POST', '/execute/db.dashboard.read', {
    workspace: 'local',
    session,
    statement: `panel-${Math.random()}`,
    sql,
  });
/** The numbers of a reading: a series per numeric column of one row, or per row. */
function numbers(answer) {
  if (answer.rows.length === 1)
    return answer.rows[0].map(Number).filter((value) => Number.isFinite(value));
  return answer.rows.map((row) => Number(row[1]));
}

for (const engine of engines) {
  test(
    `${engine.id}: the driver's panels read numbers, and a write is refused`,
    { skip },
    async () => {
      const session = `dash-${engine.id}`;
      await connect(engine.id, engine, session);
      const answer = await nexo().api('POST', '/execute/db.dashboards', {
        workspace: 'local',
        session,
      });
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      const panels = answer.body.dashboards;
      assert.ok(panels.length >= 5, `${panels.length} panels`);
      for (const id of ['sessions', 'transactions', 'size', 'locks'])
        assert.ok(
          panels.some((panel) => panel.id === id),
          id,
        );
      for (const panel of panels) {
        const reading = await read(session, panel.sql);
        assert.equal(reading.status, 200, `${panel.id}: ${JSON.stringify(reading.body)}`);
        assert.ok(numbers(reading.body).every(Number.isFinite), panel.id);
        assert.equal(reading.body.cursor, null);
      }
      const written = await read(session, 'DELETE FROM nexo_nothing');
      assert.equal(written.status, 400);
      assert.match(written.body.error, /only reads/);
      await nexo().execute('db.disconnect', { session });
    },
  );
}

test(
  'pg: a load shows in the transactions, and a closed dashboard reads no more',
  { skip: engines.some((engine) => engine.id === 'pg') ? false : 'start tools/sql-fixture.sh' },
  async () => {
    const pg = engines.find((engine) => engine.id === 'pg');
    for (const session of ['dash-load', 'dash-watch', 'dash-work'])
      await connect('pg', pg, session);
    const panels = await nexo().execute('db.dashboards', { session: 'dash-load' });
    const transactions = panels.dashboards.find((panel) => panel.id === 'transactions');
    const commits = async () => (await read('dash-load', transactions.sql)).body.rows[0][0];
    const before = Number(await commits());
    for (let at = 0; at < 30; at++) await run('dash-work', 'SELECT 1');
    await until(async () => Number(await commits()) >= before + 30, 'counted');

    // The dashboard's session leaves the server once closed.
    const pid = String((await read('dash-load', 'SELECT pg_backend_pid()')).body.rows[0][0]);
    const seen = (list) => list.sessions.some((each) => each.id === pid);
    assert.ok(seen(await sessions('dash-watch')));
    await nexo().execute('db.disconnect', { session: 'dash-load' });
    await until(async () => !seen(await sessions('dash-watch')), 'still reading');
    assert.equal((await execute('dash-load', 'SELECT 1')).status, 400);
    for (const session of ['dash-watch', 'dash-work'])
      await nexo().execute('db.disconnect', { session });
  },
);
