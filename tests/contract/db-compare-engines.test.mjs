// Contract tests of comparing two engines (DB-24): a table and its copy in another engine
// (PostgreSQL in MySQL and in SQL Server, made by DB-17) or another server of the same family
// (MySQL in MariaDB) have no false differences of type or of data. They need the servers of
// tools/sql-fixture.sh and are skipped without them.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';
import { dbClient } from './db-client.mjs';

const environment = process.env;
const setting = (prefix, key) => environment[`NEXO_SQL_${prefix}_${key}`];
let server;
const { save, connect, run, ok } = dbClient(() => server);

/** Where the tests make their tables: their own, as the other files run at the same time. */
const OWN = 'nexo_compare';
const MYSQL_TABLE = (name) =>
  `CREATE TABLE ${OWN}.${name} (id int PRIMARY KEY, label varchar(40) NOT NULL, price decimal(10,2), at datetime, ok tinyint(1), big bigint unsigned, note text)`;
const mysqlFamily = (prefix) => ({
  prefix,
  driver: 'mysql',
  path: (name) => ['databases', OWN, 'tables', name],
  setup: `CREATE DATABASE IF NOT EXISTS ${OWN}`,
  cleanup: `DROP DATABASE IF EXISTS ${OWN}`,
  create: MYSQL_TABLE,
  primary: (name) => `ALTER TABLE ${OWN}.${name} ADD PRIMARY KEY (id)`,
});

/** The fixture's engines: where a table is in the tree, and the table each one starts from. */
const ENGINES = {
  pg: {
    prefix: 'PG',
    driver: 'postgres',
    path: (name) => [setting('PG', 'DATABASE'), 'schemas', OWN, 'tables', name],
    setup: `CREATE SCHEMA IF NOT EXISTS ${OWN}`,
    cleanup: `DROP SCHEMA IF EXISTS ${OWN} CASCADE`,
    create: (name) =>
      `CREATE TABLE ${OWN}.${name} (id integer PRIMARY KEY, label varchar(40) NOT NULL, price numeric(10,2), at timestamptz, ok boolean, ref uuid, doc jsonb)`,
    fill: (name) =>
      `INSERT INTO ${OWN}.${name} SELECT i, 'item ' || i, i * 1.25, timestamptz '2026-01-01 10:00:00+02' + i * interval '1 hour', i % 2 = 0, md5(i::text)::uuid, jsonb_build_object('i', i, 'a', 'x') FROM generate_series(1, 300) AS i`,
  },
  my: {
    ...mysqlFamily('MYSQL'),
    fill: (name) =>
      `INSERT INTO ${OWN}.${name} WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) SELECT i, CONCAT('item ', i), i * 1.25, TIMESTAMP('2026-01-01 10:00:00') + INTERVAL i HOUR, i % 2, i * 1000000, REPEAT('x', i % 5) FROM n`,
  },
  maria: mysqlFamily('MARIADB'),
  ms: {
    prefix: 'MSSQL',
    driver: 'mssql',
    path: (name) => ['databases', setting('MSSQL', 'DATABASE'), 'schemas', OWN, 'tables', name],
    setup: `IF SCHEMA_ID('${OWN}') IS NULL EXEC('CREATE SCHEMA ${OWN}')`,
    cleanup: `IF SCHEMA_ID('${OWN}') IS NOT NULL DROP SCHEMA ${OWN}`,
  },
};
const connected = new Set();
const skipped = (...keys) =>
  keys.every((key) => setting(ENGINES[key].prefix, 'HOST')) ? false : 'start tools/sql-fixture.sh';

/** Opens a session on a fixture's engine, once, named as the engine. */
async function open(key) {
  if (connected.has(key)) return;
  const { prefix, driver } = ENGINES[key];
  await server.api('PUT', `/secrets/db-password:${key}`, { value: setting(prefix, 'PASSWORD') });
  await save(key, {
    driver,
    host: '{{host}}',
    port: Number(setting(prefix, 'PORT')),
    database: setting(prefix, 'DATABASE'),
    user: setting(prefix, 'USER'),
    password: `{{vault:db-password:${key}}}`,
  });
  await connect(key, key, setting(prefix, 'HOST'));
  await run(key, ENGINES[key].setup);
  connected.add(key);
}

/** Copies the source's table to the target, page by page, as the transfer wizard does. */
async function copy(from, to, name) {
  const [source, target] = [ENGINES[from], ENGINES[to]];
  if (source.driver === target.driver) await run(to, source.create(name));
  else {
    const probe = await run(from, `SELECT * FROM ${OWN}.${name} WHERE 1 = 0`);
    const converted = await ok('db.convert', {
      session: to,
      schema: OWN,
      table: name,
      columns: probe.columns,
      sourceDriver: source.driver,
    });
    await run(to, converted.sql);
    if (target.primary) await run(to, target.primary(name));
  }
  let cursor;
  let columns;
  const copied = { read: 0, inserted: 0 };
  do {
    const page = await ok('db.copy', {
      source: from,
      target: to,
      schema: OWN,
      table: name,
      first: copied.read + 1,
      ...(cursor ? { cursor, columns } : { sql: `SELECT * FROM ${OWN}.${name} ORDER BY id` }),
    });
    assert.equal(page.failed, 0, JSON.stringify(page.failures));
    copied.read += page.read;
    copied.inserted += page.inserted;
    cursor = page.cursor;
    columns ??= page.columns?.map((column) => column.name);
  } while (cursor);
  assert.deepEqual(copied, { read: 300, inserted: 300 });
}

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
});
after(async () => {
  for (const key of connected) await run(key, ENGINES[key].cleanup);
  await server?.stop();
});

for (const [from, to, label] of [
  ['pg', 'my', 'a PostgreSQL table and its copy in MySQL'],
  ['pg', 'ms', 'a PostgreSQL table and its copy in SQL Server'],
  ['my', 'maria', 'a MySQL table and its copy in MariaDB'],
])
  test(`${label} have no false differences`, { skip: skipped(from, to) }, async () => {
    await open(from);
    await open(to);
    const [source, target] = [ENGINES[from], ENGINES[to]];
    const name = `compare_${Date.now()}`;
    await run(from, source.create(name));
    await run(from, source.fill(name));
    try {
      await copy(from, to, name);
      const structure = await ok('db.compare.schema', {
        source: { session: from, path: source.path(name), table: true },
        target: { session: to, path: target.path(name), table: true },
      });
      assert.equal(structure.between, source.driver !== target.driver);
      const typed = structure.objects[0].differences.filter((d) => d.fields.includes('type'));
      assert.deepEqual(typed, [], JSON.stringify(structure.objects[0].differences));
      const side = (key, engine) => ({
        session: key,
        path: engine.path(name),
        schema: OWN,
        table: name,
      });
      const data = await ok('db.compare.data', {
        source: side(from, source),
        target: side(to, target),
      });
      assert.deepEqual(
        data.counts,
        { onlySource: 0, onlyTarget: 0, different: 0, equal: 300 },
        JSON.stringify(data.differences.slice(0, 3)),
      );
    } finally {
      await run(from, `DROP TABLE ${OWN}.${name}`);
      await run(to, `DROP TABLE IF EXISTS ${OWN}.${name}`);
    }
  });
