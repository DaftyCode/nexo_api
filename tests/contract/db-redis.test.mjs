// Contract tests of the Redis module through Nexo, against the Redis and Valkey of
// tools/nosql-fixture.sh: the driver runs as its own process, on connections saved in the
// workspace with their password in the vault. Without the servers they are skipped.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_REDIS_HOST ? false : 'start tools/nosql-fixture.sh';
let server;
/** A saved connection to the fixture's Redis (`REDIS`) or Valkey (`VALKEY`). */
const connection = (id, flavour, value = {}) => ({
  id,
  workspace_id: 'local',
  kind: 'connection',
  name: `Redis ${id}`,
  revision: 0,
  updated_at: 0,
  value: {
    driver: 'redis',
    host: environment.NEXO_REDIS_HOST,
    port: Number(environment[`NEXO_${flavour}_PORT`]),
    database: '1',
    user: environment.NEXO_REDIS_USER,
    password: '{{vault:db-password:redis}}',
    ...value,
  },
});
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  await server.api('PUT', '/secrets/db-password:redis', {
    value: environment.NEXO_REDIS_PASSWORD,
  });
  for (const document of [
    connection('rd', 'REDIS'),
    connection('vk', 'VALKEY'),
    connection('rd-read', 'REDIS', { readOnly: true }),
  ])
    assert.equal((await server.api('PUT', '/documents', document)).status, 200);
});
after(async () => {
  await server?.stop();
});

const connect = (id, session) =>
  server.execute('db.connect', { workspace: 'local', connectionId: id, session });
const kv = (operation, session, payload) =>
  server.api('POST', `/execute/${operation}`, { workspace: 'local', session, ...payload });

test('the Redis module answers through Nexo, for Redis and Valkey', { skip }, async () => {
  for (const [id, product] of [
    ['rd', /^Redis/],
    ['vk', /^Valkey/],
  ]) {
    const session = `${id}-1`;
    const opened = await connect(id, session);
    assert.match(opened.product, product);
    assert.equal(opened.database, 'db1');
    const set = await kv('db.kv.command', session, { line: 'SET "contract key" "it\'s"' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const found = await kv('db.kv.scan', session, { pattern: 'contract*' });
    assert.deepEqual(
      found.body.keys.map((key) => key.key),
      ['contract key'],
    );
    const value = await kv('db.kv.get', session, { key: 'contract key' });
    assert.equal(value.body.value, "it's");
    const changed = await kv('db.kv.write', session, {
      key: 'contract key',
      action: 'set',
      value: { $t: 'binary', v: '/wA=' },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const binary = await kv('db.kv.get', session, { key: 'contract key' });
    assert.deepEqual(binary.body.value, { $t: 'binary', v: '/wA=' });
    // The database of the session, and the password never in an answer.
    const tree = await server.execute('db.tree', { session, path: [] });
    assert.ok(tree.nodes.some((node) => node.name === 'db1'));
    const config = await kv('db.kv.command', session, { line: 'ACL WHOAMI' });
    assert.equal(config.body.reply, environment.NEXO_REDIS_USER);
  }
  const driver = await server.execute('db.dialect', { driver: 'redis' });
  assert.deepEqual(driver.capabilities.extensions, ['keyvalue']);
});

test('FLUSHDB runs only with its name typed, also through the API', { skip }, async () => {
  await connect('rd', 'rd-2');
  await kv('db.kv.command', 'rd-2', { line: 'SET flush:me 1' });
  const refused = await kv('db.kv.command', 'rd-2', { line: 'FLUSHDB', confirm: true });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Type FLUSHDB to confirm it/);
  const kept = await kv('db.kv.command', 'rd-2', { line: 'EXISTS flush:me' });
  assert.equal(kept.body.reply, 1);
  const typed = await kv('db.kv.command', 'rd-2', { line: 'FLUSHDB', confirmName: 'FLUSHDB' });
  assert.equal(typed.body.reply, 'OK');
  const gone = await kv('db.kv.command', 'rd-2', { line: 'EXISTS flush:me' });
  assert.equal(gone.body.reply, 0);
});

test('a read-only connection refuses SET, in the console and in the sheet', { skip }, async () => {
  await connect('rd-read', 'rd-3');
  const set = await kv('db.kv.command', 'rd-3', { line: 'SET k v' });
  assert.match(set.body.error, /read-only/);
  const write = await kv('db.kv.write', 'rd-3', { key: 'k', action: 'set', value: 'v' });
  assert.match(write.body.error, /read-only/);
  const read = await kv('db.kv.command', 'rd-3', { line: 'DBSIZE' });
  assert.equal(read.status, 200);
  assert.doesNotMatch(server.logs(), new RegExp(environment.NEXO_REDIS_PASSWORD));
});

test('a message published reaches the subscription of the realtime panel', { skip }, async () => {
  const opened = await server.execute('db.kv.subscribe', {
    workspace: 'local',
    connectionId: 'vk',
    channels: ['news'],
  });
  assert.match(opened.id, /^redis-sub-\d+\.s\d+$/);
  await connect('vk', 'vk-2');
  await kv('db.kv.command', 'vk-2', { line: 'PUBLISH news hello' });
  let events = [];
  for (let attempt = 0; attempt < 40 && !events.length; attempt++) {
    await new Promise((done) => setTimeout(done, 100));
    const read = await server.execute('realtime.poll', { workspace: 'local', id: opened.id });
    events = read.events;
  }
  assert.deepEqual(events[0].data, { channel: 'news', pattern: null, payload: 'hello' });
  const listed = await server.execute('realtime.list', { workspace: 'local' });
  assert.ok(listed.some((entry) => entry.id === opened.id && entry.protocol === 'redis'));
  await server.execute('realtime.close', { workspace: 'local', id: opened.id });
});
