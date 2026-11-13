// Contract tests of the database connections (`db.*`) with the test driver, a module built
// from the sources: sessions on saved connections, the rules that refuse or ask before a
// statement, the history, cancelling, and secrets that never come back.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

let server;
const connection = (id, value) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: `Connection ${id}`,
  revision: 0,
  updated_at: 0,
  value: {
    driver: 'test',
    host: '{{host}}',
    port: 5432,
    user: 'ana',
    password: `{{vault:db-password:${id}}}`,
    ...value,
  },
});
before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(process.env.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  for (const [id, value, password] of [
    ['dev', {}, 'secret'],
    ['ro', { readOnly: true }, 'secret'],
    ['prod', { type: 'production' }, 'secret'],
    ['leak', { params: { leak: 'error' } }, 'tr0ub4dor&3'],
  ]) {
    await server.api('PUT', `/secrets/db-password:${id}`, { value: password });
    const saved = await server.api('PUT', '/documents', connection(id, value));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }
});
after(async () => {
  await server?.stop();
});

const connect = (id, session) =>
  server.execute('db.connect', { connectionId: id, session, variables: { host: '127.0.0.1' } });
/** Runs a statement and answers the API's status and body, refused or not. */
const run = (session, sql, extra = {}) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    ...extra,
  });

test('a connection that keeps its password is not saved', async () => {
  const saved = await server.api('PUT', '/documents', connection('plain', { password: 'hunter2' }));
  assert.equal(saved.status, 400);
  assert.match(saved.body.error, /Keep the password out of the connection/);
});

test('a session reads by pages and is closed', async () => {
  const server_ = await connect('dev', 'dev-1');
  assert.equal(server_.serverVersion, '1.0');
  const first = await run('dev-1', 'select numbers 120', { pageRows: 50 });
  assert.equal(first.status, 200);
  assert.equal(first.body.rows.length, 50);
  const next = await server.execute('db.fetch', {
    session: 'dev-1',
    cursor: first.body.cursor,
    pageRows: 50,
  });
  assert.deepEqual(next.rows[0], [51, 'row 51']);
  const tree = await server.execute('db.tree', { session: 'dev-1' });
  assert.deepEqual(
    tree.nodes.map((node) => node.name),
    ['numbers', 'people'],
  );
  const ddl = await server.execute('db.ddl', { session: 'dev-1', path: ['people'] });
  assert.match(ddl.sql, /create table people/);
  await server.execute('db.disconnect', { session: 'dev-1' });
  const closed = await run('dev-1', 'select people');
  assert.equal(closed.status, 400);
  assert.match(closed.body.error, /not open/);
});

test('every row, TRUNCATE and DROP need their confirmation', async () => {
  await connect('dev', 'dev-2');
  for (const sql of ['delete from people', 'update people set name = 1', 'truncate people']) {
    const refused = await run('dev-2', sql);
    assert.equal(refused.status, 400, sql);
    assert.match(refused.body.error, /every row/);
    // Confirmed, it reaches the test driver, which does not know it.
    const confirmed = await run('dev-2', sql, { confirm: true });
    assert.equal(confirmed.body.code, 'database.syntax', sql);
  }
  const drop = await run('dev-2', 'drop table people', { confirm: true });
  assert.match(drop.body.error, /Type the name of what is dropped to confirm: people/);
  const named = await run('dev-2', 'drop table people', { confirmName: 'people' });
  assert.equal(named.body.code, 'database.syntax');
});

test('a read-only connection refuses writes before its driver sees them', async () => {
  await connect('ro', 'ro-1');
  assert.equal((await run('ro-1', 'select people')).status, 200);
  const refused = await run('ro-1', 'insert person Bob', { confirm: true });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /read-only/);
  const people = await run('ro-1', 'select people');
  assert.equal(people.body.rows.length, 2);
});

test('a production connection asks before every write', async () => {
  await connect('prod', 'prod-1');
  const refused = await run('prod-1', 'insert person Bob');
  assert.match(refused.body.error, /for production/);
  const written = await run('prod-1', 'insert person Bob', { confirm: true });
  assert.equal(written.body.affected, 1);
  assert.equal((await run('prod-1', 'select people')).body.rows.length, 3);
});

test('a running statement is cancelled', async () => {
  await connect('dev', 'dev-3');
  const running = server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session: 'dev-3',
    statement: 'slow',
    sql: 'sleep 60000',
  });
  await new Promise((done) => setTimeout(done, 300));
  await server.execute('db.cancel', { session: 'dev-3', statement: 'slow' });
  const cancelled = await running;
  assert.equal(cancelled.status, 400);
  assert.equal(cancelled.body.code, 'database.cancelled');
});

test('the password of a connection never comes back', async () => {
  const refused = await server.api('POST', '/execute/db.connect', {
    workspace: 'local',
    connectionId: 'leak',
    session: 'leak-1',
    variables: { host: '127.0.0.1' },
  });
  assert.equal(refused.body.code, 'database.auth');
  assert.doesNotMatch(JSON.stringify(refused.body), /tr0ub4dor/);
  assert.doesNotMatch(server.logs(), /tr0ub4dor/);
  const undefinedVariable = await server.api('POST', '/execute/db.connect', {
    workspace: 'local',
    connectionId: 'dev',
    session: 'dev-4',
  });
  assert.match(undefinedVariable.body.error, /\{\{host\}\} has no value/);
});

test('statements are recorded in the history, never their results', async () => {
  const listing = await server.api('GET', '/documents?workspace=local&lite=true');
  const history = listing.body.filter((document) => document.kind === 'sql-history');
  assert.ok(history.length >= 5, `${history.length} statements recorded`);
  const one = await server.api('GET', `/documents/${history[0].id}`);
  assert.equal(typeof one.body.value.sql, 'string');
  assert.equal(one.body.value.columns, undefined);
  assert.equal(JSON.stringify(one.body).includes('row 1'), false);
});

test('scripts are split and drivers say what they are', async () => {
  const split = await server.execute('db.split', {
    script: 'select 1;\ndelete from t;',
    dialect: 'postgresql',
    offset: 12,
  });
  assert.equal(split.statements.length, 2);
  assert.equal(split.current, 1);
  assert.equal(split.statements[1].classification.missingWhere, true);
  const driver = await server.execute('db.dialect', { driver: 'test' });
  assert.equal(driver.driver.id, 'test');
  const missing = await server.api('POST', '/execute/db.dialect', { driver: 'oracle' });
  assert.equal(missing.body.code, 'database.unsupported');
});
