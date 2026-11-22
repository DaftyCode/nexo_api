// Contract tests of the SQL tools of MCP (DB-32) on the SQLite module: only connections the
// person exposed exist for the agent, a statement that changes anything is refused, rows are
// bounded, a hidden column never comes out (not even under an alias) and nothing of the
// connection but its name and engine does.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
let server;
let folder;
let file;
const save = (id, value) =>
  server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind: 'connection',
    name: id,
    revision: 0,
    updated_at: 0,
    value: { driver: 'sqlite', database: file, ...value },
  });
async function rpc(method, params = {}) {
  const { status, body } = await server.api('POST', '/mcp', {
    jsonrpc: '2.0',
    id: 1,
    method,
    params,
  });
  assert.equal(status, 200);
  return body;
}
async function tool(name, args) {
  const { result } = await rpc('tools/call', { name, arguments: args });
  const text = result.content[0].text;
  return { error: result.isError, text, value: result.isError ? undefined : JSON.parse(text) };
}

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-sql-mcp-'));
  file = join(folder, 'shop.db');
  assert.equal((await save('setup', { params: { create: 'true' } })).status, 200);
  await server.execute('db.connect', { connectionId: 'setup', session: 'setup' });
  for (const sql of [
    'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, password TEXT)',
    "INSERT INTO users (name, password) VALUES ('Ada', 'hunter2'), ('Bob', 'swordfish')",
    'CREATE TABLE numbers (n INTEGER)',
    'WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < 150) INSERT INTO numbers SELECT i FROM s',
  ]) {
    const answer = await server.api('POST', '/execute/db.execute', {
      workspace: 'local',
      session: 'setup',
      statement: `s-${Math.random()}`,
      sql,
    });
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
  }
  await server.execute('db.disconnect', { session: 'setup' });
  assert.equal((await save('Shop', { mcp: true, mcpHidden: ['users.password'] })).status, 200);
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('only exposed connections exist for agents, by name and engine', async () => {
  const listed = await tool('sql_list_connections', {});
  assert.deepEqual(listed.value, { connections: [{ name: 'Shop', driver: 'sqlite' }] });
  const hidden = await tool('sql_list_tables', { connection: 'setup' });
  assert.equal(hidden.error, true);
  assert.match(hidden.text, /No SQL connection named setup is exposed to MCP/);
  const mongo = await tool('mongo_list_databases', { connection: 'Shop' });
  assert.equal(mongo.error, true);
  const tables = await tool('sql_list_tables', { connection: 'Shop' });
  const names = tables.value.tables.map((table) => table.path.at(-1));
  assert.deepEqual(names.sort(), ['numbers', 'users']);
  const users = tables.value.tables.find((table) => table.path.at(-1) === 'users');
  const described = await tool('sql_describe_table', { connection: 'Shop', path: users.path });
  assert.match(described.text, /password/);
  assert.doesNotMatch(described.text, /hunter2/);
  assert.doesNotMatch(JSON.stringify([listed, tables, described]), /shop\.db/);
});

test('a query that reads runs; anything else is refused', async () => {
  for (const sql of [
    "UPDATE users SET name = 'x'",
    'DELETE FROM users WHERE id = 1',
    'DROP TABLE users',
    'CREATE TABLE t (a int)',
  ]) {
    const refused = await tool('sql_query', { connection: 'Shop', sql });
    assert.equal(refused.error, true, sql);
    assert.match(refused.text, /only read/, sql);
  }
  const { value } = await tool('sql_query', {
    connection: 'Shop',
    sql: 'SELECT name FROM users WHERE id = ?',
    params: [1],
  });
  assert.deepEqual(value, { rows: [{ name: 'Ada' }], truncated: false, columns: ['name'] });
  const count = await tool('sql_query', {
    connection: 'Shop',
    sql: 'SELECT count(*) AS n FROM numbers',
  });
  assert.equal(count.value.rows[0].n, 150);
  // Where a value comes from is unknown, and it reads a table with hidden columns: hidden.
  const unknown = await tool('sql_query', {
    connection: 'Shop',
    sql: 'SELECT count(*) AS n FROM users',
  });
  assert.equal(unknown.value.rows[0].n, '[hidden]');
});

test('answers are bounded and hidden columns never come out, not even renamed', async () => {
  const many = await tool('sql_query', {
    connection: 'Shop',
    sql: 'SELECT n FROM numbers',
    limit: 500,
  });
  assert.equal(many.value.rows.length, 100);
  assert.equal(many.value.truncated, true);
  const few = await tool('sql_query', { connection: 'Shop', sql: 'SELECT n FROM numbers' });
  assert.equal(few.value.rows.length, 20);
  for (const sql of [
    'SELECT * FROM users',
    'SELECT name, password AS p FROM users',
    'SELECT upper(password) AS shout FROM users',
    'SELECT u.password FROM users u',
  ]) {
    const answer = await tool('sql_query', { connection: 'Shop', sql });
    assert.equal(answer.error, false, answer.text);
    assert.doesNotMatch(answer.text, /hunter2|swordfish|HUNTER2/i, sql);
    assert.match(answer.text, /\[hidden\]/, sql);
  }
  const names = await tool('sql_query', {
    connection: 'Shop',
    sql: 'SELECT name FROM users ORDER BY id',
  });
  assert.deepEqual(names.value.rows, [{ name: 'Ada' }, { name: 'Bob' }]);
  const plan = await tool('sql_explain', {
    connection: 'Shop',
    sql: 'SELECT * FROM users WHERE id = 1',
  });
  assert.equal(plan.error, false, plan.text);
});

test('resources describe exposed connections and their tables', async () => {
  const { resources } = (await rpc('resources/list')).result;
  assert.ok(resources.some((resource) => resource.uri === 'nexo://workspaces/local/sql/Shop'));
  assert.ok(!resources.some((resource) => resource.uri.includes('/sql/setup')));
  const read = await rpc('resources/read', { uri: 'nexo://workspaces/local/sql/Shop' });
  assert.match(read.result.contents[0].text, /users/);
  const { result } = await rpc('resources/templates/list');
  assert.ok(result.resourceTemplates.some((template) => template.uriTemplate.includes('/sql/')));
  const table = await rpc('resources/read', { uri: 'nexo://workspaces/local/sql/Shop/main/users' });
  assert.match(table.result.contents[0].text, /password/);
  const missing = await rpc('resources/read', {
    uri: 'nexo://workspaces/local/sql/Shop/main/none',
  });
  assert.equal(missing.error.code, -32002);
});
