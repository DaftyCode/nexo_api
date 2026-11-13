// Contract tests of the downloadable database modules: listed from the manifest, downloaded
// from where it says, installed only when the hashes match, from a chosen file too, and
// removed. The modules are the test driver, served by a local server that stands for the
// releases; 127.0.0.1 and localhost name it twice, to test a redirection to another host.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer, until } from './server.mjs';
import { executableName, hostTarget, moduleEntry } from '../../tools/modules/manifest.mjs';

const driverPath = resolve(
  process.env.CARGO_TARGET_DIR ?? 'target',
  'debug',
  executableName('test'),
);
let server;
let releases;
let folder;
let driver;
let asset;
before(async () => {
  driver = await readFile(driverPath);
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const entry = (id, name) =>
    moduleEntry({ id, name, version, driver, file: `${id}.gz`, licenses: ['MIT', 'Apache-2.0'] });
  const good = entry('test', 'Test database');
  asset = good.asset;
  const modules = [
    good,
    entry('broken', 'Broken'),
    entry('moved', 'Moved'),
    entry('missing', 'Missing'),
  ];
  // What the releases serve: the right file, a changed one, a redirection and nothing.
  const files = new Map([
    ['/test.gz', good.asset],
    [
      '/broken.gz',
      Buffer.concat([asset.subarray(0, asset.length - 1), Buffer.from([asset.at(-1) ^ 1])]),
    ],
  ]);
  releases = http.createServer((request, response) => {
    if (request.url === '/moved.gz') {
      const port = releases.address().port;
      response.writeHead(302, { location: `http://localhost:${port}/test.gz` });
      return response.end();
    }
    const file = files.get(request.url);
    if (!file) {
      response.writeHead(404);
      return response.end();
    }
    response.writeHead(200, { 'content-type': 'application/gzip' });
    response.end(file);
  });
  await new Promise((done) => releases.listen(0, '127.0.0.1', done));
  folder = await mkdtemp(join(tmpdir(), 'nexo-modules-'));
  const catalog = join(folder, 'modules.json');
  const manifest = { version, target: hostTarget(), modules: modules.map((m) => m.entry) };
  await writeFile(catalog, JSON.stringify(manifest));
  server = await startServer({
    NEXO_MODULES_CATALOG: catalog,
    NEXO_MODULES_SOURCE: `http://127.0.0.1:${releases.address().port}/`,
    NEXO_MODULES_DIR: '',
  });
});
after(async () => {
  await server?.stop();
  releases?.closeAllConnections();
  await new Promise((done) => (releases ? releases.close(done) : done()));
  if (folder) await rm(folder, { recursive: true, force: true });
});

const modules = () => server.execute('modules.list');
const state = async (id) => (await modules()).find((module) => module.id === id)?.state;
/** Installs a module and waits until it is installed or failed. */
async function install(id) {
  const started = await server.execute('modules.install', { id });
  assert.equal(started.id, id);
  return until(async () => {
    const progress = await server.execute('modules.progress', { id });
    return ['installed', 'failed'].includes(progress.state) && progress;
  });
}
const installedDriver = () => join(server.directory, 'modules', 'test');

test('lists the modules of the manifest with what they are', async () => {
  const listed = await modules();
  assert.deepEqual(
    listed.map((module) => [module.id, module.state]),
    [
      ['broken', 'available'],
      ['missing', 'available'],
      ['moved', 'available'],
      ['test', 'available'],
    ],
  );
  const test = listed.find((module) => module.id === 'test');
  assert.equal(test.name, 'Test database');
  assert.equal(test.downloadSize, asset.length);
  assert.equal(test.size, driver.length);
  assert.deepEqual(test.licenses, ['MIT', 'Apache-2.0']);
  assert.match(test.source, /^http:\/\/127\.0\.0\.1:\d+\/test\.gz$/);
  assert.equal(test.bundled, false);
  assert.equal((await server.execute('modules.progress', { id: 'test' })).state, 'idle');
});

test('downloads, checks and installs a module, and removes it', async () => {
  const progress = await install('test');
  assert.equal(progress.state, 'installed', progress.error);
  assert.equal(progress.received, asset.length);
  assert.equal(await state('test'), 'installed');
  const version = JSON.parse(await readFile('package.json', 'utf8')).version;
  const path = join(installedDriver(), version, executableName('test'));
  assert.deepEqual(await readFile(path), driver);

  await server.execute('modules.remove', { id: 'test' });
  assert.equal(await state('test'), 'available');
  assert.equal(existsSync(installedDriver()), false);
});

test('a changed file, another host or a missing file installs nothing', async () => {
  for (const [id, reason] of [
    ['broken', /not the one this version of Nexo expects/],
    ['moved', /redirected to localhost/],
    ['missing', /404/],
  ]) {
    const progress = await install(id);
    assert.equal(progress.state, 'failed', id);
    assert.match(progress.error, reason);
    assert.equal(await state(id), 'available');
    assert.equal(existsSync(join(server.directory, 'modules', id)), false);
  }
});

test('installs a module from a file the person chose, recognised by its hash', async () => {
  const installed = await server.execute('modules.install.file', {
    content: asset.toString('base64'),
  });
  assert.equal(installed.id, 'test');
  assert.equal(installed.state, 'installed');
  await server.execute('modules.remove', { id: 'test' });
  // The driver itself is accepted too.
  const raw = await server.execute('modules.install.file', { content: driver.toString('base64') });
  assert.equal(raw.state, 'installed');
  await server.execute('modules.remove', { id: 'test' });

  await assert.rejects(
    server.execute('modules.install.file', {
      content: Buffer.from('a program').toString('base64'),
    }),
    /This file is not a module of Nexo .* for this computer/,
  );
  await assert.rejects(
    server.execute('modules.install.file', { content: '%%%' }),
    /not valid base64/,
  );
});

test('refuses unknown modules and incomplete requests', async () => {
  await assert.rejects(
    server.execute('modules.install', { id: 'oracle' }),
    /There is no oracle module/,
  );
  await assert.rejects(server.execute('modules.install', {}), /missing field `id`/);
  await assert.rejects(server.execute('modules.remove', { id: '../test' }), /Invalid module name/);
});
