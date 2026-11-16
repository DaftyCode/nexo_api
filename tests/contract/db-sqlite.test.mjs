// Contract tests of the SQLite module through Nexo: the driver runs as its own process and
// opens only the file a saved connection names. It needs no server, so it always runs.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
let server;
let folder;
/** A saved SQLite connection to a file of `folder`. */
const connection = (id, file, value = {}) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: `SQLite ${id}`,
  revision: 0,
  updated_at: 0,
  value: { driver: 'sqlite', database: file, ...value },
});
const save = async (document) =>
  assert.equal((await server.api('PUT', '/documents', document)).status, 200);
const connect = (id, session) =>
  server.api('POST', '/execute/db.connect', {
    workspace: 'local',
    connectionId: id,
    session,
  });
const run = (session, sql, extra = {}) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    ...extra,
  });

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-sqlite-contract-'));
  const shop = join(folder, 'shop.db');
  await save(connection('shop', shop, { params: { create: 'true' } }));
  await save(connection('shop-read', shop, { readOnly: true }));
  await save(connection('store', join(server.directory, 'nexo.sqlite')));
  await save(
    connection('inside', join(server.directory, 'copy.db'), { params: { create: 'true' } }),
  );
});
after(async () => {
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

test('the SQLite module answers through Nexo on the file the connection names', async () => {
  const opened = await connect('shop', 'shop-1');
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.match(opened.body.serverVersion, /^3\./);
  assert.equal(opened.body.database, 'shop.db');
  for (const sql of [
    'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)',
    'CREATE TRIGGER items_upper AFTER INSERT ON items BEGIN\n  UPDATE items SET label = upper(label) WHERE id = NEW.id;\nEND',
  ])
    assert.equal((await run('shop-1', sql, { confirm: true })).status, 200);
  const inserted = await run('shop-1', 'INSERT INTO items (label) VALUES (?)', {
    params: ['lamp'],
    confirm: true,
  });
  assert.equal(inserted.body.affected, 1, JSON.stringify(inserted.body));
  const found = await run('shop-1', 'SELECT id, label FROM items');
  assert.deepEqual(found.body.rows, [[1, 'LAMP']]);
  assert.equal(found.body.columns[0].key, true);
  const tables = await server.execute('db.tree', { session: 'shop-1', path: ['tables'] });
  assert.deepEqual(
    tables.nodes.filter((node) => !node.system).map((node) => node.name),
    ['items'],
  );
  const ddl = await server.execute('db.ddl', { session: 'shop-1', path: ['tables', 'items'] });
  assert.match(ddl.sql, /^CREATE TABLE items/);
  assert.match(ddl.sql, /CREATE TRIGGER items_upper/);
  const driver = await server.execute('db.dialect', { driver: 'sqlite' });
  assert.equal(driver.dialect.name, 'sqlite');
  assert.equal(driver.dialect.quoteOpen, '"');
  assert.equal(driver.capabilities.cancel, true);
});

test('a connection never reaches another file', async () => {
  await connect('shop', 'shop-2');
  const other = join(folder, 'other.db');
  const attached = await run('shop-2', `ATTACH DATABASE '${other}' AS other`, { confirm: true });
  assert.equal(attached.body.code, 'database.permission', JSON.stringify(attached.body));
  assert.match(attached.body.error, /ATTACH DATABASE is not allowed/);
  assert.equal(existsSync(other), false);
  // Nexo's own data folder is out of reach: its store, and a new file inside it.
  for (const id of ['store', 'inside']) {
    const refused = await connect(id, `${id}-1`);
    assert.equal(refused.body.code, 'database.permission', JSON.stringify(refused.body));
  }
  assert.equal(existsSync(join(server.directory, 'copy.db')), false);
});

test('a read-only connection is refused writes', async () => {
  await connect('shop', 'shop-3');
  await run('shop-3', 'CREATE TABLE IF NOT EXISTS notes (text TEXT)', { confirm: true });
  assert.equal((await connect('shop-read', 'read-1')).status, 200);
  const insert = await run('read-1', "INSERT INTO notes VALUES ('x')", { confirm: true });
  assert.match(insert.body.error, /read-only/);
  const pragma = await run('read-1', 'PRAGMA query_only = 0', { confirm: true });
  assert.equal(pragma.status, 400, JSON.stringify(pragma.body));
});
