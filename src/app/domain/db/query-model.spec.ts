import { describe, expect, it } from 'vitest';
import { QueryModel, emptyQuery, operatorValues, readParsedQuery } from './query-model';
import { querySql, textLiteral } from './query-model/sql';
import {
  BuilderTable,
  addTable,
  aliasFor,
  joinColumns,
  nextJoinKind,
  removeTable,
  toggleColumn,
} from './query-model/edit';
import { quoteName } from './tree';

const PG = { name: 'postgresql', quoteOpen: '"', quoteClose: '"' };
const MYSQL = { name: 'mysql', quoteOpen: '`', quoteClose: '`' };
const TSQL = { name: 'tsql', quoteOpen: '[', quoteClose: ']' };
const SQLITE = { name: 'sqlite', quoteOpen: '"', quoteClose: '"' };
const quote = (name: string) => quoteName(name, PG);

const orders: QueryModel = {
  ...emptyQuery(),
  tables: [
    { path: ['public', 'orders'], alias: 'o' },
    { path: ['Customer List'], alias: 'c' },
  ],
  joins: [{ table: 1, kind: 'left', on: [{ left: 'c.id', operator: '=', right: 'o.customer' }] }],
  columns: [
    { expression: 'o.id', alias: '', aggregate: '' },
    { expression: '*', alias: 'n', aggregate: 'count' },
    { expression: 'o.city', alias: 'Cities', aggregate: 'count-distinct' },
  ],
  where: {
    match: 'all',
    items: [
      { column: 'c.name', operator: '=', values: [{ text: "O'Brien \\ Ltd", kind: 'text' }] },
      {
        match: 'any',
        items: [
          { column: 'o.total', operator: '>', values: [{ text: '10.5', kind: 'number' }] },
          {
            column: 'o.total',
            operator: 'between',
            values: [
              { text: '1', kind: 'number' },
              { text: 'now()', kind: 'expression' },
            ],
          },
        ],
      },
      {
        column: 'o.kind',
        operator: 'in',
        values: [
          { text: 'a', kind: 'text' },
          { text: 'b', kind: 'text' },
        ],
      },
      { column: 'o.note', operator: 'is null', values: [] },
      { column: '', operator: '=', values: [] },
    ],
  },
  groupBy: ['o.id'],
  having: {
    match: 'all',
    items: [{ column: 'COUNT(*)', operator: '>=', values: [{ text: '2', kind: 'number' }] }],
  },
  orderBy: [{ expression: 'n', descending: true }],
  limit: 50,
  offset: null,
};

