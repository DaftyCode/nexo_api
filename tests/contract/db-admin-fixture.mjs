// The servers of tools/sql-fixture.sh as the contract tests of the administration of a
// server (DB-21) use them: one saved connection per engine (and a read-only one), and the
// requests they make.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

export const environment = process.env;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let server;

/**
 * Each engine: its connection, a slow statement (marked, as other files of the contract tests
 * run slow statements on the same servers at the same time), and a table of its own to lock,
 * in a schema (or database) no other file lists.
 */
const mysqlTables = [
  'CREATE DATABASE IF NOT EXISTS nexo_admin',
  'CREATE TABLE IF NOT EXISTS nexo_admin.admin_locks (id int PRIMARY KEY, n int) ENGINE=InnoDB',
  'INSERT IGNORE INTO nexo_admin.admin_locks VALUES (1, 0)',
];
export const engines = [
  {
    id: 'pg',
    prefix: 'PG',
    driver: 'postgres',
    slow: 'SELECT pg_sleep(30) AS nexo_admin_probe',
    tables: [
      'CREATE SCHEMA IF NOT EXISTS nexo_admin',
      'CREATE TABLE IF NOT EXISTS nexo_admin.admin_locks (id int PRIMARY KEY, n int)',
      'INSERT INTO nexo_admin.admin_locks VALUES (1, 0) ON CONFLICT (id) DO NOTHING',
    ],
    cleanup: ['DROP SCHEMA IF EXISTS nexo_admin CASCADE'],
    cancel: 'cancel',
  },
  {
    id: 'my',
    prefix: 'MYSQL',
    driver: 'mysql',
    slow: 'SELECT SLEEP(30) AS nexo_admin_probe',
    tables: mysqlTables,
    cleanup: ['DROP DATABASE IF EXISTS nexo_admin'],
    cancel: 'cancel',
  },
  {
    id: 'maria',
    prefix: 'MARIADB',
    driver: 'mysql',
    slow: 'SELECT SLEEP(30) AS nexo_admin_probe',
    tables: mysqlTables,
    cleanup: ['DROP DATABASE IF EXISTS nexo_admin'],
    cancel: 'cancel',
  },
  {
    id: 'ms',
    prefix: 'MSSQL',
    driver: 'mssql',
    slow: "WAITFOR DELAY '00:00:30' -- nexo_admin_probe",
    tables: [
      "IF SCHEMA_ID('nexo_admin') IS NULL EXEC('CREATE SCHEMA nexo_admin')",
      "IF OBJECT_ID('nexo_admin.admin_locks') IS NULL " +
        'CREATE TABLE nexo_admin.admin_locks (id int PRIMARY KEY, n int)',
      'IF NOT EXISTS (SELECT 1 FROM nexo_admin.admin_locks) ' +
        'INSERT INTO nexo_admin.admin_locks VALUES (1, 0)',
    ],
    cleanup: [
      "IF OBJECT_ID('nexo_admin.admin_locks') IS NOT NULL DROP TABLE nexo_admin.admin_locks",
      "IF SCHEMA_ID('nexo_admin') IS NOT NULL DROP SCHEMA nexo_admin",
    ],
    // SQL Server cancels another session's statement only by ending the session.
    cancel: 'terminate',
  },
].filter((engine) => environment[`NEXO_SQL_${engine.prefix}_HOST`]);
export const skip = engines.length ? false : 'start tools/sql-fixture.sh';

export const save = (id, engine, value = {}) =>
  server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind: 'connection',
    name: id,
    revision: 0,
    updated_at: 0,
    value: {
      driver: engine.driver,
      host: '{{host}}',
      port: Number(environment[`NEXO_SQL_${engine.prefix}_PORT`]),
      database: environment[`NEXO_SQL_${engine.prefix}_DATABASE`],
      user: environment[`NEXO_SQL_${engine.prefix}_USER`],
      password: `{{vault:db-password:${engine.id}}}`,
      ...value,
    },
  });
export const connect = (id, engine, session) =>
  server.execute('db.connect', {
    connectionId: id,
    session,
    variables: { host: environment[`NEXO_SQL_${engine.prefix}_HOST`] },
  });
export const execute = (session, sql) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    confirm: true,
  });
export const run = async (session, sql) => {
  const answer = await execute(session, sql);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
/** Drops what a test made, typing the name Nexo asks for, as the person would. */
export const drop = async (session, sql) => {
  const asked = await execute(session, sql);
  const name = /confirm: (.+)$/.exec(asked.body?.error ?? '')?.[1];
  if (asked.status === 200 || !name)
    return assert.equal(asked.status, 200, JSON.stringify(asked.body));
  const answer = await server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    confirm: true,
    confirmName: name,
  });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
};
export const admin = (operation, session, extra = {}) =>
  server.api('POST', `/execute/${operation}`, {
    workspace: 'local',
    session,
    statement: `admin-${Math.random()}`,
    ...extra,
  });
export const sessions = async (session) => {
  const answer = await admin('db.sessions', session);
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  return answer.body;
};
/** Asks until `check` finds something, for at most ten seconds. */
export async function until(check, what) {
  for (let round = 0; round < 100; round++) {
    const found = await check();
    if (found) return found;
    await pause(100);
  }
  assert.fail(`Nothing ${what} after ten seconds`);
}

/** The Nexo server the tests talk to. */
export const nexo = () => server;

export async function start() {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  for (const engine of engines) {
    await server.api('PUT', `/secrets/db-password:${engine.id}`, {
      value: environment[`NEXO_SQL_${engine.prefix}_PASSWORD`],
    });
    assert.equal((await save(engine.id, engine)).status, 200);
    assert.equal((await save(`${engine.id}-read`, engine, { readOnly: true })).status, 200);
  }
}
export async function stop() {
  await server?.stop();
}
