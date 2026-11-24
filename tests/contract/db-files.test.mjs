// Contract tests of the files module through Nexo (DB-30): a folder of a CSV and a JSON file
// is two tables that join, and nothing outside the connection's files is read or installed.
// The driver compiles DuckDB, which takes too long for CI: build it apart (npm run files:test)
// and run these tests by hand before a release; without it they skip.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';
import { dbClient } from './db-client.mjs';

const environment = process.env;
const modules = resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug');
const built = ['nexo-driver-files', 'nexo-driver-files.exe'].some((name) =>
  existsSync(join(modules, name)),
);
const skip = built ? false : 'build the files driver: cargo build -p nexo-driver-files';
let server;
let folder;
let outside;
const { save, connect, run, call, ok } = dbClient(() => server);

before(async () => {
  if (skip) return;
  server = await startServer({ NEXO_MODULES_DIR: modules, NEXO_MODULES_CATALOG: '' });
  folder = await mkdtemp(join(tmpdir(), 'nexo-files-contract-'));
  outside = await mkdtemp(join(tmpdir(), 'nexo-files-outside-'));
  await writeFile(join(folder, 'ventas.csv'), 'id,cliente,total\n1,1,10\n2,2,20\n3,1,5\n');
  await writeFile(
    join(folder, 'clientes.json'),
    '[{"id": 1, "nombre": "Ana"}, {"id": 2, "nombre": "Luis"}]',
  );
  await writeFile(join(outside, 'secret.csv'), 'password\nhunter2\n');
});
after(async () => {
  await server?.stop();
  for (const each of [folder, outside])
    if (each) await rm(each, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test('a folder of files is tables that join', { skip }, async () => {
  assert.equal((await save('files', { driver: 'files', database: folder })).status, 200);
  await connect('files', 'f1');
  const tree = await ok('db.tree', { session: 'f1', path: [] });
  assert.deepEqual(
    tree.nodes.map((node) => node.name),
    ['clientes', 'ventas'],
  );
  const joined = await run(
    'f1',
    'SELECT c.nombre, sum(v.total) AS total FROM ventas v JOIN clientes c ON c.id = v.cliente GROUP BY c.nombre ORDER BY c.nombre',
  );
  assert.deepEqual(joined.rows, [
    ['Ana', 15],
    ['Luis', 20],
  ]);
  await ok('db.disconnect', { session: 'f1' });
});

test(
  'nothing outside the files is read, and nothing is installed or written',
  { skip },
  async () => {
    await save('files2', { driver: 'files', database: folder });
    await connect('files2', 'f2');
    const secret = join(outside, 'secret.csv').replaceAll('\\', '/');
    for (const sql of [
      `SELECT * FROM read_csv('${secret}')`,
      "SELECT * FROM read_csv('https://example.com/x.csv')",
      'INSTALL httpfs',
      "COPY ventas TO 'copied.csv'",
    ]) {
      const refused = await call('db.execute', {
        session: 'f2',
        statement: `q-${Math.random()}`,
        sql,
        confirm: true,
      });
      assert.equal(refused.status >= 400, true, sql);
      assert.doesNotMatch(JSON.stringify(refused.body), /hunter2/);
    }
    await ok('db.disconnect', { session: 'f2' });
  },
);