describe('the SQL of a query model', () => {
  it('lays out every clause, with names quoted and values escaped', () => {
    expect(querySql(orders, PG)).toBe(
      [
        'SELECT o.id,',
        '  COUNT(*) AS n,',
        '  COUNT(DISTINCT o.city) AS "Cities"',
        'FROM public.orders o',
        '  LEFT OUTER JOIN "Customer List" c ON c.id = o.customer',
        "WHERE c.name = 'O''Brien \\ Ltd' AND (o.total > 10.5 OR o.total BETWEEN 1 AND now()) AND o.kind IN ('a', 'b') AND o.note IS NULL",
        'GROUP BY o.id',
        'HAVING COUNT(*) >= 2',
        'ORDER BY n DESC',
        'LIMIT 50',
      ].join('\n'),
    );
  });

  it('writes each dialect its own page and literals', () => {
    expect(textLiteral('a\\b', MYSQL)).toBe("'a\\\\b'");
    expect(textLiteral('café', TSQL)).toBe("N'café'");
    expect(textLiteral('cafe', TSQL)).toBe("'cafe'");
    const plain = { ...emptyQuery(), tables: [{ path: ['t'], alias: '' }] };
    expect(querySql({ ...plain, limit: 5 }, TSQL)).toBe('SELECT TOP (5) *\nFROM t');
    expect(querySql({ ...plain, limit: 5, offset: 10 }, TSQL)).toBe(
      'SELECT *\nFROM t\nORDER BY (SELECT NULL)\nOFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY',
    );
    expect(querySql({ ...plain, offset: 10 }, MYSQL)).toBe(
      'SELECT *\nFROM t\nLIMIT 18446744073709551615\nOFFSET 10',
    );
    expect(querySql({ ...plain, offset: 10 }, SQLITE)).toBe(
      'SELECT *\nFROM t\nLIMIT -1\nOFFSET 10',
    );
    expect(querySql({ ...plain, offset: 10, distinct: true }, PG)).toBe(
      'SELECT DISTINCT *\nFROM t\nOFFSET 10',
    );
    expect(querySql({ ...plain, tables: [{ path: ['dbo', 'Order'], alias: 'o' }] }, TSQL)).toBe(
      'SELECT *\nFROM dbo.[Order] o',
    );
    expect(querySql(emptyQuery(), PG)).toBe('');
    // A number that is not one is written as text; an empty expression too.
    const odd = {
      ...plain,
      where: {
        match: 'all' as const,
        items: [
          {
            column: 'a',
            operator: '=' as const,
            values: [{ text: '1; DROP', kind: 'number' as const }],
          },
          { column: 'b', operator: 'not in' as const, values: [] },
          {
            column: 'c',
            operator: 'like' as const,
            values: [{ text: ' ', kind: 'expression' as const }],
          },
          { column: 'd', operator: 'between' as const, values: [] },
          { column: 'e', operator: '=' as const, values: [] },
        ],
      },
      joins: [
        { table: 1, kind: 'inner' as const, on: [] },
        { table: 9, kind: 'full' as const, on: [] },
      ],
    };
    odd.tables = [...plain.tables, { path: ['u'], alias: '' }];
    expect(querySql(odd, PG)).toBe(
      [
        'SELECT *',
        'FROM t',
        '  INNER JOIN u ON 1 = 1',
        "WHERE a = '1; DROP' AND b NOT IN (NULL) AND c LIKE ' ' AND d BETWEEN '' AND '' AND e = ''",
      ].join('\n'),
    );
    expect(operatorValues('is not null')).toBe(0);
  });
});

describe('reading what the engine parsed', () => {
  it('reads a model, keeping only what it knows', () => {
    const read = readParsedQuery({
      model: {
        distinct: true,
        tables: [{ path: ['t'], alias: 'a' }],
        joins: [{ table: 1, kind: 'weird', on: [{ left: 'x', operator: '!', right: 'y' }] }],
        columns: [{ expression: 'a.id', alias: '', aggregate: 'median' }],
        where: {
          match: 'any',
          items: [
            { column: 'a', operator: 'like', values: [{ text: 'x%', kind: 'text' }] },
            { match: 'all', items: [] },
          ],
        },
        having: null,
        groupBy: ['a.id'],
        orderBy: [{ expression: 'a.id', descending: true }],
        limit: 10,
        offset: -1,
      },
    });
    expect(read).toEqual({
      model: {
        distinct: true,
        tables: [{ path: ['t'], alias: 'a' }],
        joins: [{ table: 1, kind: 'inner', on: [{ left: 'x', operator: '=', right: 'y' }] }],
        columns: [{ expression: 'a.id', alias: '', aggregate: '' }],
        where: {
          match: 'any',
          items: [
            { column: 'a', operator: 'like', values: [{ text: 'x%', kind: 'text' }] },
            { match: 'all', items: [] },
          ],
        },
        groupBy: ['a.id'],
        having: null,
        orderBy: [{ expression: 'a.id', descending: true }],
        limit: 10,
        offset: null,
      },
    });
    expect(readParsedQuery({ unsupported: 'subqueries' })).toEqual({ unsupported: 'subqueries' });
    expect(readParsedQuery(null)).toMatchObject({ model: { tables: [] } });
  });
});

