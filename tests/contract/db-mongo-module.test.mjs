// Contract tests of MongoDB as a module (DB-39) when the module is not installed: an
// operation, and a script with `nx.mongo` (which never downloads modules), say how to get
// it. No MongoDB server is needed: nothing is sent anywhere.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';

let server;
let modules;
let api;
before(async () => {
  // An empty folder of modules: no driver is installed.
  modules = await mkdtemp(join(tmpdir(), 'nexo-no-modules-'));
  server = await startServer({ NEXO_MODULES_DIR: modules, NEXO_MODULES_CATALOG: '' });
  api = http.createServer((_, response) => response.end('{}'));
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
});
after(async () => {
  api?.close();
  await server?.stop();
  if (modules) await rm(modules, { recursive: true, force: true });
});

const missing = /MongoDB is now a downloadable module, and it is not installed/;

test('without its module, MongoDB says how to get it', async () => {
  await assert.rejects(
    server.execute('mongo.databases', { connection: { uri: 'mongodb://127.0.0.1:9/' } }),
    missing,
  );
  await assert.rejects(
    server.execute('mongo.test', { connection: { uri: 'mongodb://127.0.0.1:9/' } }),
    missing,
  );
});

test('a script with nx.mongo does not download the module: it says why it fails', async () => {
  const saved = await server.api('PUT', '/documents', {
    id: 'shop',
    workspace_id: 'local',
    kind: 'connection',
    name: 'Shop',
    revision: 0,
    updated_at: 0,
    // Saved as versions before MongoDB was a module saved it: only its URI.
    value: { uri: 'mongodb://127.0.0.1:9/' },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const result = await server.execute('request', {
    item: {
      name: 'Read',
      request: { method: 'GET', url: `http://127.0.0.1:${api.address().port}/` },
      event: [
        {
          listen: 'prerequest',
          script: {
            exec: [
              "nx.mongo('Shop').db('a').collection('b').findOne({}).catch((e) => pm.environment.set('why', e.message));",
            ],
          },
        },
      ],
    },
  });
  const why = result.variables.environment.values.find((row) => row.key === 'why')?.value;
  assert.match(why ?? '', missing);
});
