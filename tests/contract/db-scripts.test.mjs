// Contract tests for `nx.sql` (DB-32) on the SQLite module: a request to an API that writes a
// row, and a test script that finds it with bound parameters, checks its values and deletes
// it. The script names saved connections only: a read-only one refuses `execute`, a missing
// one is explained, what asks for a confirmation needs it, and a transaction left open when
// the script ends is undone.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from './server.mjs';

const environment = process.env;
let server;
let folder;
let api;
let base;
const save = (id, value) =>
  server.api('PUT', '/documents', {
    id,
    workspace_id: 'local',
    kind: 'connection',
    name: id,
    revision: 0,
    updated_at: 0,
    value: { driver: 'sqlite', ...value },
  });
const run = (session, sql, params = [], extra = {}) =>
  server.api('POST', '/execute/db.execute', {
    workspace: 'local',
    session,
    statement: `q-${Math.random()}`,
    sql,
    params,
    ...extra,
  });

before(async () => {
  server = await startServer({
    NEXO_MODULES_DIR: resolve(environment.CARGO_TARGET_DIR ?? 'target', 'debug'),
    NEXO_MODULES_CATALOG: '',
  });
  folder = await mkdtemp(join(tmpdir(), 'nexo-sql-scripts-'));
  const file = join(folder, 'shop.db');
  // The file is written with a variable, which the script's environment fills.
  assert.equal(
    (await save('shop', { database: '{{shopFolder}}/shop.db', params: { create: 'true' } })).status,
    200,
  );
  assert.equal((await save('shop-reader', { database: file, readOnly: true })).status, 200);
  await server.execute('db.connect', {
    connectionId: 'shop',
    session: 'api',
    variables: { shopFolder: folder },
  });
  const created = await run(
    'api',
    'CREATE TABLE orders (id INTEGER PRIMARY KEY, sku TEXT, price NUMERIC, note TEXT)',
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  // An API under test: `POST /orders` stores the order, as a real service would.
  api = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', async () => {
      const order = JSON.parse(body || '{}');
      await run('api', 'INSERT INTO orders (sku, price) VALUES (?, ?)', [order.sku, order.price]);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sku: order.sku }));
    });
  });
  await new Promise((done) => api.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${api.address().port}`;
});
after(async () => {
  api?.close();
  await server?.stop();
  if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const testScript = `
const db = nx.sql('shop');
// Asynchronous tests run at once: these share a table, so each waits for the one before.
let chain = Promise.resolve();
const inOrder = (name, check) =>
  pm.test(name, () => (chain = chain.catch(() => undefined).then(check)));
inOrder('the API stored the order, and the script deletes it', async () => {
  pm.expect(pm.response.code).to.equal(201);
  const order = await db.queryOne('SELECT sku, price FROM orders WHERE sku = ?', ['A-1']);
  pm.expect(order).to.eql({ sku: 'A-1', price: 19.99 });
  const deleted = await db.execute('DELETE FROM orders WHERE sku = ?', ['A-1']);
  pm.expect(deleted.affected).to.equal(1);
  pm.expect(await db.query('SELECT * FROM orders')).to.have.length(0);
});
inOrder('a value with quotes is a parameter, not part of the statement', async () => {
  const note = "O'Brien'); DROP TABLE orders; --";
  await db.execute('INSERT INTO orders (sku, note) VALUES (?, ?)', ['B-2', note]);
  const row = await db.queryOne('SELECT note FROM orders WHERE sku = ?', ['B-2']);
  pm.expect(row.note).to.equal(note);
  pm.expect((await db.query('SELECT count(*) AS n FROM orders'))[0].n).to.equal(1);
});
inOrder('statements on every row need a confirmation', async () => {
  let message = '';
  try {
    await db.execute('DELETE FROM orders');
  } catch (error) {
    message = error.message;
  }
  pm.expect(message).to.include('every row');
  const res = await db.execute('DELETE FROM orders', [], { confirm: true });
  pm.expect(res.affected).to.equal(1);
});
inOrder('a transaction is undone when its function throws', async () => {
  let message = '';
  try {
    await db.transaction(async (tx) => {
      await tx.execute('INSERT INTO orders (sku) VALUES (?)', ['C-3']);
      throw new Error('stop');
    });
  } catch (error) {
    message = error.message;
  }
  pm.expect(message).to.equal('stop');
  pm.expect(await db.queryOne('SELECT sku FROM orders WHERE sku = ?', ['C-3'])).to.equal(null);
  const kept = await db.transaction(async (tx) => {
    await tx.execute('INSERT INTO orders (sku) VALUES (?)', ['D-4']);
    return 'done';
  });
  pm.expect(kept).to.equal('done');
  pm.expect((await db.queryOne('SELECT sku FROM orders WHERE sku = ?', ['D-4'])).sku).to.equal('D-4');
  await db.execute('DELETE FROM orders WHERE sku = ?', ['D-4']);
});
inOrder('a query gives 1000 rows at most and says it was cut', async () => {
  const rows = await db.query(
    'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1500) SELECT i FROM n',
  );
  pm.expect(rows.length).to.equal(1000);
  pm.expect(rows.truncated).to.equal(true);
  pm.expect(rows.columns).to.eql(['i']);
});
inOrder('values come with their kind where JavaScript would lose them', async () => {
  const row = await db.queryOne('SELECT 9007199254740993 AS big, ? AS d', [nx.sql.numeric('1.50')]);
  pm.expect(row.big instanceof SqlValue).to.equal(true);
  pm.expect(String(row.big)).to.equal('9007199254740993');
});
inOrder('a read-only connection refuses execute', async () => {
  let message = '';
  try {
    await nx.sql('shop-reader').execute('INSERT INTO orders (sku) VALUES (?)', ['X']);
  } catch (error) {
    message = error.message;
  }
  pm.expect(message).to.include('read-only');
});
inOrder('a connection that does not exist is explained', async () => {
  let message = '';
  try {
    await nx.sql('nowhere').query('SELECT 1');
  } catch (error) {
    message = error.message;
  }
  pm.expect(message).to.equal('No saved SQL connection is named nowhere');
});
inOrder('the connection is a name, not its file', () => {
  pm.expect(JSON.stringify(nx.sql('shop'))).to.not.include('shop.db');
});
`;

test('a test script checks with nx.sql what the API wrote, and deletes it', async () => {
  const result = await server.execute('request', {
    item: {
      name: 'Create order',
      request: {
        method: 'POST',
        url: `${base}/orders`,
        header: [{ key: 'content-type', value: 'application/json' }],
        body: { mode: 'raw', raw: JSON.stringify({ sku: 'A-1', price: 19.99 }) },
      },
      event: [{ listen: 'test', script: { exec: [testScript] } }],
    },
    variables: [{ key: 'shopFolder', value: folder.replaceAll('\\', '/'), enabled: true }],
  });
  assert.equal(result.status, 201);
  assert.deepEqual(
    result.assertions.map((assertion) => [assertion.name, assertion.passed, assertion.error]),
    [
      ['the API stored the order, and the script deletes it', true, undefined],
      ['a value with quotes is a parameter, not part of the statement', true, undefined],
      ['statements on every row need a confirmation', true, undefined],
      ['a transaction is undone when its function throws', true, undefined],
      ['a query gives 1000 rows at most and says it was cut', true, undefined],
      ['values come with their kind where JavaScript would lose them', true, undefined],
      ['a read-only connection refuses execute', true, undefined],
      ['a connection that does not exist is explained', true, undefined],
      ['the connection is a name, not its file', true, undefined],
    ],
  );
});

test('a transaction left open when the script ends is undone', async () => {
  const result = await server.execute('request', {
    item: {
      name: 'Left open',
      request: {
        method: 'POST',
        url: `${base}/orders`,
        body: { mode: 'raw', raw: '{"sku":"E-5"}' },
      },
      event: [
        {
          listen: 'prerequest',
          script: {
            exec: [
              "nx.sql('shop').transaction(async (tx) => { await tx.execute('INSERT INTO orders (sku) VALUES (?)', ['ghost']); await new Promise(() => {}); });",
            ],
          },
        },
      ],
    },
    variables: [{ key: 'shopFolder', value: folder.replaceAll('\\', '/'), enabled: true }],
  });
  assert.equal(result.status, 201);
  // The session closes as the script ends, so its write lock goes and nothing of it stays.
  let count;
  for (let attempt = 0; attempt < 50; attempt++) {
    const answer = await run('api', "SELECT count(*) FROM orders WHERE sku IN ('ghost', 'E-5')");
    if (answer.status === 200) {
      const written = await run('api', 'UPDATE orders SET note = ? WHERE sku = ?', ['x', 'E-5']);
      if (written.status === 200) {
        count = (await run('api', "SELECT count(*) FROM orders WHERE sku = 'ghost'")).body
          .rows[0][0];
        break;
      }
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(count, 0);
});
