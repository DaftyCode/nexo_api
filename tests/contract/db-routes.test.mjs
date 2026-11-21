// Contract tests of how a database connection reaches its server (DB-25): a PostgreSQL that
// only the fixture's SSH bastion reaches is browsed through the bastion's tunnel, its TLS
// checked against its own name; a server key Nexo does not trust, or one that changed,
// blocks it; a SOCKS5 proxy that alone knows the server's name takes another, with its
// password from the vault; and «Test the tunnel» reaches the server without a session.
// They need tools/sql-fixture.sh and are skipped without it.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';
import { dbClient } from './db-client.mjs';
import { socksProxy } from './socks-fixture.mjs';

const environment = process.env;
const bastion = environment.NEXO_SQL_BASTION_HOST ? false : 'start tools/sql-fixture.sh';
const postgres = environment.NEXO_SQL_PG_HOST ? false : 'start tools/sql-fixture.sh';
let server;
const { save, connect, run, call, ok } = dbClient(() => server);

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
});
after(async () => {
  await server?.stop();
});

/** A key that is not the bastion's, written as if Nexo had trusted it before. */
const OTHER_KEY =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN3axYbMfYmEwWSsx+Wfpg2cCMXksfIoGojgpuuFNLyH';

test(
  'a server only the bastion reaches is browsed through its tunnel, TLS checked by name',
  {
    skip: bastion,
  },
  async () => {
    const bastionPort = Number(environment.NEXO_SQL_BASTION_PORT);
    await server.api('PUT', '/secrets/ssh-password:p1', {
      value: environment.NEXO_SQL_BASTION_PASSWORD,
    });
    await server.api('PUT', '/secrets/db-password:hidden', {
      value: environment.NEXO_SQL_PG_PASSWORD,
    });
    const profile = await server.api('PUT', '/documents', {
      id: 'p1',
      workspace_id: 'local',
      kind: 'ssh-profile',
      name: 'Bastion',
      revision: 0,
      updated_at: 0,
      value: {
        host: environment.NEXO_SQL_BASTION_HOST,
        port: bastionPort,
        username: environment.NEXO_SQL_BASTION_USER,
        auth: 'password',
        secret: 'ssh-password:p1',
      },
    });
    assert.equal(profile.status, 200, JSON.stringify(profile.body));
    const saved = await save('hidden', {
      driver: 'postgres',
      host: environment.NEXO_SQL_HIDDEN_HOST,
      port: Number(environment.NEXO_SQL_HIDDEN_PORT),
      database: environment.NEXO_SQL_PG_DATABASE,
      user: environment.NEXO_SQL_PG_USER,
      password: '{{vault:db-password:hidden}}',
      tls: { mode: 'verify', caPem: await readFile(environment.NEXO_SQL_PG_CA, 'utf8') },
      route: { via: 'ssh', profile: 'p1' },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    // A server Nexo has not trusted yet: nothing goes through it.
    const unknown = await call('db.connect', { connectionId: 'hidden', session: 'h0' });
    assert.equal(unknown.status, 400);
    assert.match(unknown.body.error, /is not trusted yet/);
    const shown = await ok('ssh.test', { profile: 'p1' });
    assert.equal(shown.trusted, false);
    // A key that is not the one trusted before blocks the connection.
    const known = join(server.directory, 'ssh');
    await mkdir(known, { recursive: true });
    const algorithm = shown.algorithm;
    assert.equal(algorithm, 'ssh-ed25519', 'the bastion shows its ed25519 key first');
    await writeFile(join(known, 'known_hosts'), `[127.0.0.1]:${bastionPort} ${OTHER_KEY}\n`);
    const changed = await call('db.connect', { connectionId: 'hidden', session: 'h0' });
    assert.match(changed.body.error, /changed to .* the connection is blocked/);
    await rm(join(known, 'known_hosts'));
    await ok('ssh.trust', { host: '127.0.0.1', port: bastionPort, fingerprint: shown.fingerprint });

    // Trusted: the server is reached by its name, which only the bastion knows, and its
    // certificate is checked against that name although the driver dials a loopback port.
    const tested = await ok('db.test', { connectionId: 'hidden' });
    assert.equal(tested.server.tls, true);
    const [reached] = tested.servers;
    assert.equal(reached.host, 'db.internal');
    assert.equal(reached.allowed, true);
    assert.match(reached.addresses[0], /^127\.0\.0\.1:\d+$/);
    const tunnel = await ok('db.route.test', { connectionId: 'hidden' });
    assert.equal(tunnel.via, 'ssh');
    assert.equal(tunnel.host, 'db.internal');
    await connect('hidden', 'h1');
    const tree = await ok('db.tree', { session: 'h1', path: [] });
    assert.ok(tree.nodes.some((node) => node.name === environment.NEXO_SQL_PG_DATABASE));
    const rows = await run(
      'h1',
      "SELECT count(*) AS n, current_setting('ssl') AS ssl FROM public.every_type",
    );
    assert.equal(rows.rows[0][1], 'on');
    // A second session reuses the bastion's session and opens its own forwarded port.
    await connect('hidden', 'h2');
    assert.deepEqual((await run('h2', 'SELECT 1 AS one')).rows, [[1]]);
    await ok('db.disconnect', { session: 'h1' });
    await ok('db.disconnect', { session: 'h2' });
  },
);

test(
  'a SOCKS5 proxy that alone knows the server takes the connection, its password kept',
  {
    skip: postgres,
  },
  async () => {
    const proxy = await socksProxy('proxy-pw', () => ({
      'db.socks': Number(environment.NEXO_SQL_PG_PORT),
    }));
    try {
      await server.api('PUT', '/secrets/db-password:viasocks', {
        value: environment.NEXO_SQL_PG_PASSWORD,
      });
      await server.api('PUT', '/secrets/db-proxy:viasocks', { value: 'proxy-pw' });
      const route = {
        via: 'socks5',
        host: '127.0.0.1',
        port: proxy.port,
        username: 'ana',
        password: '{{vault:db-proxy:viasocks}}',
        remoteDns: true,
      };
      const connection = {
        driver: 'postgres',
        host: 'db.socks',
        port: 5432,
        database: environment.NEXO_SQL_PG_DATABASE,
        user: environment.NEXO_SQL_PG_USER,
        password: '{{vault:db-password:viasocks}}',
        route,
      };
      // Its password is never kept in the connection, as the database's.
      const clear = await save('viasocks', { ...connection, route: { ...route, password: 'x' } });
      assert.equal(clear.status, 400);
      assert.match(clear.body.error, /password of the proxy/);
      assert.equal((await save('viasocks', connection)).status, 200);
      await connect('viasocks', 's1');
      assert.deepEqual((await run('s1', 'SELECT 2 AS two')).rows, [[2]]);
      assert.ok(proxy.asked.includes('user ana'), proxy.asked.join());
      assert.ok(proxy.asked.includes('db.socks:5432'), proxy.asked.join());
      const tunnel = await ok('db.route.test', { connectionId: 'viasocks' });
      assert.equal(tunnel.via, 'socks5');
      await ok('db.disconnect', { session: 's1' });

      // A wrong password of the proxy is said, without the password.
      await server.api('PUT', '/secrets/db-proxy:viasocks', { value: 'wrong-pw' });
      const refused = await call('db.connect', { connectionId: 'viasocks', session: 's2' });
      assert.equal(refused.status >= 400, true);
      assert.doesNotMatch(JSON.stringify(refused.body), /wrong-pw/);
      // A direct connection has no tunnel to test.
      await save('direct', { ...connection, route: { via: 'direct' } });
      const direct = await call('db.route.test', { connectionId: 'direct' });
      assert.match(direct.body.error, /goes straight to its server/);
    } finally {
      proxy.close();
    }
  },
);
