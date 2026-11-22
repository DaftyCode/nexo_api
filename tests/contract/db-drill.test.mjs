// Contract tests of the Drill module through Nexo, against the embedded Drillbit of
// tools/nosql-fixture.sh: the driver runs as its own process on a connection saved in the
// workspace. Without the Drillbit they are skipped.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
const skip = environment.NEXO_DRILL_HOST ? false : 'start tools/nosql-fixture.sh';
let server;
before(async () => {
  if (skip) return;
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  const document = {
    id: 'dr',
    workspace_id: 'local',
    kind: 'connection',
    name: 'Drill',
    revision: 0,
    updated_at: 0,
    value: {
      driver: 'drill',
      host: environment.NEXO_DRILL_HOST,
      port: Number(environment.NEXO_DRILL_PORT),
    },
  };
  assert.equal((await server.api('PUT', '/documents', document)).status, 200);
});
after(async () => {
  await server?.stop();
});

const run = (session, sql) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
  });

test('the Drill module answers through Nexo', { skip }, async () => {
  const opened = await server.execute('db.connect', {
    workspace: 'local',
    connectionId: 'dr',
    session: 'dr-1',
  });
  assert.match(opened.product, /^Apache Drill/);
  const plugins = await server.execute('db.tree', { session: 'dr-1', path: [] });
  assert.ok(plugins.nodes.some((node) => node.name === 'dfs'));
  const nation = await run(
    'dr-1',
    'SELECT N_NAME FROM dfs.`/opt/drill/sample-data/nation.parquet` WHERE N_NATIONKEY = 0',
  );
  assert.equal(nation.status, 200, JSON.stringify(nation.body));
  assert.deepEqual(nation.body.rows, [['ALGERIA']]);
  const sheet = await server.execute('db.describe', { session: 'dr-1', path: ['secretmongo'] });
  assert.doesNotMatch(JSON.stringify(sheet), /s3cret-pass/);
  const plan = await server.api('POST', '/execute/db.explain', {
    workspace: 'local',
    session: 'dr-1',
    statement: 'p',
    sql: 'SELECT * FROM cp.`employee.json`',
    mode: 'estimated',
  });
  assert.equal(plan.status, 200, JSON.stringify(plan.body));
  assert.match(plan.body.original, /Screen/);
});
