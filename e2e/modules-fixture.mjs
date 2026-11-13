// The test database driver as a downloadable module for the end-to-end tests.
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { executableName, hostTarget, moduleEntry } from '../tools/modules/manifest.mjs';

/**
 * The test database driver as a downloadable module, served by a local server that stands
 * for the releases (built with `cargo build -p nexo-driver-test`); none when it is not built.
 */
export async function moduleReleases(serverBinary, directory) {
  const driver = join(dirname(serverBinary), executableName('test'));
  if (!existsSync(driver)) return undefined;
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const { entry, asset } = moduleEntry({
    id: 'test',
    name: 'Test database',
    description: 'A database in memory, for the tests',
    version,
    driver: await readFile(driver),
    file: 'test.gz',
    licenses: ['MIT OR Apache-2.0'],
  });
  const server = http.createServer((request, response) => {
    if (request.url !== '/test.gz') return response.writeHead(404).end();
    response.writeHead(200, { 'content-type': 'application/gzip' }).end(asset);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const catalog = join(directory, 'modules.json');
  await writeFile(catalog, JSON.stringify({ version, target: hostTarget(), modules: [entry] }));
  return {
    server,
    environment: {
      NEXO_MODULES_CATALOG: catalog,
      NEXO_MODULES_SOURCE: `http://127.0.0.1:${server.address().port}/`,
      NEXO_MODULES_DIR: '',
    },
  };
}
