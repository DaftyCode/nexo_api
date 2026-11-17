import { SchemaTable, completionContext, tablesOf } from './completion';
import { suggestions } from './completion-options';

const schema: SchemaTable[] = [
  {
    name: 'orders',
    schema: 'shop',
    kind: 'table',
    columns: [
      { name: 'id', type: 'int4' },
      { name: 'customer', type: 'int4' },
      { name: 'total', type: 'numeric' },
    ],
    keys: [{ columns: ['customer'], table: 'users', referenced: ['id'] }],
  },
  {
    name: 'users',
    schema: 'shop',
    kind: 'table',
    columns: [
      { name: 'id', type: 'int4' },
      { name: 'Full Name', type: 'text' },
    ],
  },
  { name: 'users', schema: 'audit', kind: 'view' },
];
const words = {
  quoteOpen: '"',
  quoteClose: '"',
  keywords: ['select', 'where'],
  functions: ['count'],
};
/** The labels offered with the cursor at `|`. */
function offered(text: string) {
  const cursor = text.indexOf('|');
  const sql = text.replace('|', '');
  return suggestions(completionContext(sql, cursor), schema, words).map((option) => option.apply);
}

describe('SQL completion', () => {
  it('reads the tables of a statement with their aliases', () => {
    expect(tablesOf('SELECT 1 FROM shop.orders o JOIN users AS u ON 1 = 1, x')).toEqual([
      { schema: 'shop', name: 'orders', alias: 'o' },
      { name: 'users', alias: 'u' },
    ]);
  });

  it.each([
    ['SELECT o.| FROM orders o', ['id', 'customer', 'total']],
    ['SELECT * FROM |', ['orders', 'shop.users', 'audit.users']],
    [
      'SELECT * FROM orders o JOIN users u ON |',
      ['o.customer = u.id', 'id', 'customer', 'total', 'id', '"Full Name"'],
    ],
    ['SELECT *| FROM orders', ['id, customer, total']],
    ["SELECT 'o.|' FROM orders o", []],
    ['SELECT 1 -- o.| ', []],
    ['UPDATE |', ['orders', 'shop.users', 'audit.users']],
  ])('%s', (text, expected) => {
    expect(offered(text)).toEqual(expected);
  });

  it.each([
    ['SELECT 1 /* o.| */', 'none'],
    ['SELECT 1 /* x */ FROM |', 'tables'],
    ['SELECT 1 -- x\nFROM |', 'tables'],
    ["SELECT 'a' FROM |", 'tables'],
    ['SELECT a FROM orders, |', 'tables'],
    ['SELECT a, | FROM orders', 'any'],
    ['SELECT count(| FROM orders', 'any'],
    ['SELECT a FROM orders WHERE a = |', 'any'],
    ['SELECT a FROM orders WHERE x|', 'any'],
    ['SELECT a FROM orders |', 'none'],
    ['SELECT a FROM orders WHERE a IN (1, |', 'any'],
    ['SELECT a FROM orders JOIN (SELECT 1) x ON |', 'any'],
    ['SELECT a FROM orders WHERE b = 1 ORDER BY a, |', 'any'],
    ['SELECT a FROM orders o JOIN users ON |', 'join'],
    ['SELECT [o].| FROM orders o', 'columns'],
    ['SELECT ghost.| FROM orders o', 'columns'],
  ])('the context of %j is %s', (text, kind) => {
    const cursor = text.indexOf('|');
    expect(completionContext(text.replace('|', ''), cursor).kind).toBe(kind);
  });

  it('reads tables after INTO and every one of a FROM list', () => {
    expect(tablesOf('INSERT INTO shop.orders (id) VALUES (1)')).toEqual([
      { schema: 'shop', name: 'orders' },
    ]);
    expect(tablesOf('SELECT 1 FROM a x, b, "c d" AS y WHERE 1')).toEqual([
      { name: 'a', alias: 'x' },
      { name: 'b' },
      { name: 'c d', alias: 'y' },
    ]);
    expect(tablesOf('SELECT 1 FROM (SELECT 2)')).toEqual([]);
    expect(tablesOf("SELECT 'unclosed FROM x")).toEqual([]);
  });

  it('names a column of an unknown owner after the owner itself', () => {
    expect(completionContext('SELECT ghost. FROM orders o', 13)).toEqual({
      kind: 'columns',
      of: [{ name: 'ghost' }],
      from: 13,
    });
  });

  it('offers the columns of several tables with their owner, and joins both ways', () => {
    const star = offered('SELECT *| FROM orders o JOIN users u ON 1 = 1');
    expect(star).toEqual(['o.id, o.customer, o.total, u.id, u."Full Name"']);
    expect(offered('SELECT *| FROM ghost')).toEqual([]);
    expect(offered('SELECT * FROM users u JOIN orders o ON |')).toContain('o.customer = u.id');
    expect(offered('SELECT * FROM audit.users JOIN shop.orders ON |')).toContain(
      'orders.customer = users.id',
    );
    const columns = suggestions(
      completionContext('SELECT * FROM orders o JOIN users u ON ', 39),
      schema,
      words,
    ).filter((option) => option.type === 'column');
    expect(columns[0].detail).toBe('o · int4');
  });

  it('offers the columns of a table named with its schema, in any case', () => {
    expect(offered('SELECT | FROM SHOP.ORDERS WHERE 1 = 1').slice(0, 3)).toEqual([
      'id',
      'customer',
      'total',
    ]);
    expect(offered('SELECT | FROM other.orders WHERE 1 = 1')).not.toContain('customer');
  });

  it('offers the columns of the tables, functions and keywords elsewhere', () => {
    const where = offered('SELECT id FROM users WHERE |');
    expect(where.slice(0, 2)).toEqual(['id', '"Full Name"']);
    expect(where).toContain('count(');
    expect(where).toContain('SELECT');
  });
});
