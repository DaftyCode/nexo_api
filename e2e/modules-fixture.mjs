// The database drivers built for the tests, as downloadable modules for the end-to-end tests.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { executableName, hostTarget, moduleEntry } from '../tools/modules/manifest.mjs';

/** The drivers the tests can download, when they are built next to the server. */
const DRIVERS = [
  {
    id: 'test',
    name: 'Test database',
    description: 'A database in memory, for the tests',
    licenses: ['MIT OR Apache-2.0'],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'PostgreSQL and compatible servers',
    licenses: ['MIT OR Apache-2.0'],
  },
  {
    id: 'mssql',
    name: 'SQL Server',
    description: 'Microsoft SQL Server and Azure SQL Database',
    licenses: ['MIT OR Apache-2.0'],
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'MySQL, MariaDB and the servers that speak their protocol',
    licenses: ['MIT OR Apache-2.0'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'SQLite databases, in a file of this computer that the person chose',
    licenses: ['MIT OR Apache-2.0', 'Public Domain'],
  },
  {
    id: 'redis',
    name: 'Redis',
    description: 'Redis, Valkey and the servers that speak RESP',
    licenses: ['MIT OR Apache-2.0', 'BSD-3-Clause'],
  },
  {
    id: 'hive',
    name: 'Apache Hive',
    description: 'Apache Hive (HiveServer2), through Thrift over HTTP',
    licenses: ['MIT OR Apache-2.0'],
  },
  {
    id: 'ignite',
    name: 'Apache Ignite',
    description: 'Apache Ignite 3, through its client protocol',
    licenses: ['MIT OR Apache-2.0'],
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    description: 'MongoDB and the servers compatible with it',
    licenses: ['MIT OR Apache-2.0', 'Apache-2.0'],
  },
  {
    id: 'elastic',
    name: 'Elasticsearch',
    description: 'Elasticsearch and OpenSearch, through their HTTP API',
    licenses: ['MIT OR Apache-2.0'],
  },
];

/**
 * The test database driver (built with `cargo build -p nexo-driver-test`), the PostgreSQL
 * one (`-p nexo-driver-postgres`), the SQL Server one (`-p nexo-driver-mssql`), the MySQL
 * one (`-p nexo-driver-mysql`), the SQLite one (`-p nexo-driver-sqlite`), the Redis one
 * (`-p nexo-driver-redis`), the MongoDB one (`-p nexo-driver-mongodb`), the Hive one
 * (`-p nexo-driver-hive`), the Ignite one (`-p nexo-driver-ignite`) and the Elasticsearch one
 * (`-p nexo-driver-elastic`) as downloadable
 * modules, served by a local server that
 * stands for the releases. None when the test driver is not built; `ids` lists those served.
 */
export async function moduleReleases(serverBinary, directory) {
  const built = DRIVERS.filter(({ id }) =>
    existsSync(join(dirname(serverBinary), executableName(id))),
  );
  if (!built.some(({ id }) => id === 'test')) return undefined;
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const assets = new Map();
  const entries = [];
  for (const driver of built) {
    const { entry, asset } = moduleEntry({
      ...driver,
      version,
      driver: await readFile(join(dirname(serverBinary), executableName(driver.id))),
      file: `${driver.id}.gz`,
    });
    assets.set(`/${driver.id}.gz`, asset);
    entries.push(entry);
  }
  const server = http.createServer((request, response) => {
    const asset = assets.get(request.url);
    if (!asset) return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'application/gzip' }).end(asset);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const catalog = join(directory, 'modules.json');
  await writeFile(catalog, JSON.stringify({ version, target: hostTarget(), modules: entries }));
  return {
    server,
    ids: built.map(({ id }) => id),
    environment: {
      NEXO_MODULES_CATALOG: catalog,
      NEXO_MODULES_SOURCE: `http://127.0.0.1:${server.address().port}/`,
      NEXO_MODULES_DIR: '',
    },
  };
}
