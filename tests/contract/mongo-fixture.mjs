// Contract tests for MongoDB connections. Those that need real servers run when they are
// configured (CI starts them with `tools/mongo-fixture.sh`) and are skipped otherwise:
//   NEXO_MONGO_PLAIN          standalone without authentication, with the data of
//                             tools/mongo-fixture-seed.js
//   NEXO_MONGO_AUTH           SCRAM user without its password, which is NEXO_MONGO_PASSWORD;
//                             TLS with the CA NEXO_MONGO_CA and X.509 with NEXO_MONGO_CLIENT_CERT
//                             and NEXO_MONGO_CLIENT_KEY (PEM files)
//   NEXO_MONGO_REPLICA_SET    a replica set
//   NEXO_MONGO_FERRETDB       FerretDB, with NEXO_MONGO_PASSWORD
//
// Shared setup of the MongoDB contract tests: the servers, connections and saved connections.
// The files run one after another (tools/contract-tests.mjs), as they share these servers.
import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

export const environment = process.env;
export let server;
export let restricted;
before(async () => {
  [server, restricted] = await Promise.all([
    startServer(),
    startServer({ NEXO_EGRESS: 'deny-private' }),
  ]);
});
after(async () => {
  await Promise.all([server?.stop(), restricted?.stop()]);
});

export const connect = (connection, on = server) => on.execute('mongo.test', { connection });
export const document = (uri) => ({
  id: 'mongo-1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local MongoDB',
  revision: 0,
  updated_at: 0,
  value: { uri, password: '{{vault:mongo-local}}' },
});

export const plain = { skip: !environment.NEXO_MONGO_PLAIN };
export const auth = { skip: !environment.NEXO_MONGO_AUTH };

// The explorer and queries, against the data of tools/mongo-fixture-seed.js.
export const seeded = { uri: environment.NEXO_MONGO_PLAIN };
export const big = { connection: seeded, database: 'nexo', collection: 'big' };
export let queries = 0;
export const find = (query) =>
  server.execute('mongo.find', { ...big, id: `q${++queries}`, ...query });

export const saveConnection = async (id, value) => {
  const saved = await server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind: 'connection',
    name: id,
    revision: 0,
    updated_at: 0,
    value,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
};
