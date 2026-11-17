// Contract tests of the users and roles of a server through Nexo (DB-21), read only, on each
// engine of tools/sql-fixture.sh: a role or a login with what it belongs to and what it may
// do, the permissions on a table, and a user without the privilege to see every session
// told which one it lacks.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  connect,
  drop,
  engines,
  execute,
  nexo,
  run,
  save,
  sessions,
  skip,
  start,
  stop,
} from './db-admin-fixture.mjs';

before(start);
after(stop);

/** Each engine: how a reader is made, and where its table and the reader are in the tree. */
const security = {
  pg: {
    setup: [
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexo_reader') THEN " +
        'CREATE ROLE nexo_reader NOLOGIN; END IF; END $$',
      'CREATE SCHEMA IF NOT EXISTS nexo_security',
      'CREATE TABLE IF NOT EXISTS nexo_security.readable (id int PRIMARY KEY)',
      'GRANT SELECT ON nexo_security.readable TO nexo_reader',
    ],
    table: ['shop', 'schemas', 'nexo_security', 'tables', 'readable'],
    principal: ['shop', 'roles', 'nexo_reader'],
    sections: ['member-of', 'members', 'privileges'],
    reader: 'nexo_reader',
    cleanup: ['DROP SCHEMA IF EXISTS nexo_security CASCADE', 'DROP ROLE IF EXISTS nexo_reader'],
  },
  my: {
    setup: [
      "CREATE USER IF NOT EXISTS 'nexo_reader'@'%' IDENTIFIED BY 'reader-secret'",
      'CREATE DATABASE IF NOT EXISTS nexo_security',
      'CREATE TABLE IF NOT EXISTS nexo_security.readable (id int PRIMARY KEY)',
      "GRANT SELECT ON nexo_security.readable TO 'nexo_reader'@'%'",
    ],
    table: ['databases', 'nexo_security', 'tables', 'readable'],
    principal: ['users', 'nexo_reader@%'],
    sections: ['grants'],
    reader: "'nexo_reader'@'%'",
    cleanup: ['DROP DATABASE IF EXISTS nexo_security', "DROP USER IF EXISTS 'nexo_reader'@'%'"],
  },
  ms: {
    setup: [
      "IF SCHEMA_ID('nexo_security') IS NULL EXEC('CREATE SCHEMA nexo_security')",
      "IF OBJECT_ID('nexo_security.readable') IS NULL " +
        'CREATE TABLE nexo_security.readable (id int PRIMARY KEY)',
      'GRANT SELECT ON nexo_security.readable TO public',
    ],
    table: ['databases', 'shop', 'schemas', 'nexo_security', 'tables', 'readable'],
    principal: ['security', 'logins', 'sa'],
    sections: ['member-of', 'members', 'permissions'],
    reader: 'public',
    cleanup: [
      "IF OBJECT_ID('nexo_security.readable') IS NOT NULL DROP TABLE nexo_security.readable",
      "IF SCHEMA_ID('nexo_security') IS NOT NULL DROP SCHEMA nexo_security",
    ],
  },
};
security.maria = security.my;

for (const engine of engines) {
  test(
    `${engine.id}: users and roles are described, and who may do what with a table`,
    { skip },
    async () => {
      // The last test of each engine: it leaves the shared data as it found it.
      const { setup, table, principal, sections, reader, cleanup } = security[engine.id];
      const session = `sec-${engine.id}`;
      await connect(engine.id, engine, session);
      for (const sql of setup) await run(session, sql);
      const describe = async (path) => {
        const answer = await nexo().api('POST', '/execute/db.describe', {
          workspace: 'local',
          session,
          path,
        });
        assert.equal(answer.status, 200, JSON.stringify(answer.body));
        return answer.body;
      };
      const described = await describe(principal);
      const ids = described.sections.map((each) => each.id);
      assert.deepEqual(
        ids.filter((id) => sections.includes(id)),
        sections,
      );
      if (engine.id === 'pg') {
        const privileges = described.sections.find((each) => each.id === 'privileges');
        assert.ok(privileges.rows.some((row) => row.includes('readable')));
      }
      if (engine.id === 'ms') {
        const roles = described.sections.find((each) => each.id === 'member-of');
        assert.ok(roles.rows.some((row) => row.includes('sysadmin')));
      }
      const permissions = (await describe(table)).sections.find(
        (each) => each.id === 'permissions',
      );
      assert.ok(permissions, 'a table has its permissions');
      assert.ok(
        permissions.rows.some((row) => row[0] === reader && /select/i.test(String(row[1]))),
        JSON.stringify(permissions.rows),
      );
      for (const sql of cleanup) await drop(session, sql);
      await nexo().execute('db.disconnect', { session });
    },
  );
}

test(
  'pg: a user without pg_monitor is told what it lacks',
  { skip: engines.some((e) => e.id === 'pg') ? false : 'start tools/sql-fixture.sh' },
  async () => {
    const pg = engines.find((engine) => engine.id === 'pg');
    await connect('pg', pg, 'priv-admin');
    await run(
      'priv-admin',
      "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexo_plain') THEN " +
        "CREATE ROLE nexo_plain LOGIN PASSWORD 'plain-secret'; END IF; END $$",
    );
    await nexo().api('PUT', '/secrets/db-password:plain', { value: 'plain-secret' });
    assert.equal(
      (await save('plain', pg, { user: 'nexo_plain', password: '{{vault:db-password:plain}}' }))
        .status,
      200,
    );
    await connect('plain', pg, 'priv-plain');
    const list = await sessions('priv-plain');
    assert.equal(list.privilege, 'pg_monitor');
    assert.ok(list.sessions.some((each) => each.own));
    await nexo().execute('db.disconnect', { session: 'priv-plain' });
    await drop('priv-admin', 'DROP ROLE IF EXISTS nexo_plain');
    await nexo().execute('db.disconnect', { session: 'priv-admin' });
  },
);
