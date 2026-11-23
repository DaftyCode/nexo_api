// The database drivers built for the tests, as downloadable modules for the end-to-end tests.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { executableName, hostTarget, moduleEntry } from '../tools/modules/manifest.mjs';

/** Where the packed drivers are kept between workers and runs. */
const CACHE = join(tmpdir(), 'nexo-e2e-modules');

/**
 * A built driver packed as a module. A debug build on Linux carries its debug information
 * (hundreds of megabytes for all of them), so it is packed at gzip's fastest level and kept by
 * its size and time: only the first worker after a build packs it, and an older packing of the
 * same driver is removed.
 */
async function packed(driver, version, path) {
  const { size, mtimeMs } = await stat(path);
  const name = `${driver.id}-${version}-${size}-${Math.trunc(mtimeMs)}`;
  const key = join(CACHE, name);
  try {
    // The entry is written after its asset: with the entry there, the asset is whole.
    const entry = JSON.parse(await readFile(`${key}.json`, 'utf8'));
    return { entry, asset: await readFile(`${key}.gz`) };
  } catch {
    const made = moduleEntry({
      ...driver,
      version,
      driver: await readFile(path),
      file: `${driver.id}.gz`,
      level: 1,
    });
    await mkdir(CACHE, { recursive: true });
    for (const old of await readdir(CACHE)) {
      if (old.startsWith(`${driver.id}-`) && !old.startsWith(name)) {
        await rm(join(CACHE, old), { force: true });
      }
    }
    await writeFile(`${key}.gz`, made.asset);
    await writeFile(`${key}.json`, JSON.stringify(made.entry));
    return made;
  }
}

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
    const path = join(dirname(serverBinary), executableName(driver.id));
    const { entry, asset } = await packed(driver, version, path);
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