describe('editing a query model', () => {
  const customers: BuilderTable = {
    path: ['shop', 'public', 'tables', 'customers'],
    schema: 'public',
    name: 'customers',
    columns: ['id', 'name'],
    keys: [],
  };
  const lines: BuilderTable = {
    path: ['shop', 'public', 'tables', 'orders'],
    schema: 'public',
    name: 'orders',
    columns: ['id', 'customer_id'],
    keys: [
      {
        columns: ['customer_id'],
        referencedSchema: 'public',
        referencedTable: 'customers',
        referencedColumns: ['id'],
      },
    ],
  };

  it('adds tables with aliases, proposing the join of their foreign key', () => {
    expect(aliasFor('orders', ['o', 'o2'])).toBe('o3');
    expect(aliasFor('42', [])).toBe('t');
    let model = addTable(emptyQuery(), customers, [], quote);
    expect(model.tables).toEqual([{ path: ['public', 'customers'], alias: 'c' }]);
    model = addTable(model, lines, [customers], quote);
    expect(model.joins).toEqual([
      { table: 1, kind: 'inner', on: [{ left: 'o.customer_id', operator: '=', right: 'c.id' }] },
    ]);
    // The other way: the table there references the new one.
    const reversed = addTable(addTable(emptyQuery(), lines, [], quote), customers, [lines], quote);
    expect(reversed.joins[0].on).toEqual([{ left: 'c.id', operator: '=', right: 'o.customer_id' }]);
    // Unrelated: a join the person completes.
    const other = addTable(
      model,
      { ...customers, name: 'towns', schema: undefined, keys: [] },
      [customers, lines],
      quote,
    );
    expect(other.tables.at(-1)).toEqual({ path: ['towns'], alias: 't' });
    expect(other.joins.at(-1)).toEqual({ table: 2, kind: 'inner', on: [] });
  });

  it('chooses columns, joins two of them, changes the join and takes a table away', () => {
    let model = addTable(addTable(emptyQuery(), customers, [], quote), lines, [customers], quote);
    model = toggleColumn(model, 'c.name');
    model = toggleColumn(model, 'o.id');
    model = toggleColumn(model, 'c.name');
    expect(model.columns.map((column) => column.expression)).toEqual(['o.id']);
    model = joinColumns(
      model,
      { table: 0, expression: 'c.name' },
      { table: 1, expression: 'o.id' },
    );
    expect(model.joins[0].on.at(-1)).toEqual({ left: 'o.id', operator: '=', right: 'c.name' });
    expect(joinColumns(model, { table: 1, expression: 'a' }, { table: 1, expression: 'b' })).toBe(
      model,
    );
    const three = joinColumns(
      { ...model, tables: [...model.tables, { path: ['x'], alias: 'x' }] },
      { table: 2, expression: 'x.a' },
      { table: 0, expression: 'c.id' },
    );
    expect(three.joins.at(-1)).toEqual({
      table: 2,
      kind: 'inner',
      on: [{ left: 'x.a', operator: '=', right: 'c.id' }],
    });
    model = nextJoinKind(model, 1);
    expect(model.joins[0].kind).toBe('left');
    expect(nextJoinKind(nextJoinKind(nextJoinKind(model, 1), 1), 1).joins[0].kind).toBe('inner');
    model = {
      ...model,
      orderBy: [{ expression: 'o.id', descending: false }],
      groupBy: ['o.id', 'c.id'],
    };
    const without = removeTable(model, 1, quote);
    expect(without).toMatchObject({
      tables: [{ alias: 'c' }],
      joins: [],
      columns: [],
      orderBy: [],
      groupBy: ['c.id'],
    });
    expect(removeTable(three, 0, quote).joins).toEqual([{ table: 1, kind: 'inner', on: [] }]);
    expect(removeTable(model, 9, quote)).toBe(model);
  });
});
