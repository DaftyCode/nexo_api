// Contract tests of the imports from other API clients (B-07): an export of Insomnia,
// Bruno, Hoppscotch and Thunder Client, with folders, authorization, variables and bodies,
// is imported and its requests are sent as the tool would send them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { until } from './server.mjs';
import { server, echo } from './http-fixture.mjs';

const fixtures = fileURLToPath(
  new URL('../../backend/crates/nexo-engine/src/interchange/tools/fixtures/', import.meta.url),
);

/** A fixture with its servers pointing at the echo server. */
async function fixture(name, ...hosts) {
  let content = await readFile(join(fixtures, name), 'utf8');
  for (const host of hosts) content = content.replaceAll(host, echo.url);
  return content;
}

/** Runs a collection; its results by request name, with the echo's answer parsed. */
async function run(collection, variables = []) {
  const started = await server.execute('run', { collection, variables });
  const done = await until(async () => {
    const current = await server.execute('run', { action: 'status', id: started.id });
    return current.state !== 'running' && current;
  });
  return Object.fromEntries(
    done.results.map((result) => [
      result.name,
      {
        ...result,
        get echo() {
          assert.ok(result.body, `${result.name}: ${result.error ?? result.status}`);
          return JSON.parse(result.body);
        },
      },
    ]),
  );
}

const basic = (credentials) => `Basic ${Buffer.from(credentials).toString('base64')}`;

test('an Insomnia v4 export sends with its folder authorization and environment', async () => {
  const imported = await server.execute('import', {
    content: await fixture('insomnia-v4.json', 'https://shop.example.com', 'http://localhost:8080'),
  });
  assert.equal(imported.report.source, 'insomnia');
  assert.equal(imported.more[0].name, 'Development');
  const sent = await run(imported.value, imported.more[0].value.values);
  assert.equal(sent['List users'].echo.path, '/users?page=2');
  assert.equal(sent['List users'].echo.authorization, 'Bearer dev-token');
  const created = sent['Create user'].echo;
  assert.equal(created.authorization, basic('ana:secret'));
  assert.match(created.body, /"name": "Ana"/);
  assert.match(created.body, /\{% now 'iso-8601', '' %\}/, 'template tags stay as text');
  assert.equal(sent['Log in'].echo.body, 'user=ana');
  assert.equal(sent['Log in'].echo.authorization, null);
  assert.deepEqual(JSON.parse(sent.Products.echo.body).variables, { first: 3 });
});

test('an Insomnia 11 collection (v5 YAML) sends with its sub-environment', async () => {
  const imported = await server.execute('import', {
    content: await fixture(
      'insomnia-v5.yaml',
      'https://staging.orders.example.com',
      'https://orders.example.com',
    ),
  });
  const sent = await run(imported.value, imported.more[0].value.values);
  assert.equal(sent.Health.status, 200);
  const order = sent['Get order'].echo;
  assert.equal(order.path, '/orders/41?expand=items');
  assert.match(order.authorization, /^AWS4-HMAC-SHA256 /);
});

/** The files of a folder, as the interface sends them. */
async function folderFiles(folder, root = folder) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) files.push(...(await folderFiles(path, root)));
    else
      files.push({
        path: `pet-store/${relative(root, path).replaceAll('\\', '/')}`,
        content: (await readFile(path, 'utf8')).replaceAll('http://localhost:3000', echo.url),
      });
  }
  return files;
}

test('a Bruno collection folder sends with what its collection and folders set', async () => {
  const imported = await server.execute('import', {
    content: '',
    files: await folderFiles(join(fixtures, 'bruno')),
  });
  assert.equal(imported.report.source, 'bruno');
  const local = imported.more.find((document) => document.name === 'Local').value.values;
  const sent = await run(imported.value, [
    ...local.filter((row) => row.key !== 'token'),
    { key: 'token', value: 't1', enabled: true },
    { key: 'password', value: 'pw', enabled: true },
  ]);
  const user = sent['Get user'].echo;
  assert.equal(user.path, '/users/7?fields=name');
  assert.equal(user.authorization, 'Bearer t1', 'the collection’s, through the folder');
  const created = sent['Create user'].echo;
  assert.equal(created.authorization, basic('admin:pw'));
  assert.deepEqual(JSON.parse(created.body), { name: 'Rex', tags: ['dog'] });
});

test('a Hoppscotch collection sends with its variables written as Nexo’s', async () => {
  const environments = await server.execute('import', {
    content: await fixture('hoppscotch-environments.json', 'http://localhost:4000'),
  });
  const imported = await server.execute('import', {
    content: await fixture('hoppscotch-collections.json'),
  });
  const sent = await run(imported.value, environments.value.values);
  assert.equal(sent['List books'].echo.path, '/books?author=Herbert');
  assert.equal(sent['List books'].echo.authorization, 'Bearer abc');
  const added = sent['Add book'].echo;
  assert.deepEqual(JSON.parse(added.body), { title: 'Dune' }, 'its request variable is set');
  assert.equal(added.authorization, null, 'the folder’s API key replaces the bearer token');
});

test('a Thunder Client collection sends with its path parameters and folder settings', async () => {
  const environment = await server.execute('import', {
    content: await fixture('thunder-environment.json', 'http://localhost:5000'),
  });
  assert.equal(environment.kind, 'environment');
  const imported = await server.execute('import', {
    content: await fixture('thunder-collection.json'),
  });
  const sent = await run(imported.value, [
    ...environment.value.values,
    { key: 'adminPassword', value: 'pw', enabled: true },
  ]);
  assert.equal(sent.Forecast.echo.path, '/cities/madrid/forecast?days=3');
  assert.equal(sent.Forecast.echo.authorization, 'Bearer local-token');
  const station = sent['Add station'].echo;
  assert.equal(station.authorization, basic('root:pw'), 'the folder’s, inherited');
  assert.match(station.body, /"at": \d{10}/, 'the timestamp of {{#timestamp}}');
});
