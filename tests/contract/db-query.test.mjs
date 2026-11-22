// Contract tests of `db.query.parse` (DB-26): a SELECT is read into the model of the visual
// query builder in the dialect of its engine, and one the model cannot hold whole is refused by
// what it has, so the builder never rewrites it. Nothing runs; no server needed.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

let server;
before(async () => {
  server = await startServer();
});
after(async () => {
  await server?.stop();
});

const parse = (sql, dialect) => server.execute('db.query.parse', { sql, dialect });

test('a SELECT with joins, conditions, groups and a page is read whole', async () => {
  const { model } = await parse(
    `SELECT o.id, count(*) AS n FROM public.orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     WHERE c.name = 'O''Brien' AND o.total BETWEEN 1 AND 10
     GROUP BY o.id HAVING count(*) > 1 ORDER BY n DESC LIMIT 5 OFFSET 2`,
    'postgresql',
  );
  assert.deepEqual(model.tables, [
    { path: ['public', 'orders'], alias: 'o' },
    { path: ['customers'], alias: 'c' },
  ]);
  assert.deepEqual(model.joins, [
    { table: 1, kind: 'left', on: [{ left: 'c.id', operator: '=', right: 'o.customer_id' }] },
  ]);
  assert.deepEqual(model.columns[1], { expression: '*', alias: 'n', aggregate: 'count' });
  assert.deepEqual(model.where.items[0].values, [{ text: "O'Brien", kind: 'text' }]);
  assert.equal(model.where.items[1].operator, 'between');
  assert.deepEqual(model.groupBy, ['o.id']);
  assert.deepEqual([model.limit, model.offset], [5, 2]);
});

test("each engine's page and quotes are read in its dialect", async () => {
  const mssql = await parse('SELECT TOP 3 [id] FROM [dbo].[Order Lines]', 'tsql');
  assert.equal(mssql.model.limit, 3);
  assert.deepEqual(mssql.model.tables[0].path, ['dbo', 'Order Lines']);
  const mysql = await parse('SELECT `id` FROM `shop`.`people` LIMIT 2, 4', 'mysql');
  assert.deepEqual([mysql.model.limit, mysql.model.offset], [4, 2]);
});

test('what the model cannot hold is named, and SQL that cannot be read is an error', async () => {
  for (const [sql, why] of [
    ['SELECT * FROM t WHERE id IN (SELECT id FROM u)', 'subqueries'],
    ['SELECT * FROM t UNION SELECT * FROM u', 'UNION, INTERSECT, EXCEPT and VALUES'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'WITH'],
    ['SELECT rank() OVER (ORDER BY id) FROM t', 'window functions'],
    ['DELETE FROM t', 'statements other than SELECT'],
  ]) {
    assert.deepEqual(await parse(sql, 'postgresql'), { unsupported: why }, sql);
  }
  await assert.rejects(parse('SELEC', 'postgresql'), /cannot be read/);
});
