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

  it('offers the columns of the tables, functions and keywords elsewhere', () => {
    const where = offered('SELECT id FROM users WHERE |');
    expect(where.slice(0, 2)).toEqual(['id', '"Full Name"']);
    expect(where).toContain('count(');
    expect(where).toContain('SELECT');
  });
});
