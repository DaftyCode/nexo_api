// Contract tests for MongoDB connections: what is checked before connecting, and real servers.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freePort, startServer } from './server.mjs';
import {
  environment,
  server,
  restricted,
  connect,
  document,
  plain,
  auth,
} from './mongo-fixture.mjs';

test('a connection keeps its password out of the URI it stores', async () => {
  const refused = await server.api('PUT', '/documents', document('mongodb://ana:secret@db.test'));
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Keep the password out of the connection URI/);
  const saved = await server.api('PUT', '/documents', document('mongodb://ana@db.test'));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  const listing = await server.api('GET', '/documents?workspace=local');
  assert.ok(listing.body.some((d) => d.kind === 'connection' && d.id === 'mongo-1'));
});

test('connections are checked before anything is sent', async () => {
  await assert.rejects(connect({ uri: 'postgres://db.test' }), /mongodb:\/\/ or mongodb\+srv/);
  await assert.rejects(connect({ uri: 'mongodb://{{host}}:27017' }), /\{\{host\}\}/);
  await assert.rejects(
    connect({ uri: 'mongodb://db.test/?tls=true&tlsCAFile=/etc/passwd' }),
    /does not read files named in a URI/,
  );
  await assert.rejects(
    connect({ uri: 'mongodb://db.test', tlsCAFile: '/etc/passwd' }),
    /at connection.tlsCAFile/,
  );
  await assert.rejects(connect({ uri: 'mongodb://db.test', caPem: 'x' }), /PEM format/);
  await assert.rejects(
    connect({ uri: 'mongodb://ana@db.test/?authMechanism=GSSAPI' }),
    /not supported yet|GSSAPI/,
  );
});

test('an unreachable server and an unknown name are explained', async () => {
  const port = await freePort();
  await assert.rejects(
    connect({ uri: `mongodb://127.0.0.1:${port}/?serverSelectionTimeoutMS=500` }),
    /No server answered/,
  );
  await assert.rejects(
    connect({ uri: 'mongodb+srv://cluster0.nexo-does-not-exist.invalid/' }),
    /resolve|DNS|SRV/i,
  );
});

test('the egress policy refuses private servers before connecting', async () => {
  await assert.rejects(
    connect({ uri: 'mongodb://127.0.0.1:27017/?serverSelectionTimeoutMS=500' }, restricted),
    /Nexo may not connect to 127.0.0.1:27017: .*egress policy/,
  );
});

test("a secret's allowed domains apply to every server", async () => {
  await server.api('PUT', '/secrets/mongo-scoped', {
    value: 'scoped-secret',
    allowedHosts: ['*.example.com'],
  });
  const error = await connect({
    uri: 'mongodb://ana@127.0.0.1:27017/?serverSelectionTimeoutMS=500',
    password: '{{vault:mongo-scoped}}',
  }).catch((e) => e);
  assert.match(error.message, /secret mongo-scoped cannot be sent to 127.0.0.1/);
  assert.doesNotMatch(error.message, /scoped-secret/);
});

test('a standalone server without authentication', plain, async () => {
  const report = await connect({ uri: environment.NEXO_MONGO_PLAIN });
  assert.equal(report.topology, 'standalone');
  assert.match(report.serverVersion, /^\d+\.\d+/);
  assert.equal(report.tls, false);
  assert.equal(report.authMechanism, undefined);
  assert.deepEqual(
    report.hosts.map((host) => [host.role, host.allowed]),
    [['standalone', true]],
  );
});

test('SCRAM with the password in the vault, and a wrong one', auth, async () => {
  await server.api('PUT', '/secrets/mongo-auth', { value: environment.NEXO_MONGO_PASSWORD });
  const report = await connect({
    uri: environment.NEXO_MONGO_AUTH,
    password: '{{vault:mongo-auth}}',
  });
  assert.equal(report.authMechanism, 'SCRAM');
  await server.api('PUT', '/secrets/mongo-wrong', { value: 'wrong-password-value' });
  const error = await connect({
    uri: environment.NEXO_MONGO_AUTH,
    password: '{{vault:mongo-wrong}}',
  }).catch((e) => e);
  assert.match(error.message, /Authentication failed/);
  assert.doesNotMatch(error.message, /wrong-password-value/);
});

test('TLS: the CA is needed to trust the server, and X.509 signs in', auth, async () => {
  const tlsUri = `${environment.NEXO_MONGO_AUTH}&tls=true&serverSelectionTimeoutMS=2000`;
  await assert.rejects(
    connect({ uri: tlsUri, password: environment.NEXO_MONGO_PASSWORD }),
    /certificate is not trusted/,
  );
  const caPem = await readFile(environment.NEXO_MONGO_CA, 'utf8');
  const report = await connect({ uri: tlsUri, password: environment.NEXO_MONGO_PASSWORD, caPem });
  assert.equal(report.tls, true);
  // Any certificate, when the person allows it.
  const insecure = await connect({
    uri: `${tlsUri}&tlsAllowInvalidCertificates=true`,
    password: environment.NEXO_MONGO_PASSWORD,
  });
  assert.equal(insecure.tls, true);
  const [certPem, keyPem] = await Promise.all([
    readFile(environment.NEXO_MONGO_CLIENT_CERT, 'utf8'),
    readFile(environment.NEXO_MONGO_CLIENT_KEY, 'utf8'),
  ]);
  const host = new URL(environment.NEXO_MONGO_AUTH.replace('mongodb://', 'http://')).host;
  const x509 = await connect({
    uri: `mongodb://${host}/?authMechanism=MONGODB-X509&tls=true`,
    caPem,
    certPem,
    keyPem,
  });
  assert.equal(x509.authMechanism, 'MONGODB-X509');
});

test('a replica set lists its members', { skip: !environment.NEXO_MONGO_REPLICA_SET }, async () => {
  const report = await connect({ uri: environment.NEXO_MONGO_REPLICA_SET });
  assert.equal(report.topology, 'replicaSet');
  assert.equal(report.replicaSet, 'rs0');
  assert.equal(report.direct, false);
  assert.deepEqual(
    report.hosts.map((host) => [host.role, host.allowed]),
    [['primary', true]],
  );
  // Under a restrictive policy the members are asked for and checked before the driver
  // contacts them; allowed ones keep the replica set.
  const allowed = await startServer({
    NEXO_EGRESS: 'deny-private',
    NEXO_EGRESS_ALLOW: '127.0.0.1',
  });
  try {
    const checked = await connect({ uri: environment.NEXO_MONGO_REPLICA_SET }, allowed);
    assert.equal(checked.topology, 'replicaSet');
    assert.equal(checked.direct, false);
  } finally {
    await allowed.stop();
  }
});

test('FerretDB is a compatible server', { skip: !environment.NEXO_MONGO_FERRETDB }, async () => {
  const report = await connect({
    uri: environment.NEXO_MONGO_FERRETDB,
    password: environment.NEXO_MONGO_PASSWORD,
  });
  assert.equal(report.flavor, 'FerretDB');
});
