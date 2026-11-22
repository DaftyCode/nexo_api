// Contract tests of spatial values (DB-29): every driver sends a geometry as EWKB with its
// SRID, so the same point read from PostGIS, MySQL, MariaDB and SQL Server (whose CLR format
// its driver turns to EWKB, longitude first for a geography) is the same. They need
// tools/sql-fixture.sh and are skipped without it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';
import { dbClient } from './db-client.mjs';

const environment = process.env;
const fixture = environment.NEXO_SQL_POSTGIS_PORT ? false : 'start tools/sql-fixture.sh';
const mssql = environment.NEXO_SQL_MSSQL_HOST ? false : 'SQL Server runs only on x86-64';
let server;
const { save, connect, run, ok } = dbClient(() => server);

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
});
after(async () => {
  await server?.stop();
});

/** The point of an EWKB written in hexadecimal: its SRID and its coordinates. */
function point(hex) {
  const bytes = Buffer.from(hex, 'hex');
  const little = bytes[0] === 1;
  const word = (at) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  const kind = word(1);
  const srid = kind & 0x20000000 ? word(5) : 0;
  const at = kind & 0x20000000 ? 9 : 5;
  const double = (offset) => (little ? bytes.readDoubleLE(offset) : bytes.readDoubleBE(offset));
  return { type: kind & 0xff, srid, x: double(at), y: double(at + 8) };
}
const spatial = (cell) => {
  assert.equal(cell?.$t, 'spatial', JSON.stringify(cell));
  return point(cell.v);
};

test('PostGIS, MySQL and MariaDB send the same point as EWKB', { skip: fixture }, async () => {
  await server.api('PUT', '/secrets/db-password:postgis', {
    value: environment.NEXO_SQL_PG_PASSWORD,
  });
  await server.api('PUT', '/secrets/db-password:mysql', {
    value: environment.NEXO_SQL_MYSQL_PASSWORD,
  });
  await save('postgis', {
    driver: 'postgres',
    host: '127.0.0.1',
    port: Number(environment.NEXO_SQL_POSTGIS_PORT),
    database: environment.NEXO_SQL_PG_DATABASE,
    user: environment.NEXO_SQL_PG_USER,
    password: '{{vault:db-password:postgis}}',
  });
  await connect('postgis', 'g1');
  const places = await run('g1', 'SELECT shape FROM public.places ORDER BY id');
  assert.equal(places.rows.length, 5);
  assert.deepEqual(spatial(places.rows[4][0]), { type: 1, srid: 4326, x: 1, y: 2 });
  const plain = await run('g1', "SELECT ST_GeomFromText('POINT(1 2)')");
  assert.deepEqual(spatial(plain.rows[0][0]), { type: 1, srid: 0, x: 1, y: 2 });
  await ok('db.disconnect', { session: 'g1' });
  for (const [id, port] of [
    ['mysql', environment.NEXO_SQL_MYSQL_PORT],
    ['mariadb', environment.NEXO_SQL_MARIADB_PORT],
  ]) {
    await save(id, {
      driver: 'mysql',
      host: '127.0.0.1',
      port: Number(port),
      database: 'shop',
      user: 'root',
      password: '{{vault:db-password:mysql}}',
    });
    await connect(id, `${id}1`);
    const read = await run(`${id}1`, "SELECT ST_GeomFromText('POINT(1 2)') AS g");
    assert.deepEqual(spatial(read.rows[0][0]), { type: 1, srid: 0, x: 1, y: 2 }, id);
    await ok('db.disconnect', { session: `${id}1` });
  }
});

test(
  'SQL Server geometry and geography come as EWKB, longitude first',
  { skip: fixture || mssql },
  async () => {
    await server.api('PUT', '/secrets/db-password:mssql', {
      value: environment.NEXO_SQL_MSSQL_PASSWORD,
    });
    await save('mssql-spatial', {
      driver: 'mssql',
      host: '127.0.0.1',
      port: Number(environment.NEXO_SQL_MSSQL_PORT),
      database: 'shop',
      user: environment.NEXO_SQL_MSSQL_USER,
      password: '{{vault:db-password:mssql}}',
    });
    await connect('mssql-spatial', 'q1');
    const read = await run(
      'q1',
      "SELECT geometry::STGeomFromText('POINT(1 2)', 0) AS plane, geography::Point(2, 1, 4326) AS earth, geometry::STGeomFromText('POLYGON((0 0, 2 0, 2 2, 0 0))', 0) AS area",
    );
    assert.deepEqual(spatial(read.rows[0][0]), { type: 1, srid: 0, x: 1, y: 2 });
    assert.deepEqual(spatial(read.rows[0][1]), { type: 1, srid: 4326, x: 1, y: 2 });
    assert.equal(spatial(read.rows[0][2]).type, 3);
    assert.equal(read.columns[1].kind, 'spatial');
    await ok('db.disconnect', { session: 'q1' });
  },
);
