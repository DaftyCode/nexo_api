import { describe, expect, it } from 'vitest';
import { QueryModel, emptyQuery } from '../query-model';
import { quoteName } from '../tree';
import { BuilderTable, addTable, referenceOf, removeTable } from './edit';

const quote = (name: string) => quoteName(name, { quoteOpen: '"', quoteClose: '"' });
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

describe('tables of the builder read from the text', () => {
  it('are named by their alias, or by their name when they have none', () => {
    expect(referenceOf({ path: ['public', 'users'], alias: 'u' })).toBe('u');
    expect(referenceOf({ path: ['public', 'users'], alias: '' })).toBe('users');
    // A join by a foreign key names the table without an alias by its name, never by "".
    const bare: QueryModel = {
      ...emptyQuery(),
      tables: [{ path: ['public', 'customers'], alias: '' }],
    };
    expect(addTable(bare, lines, [customers], quote).joins[0].on).toEqual([
      { left: 'o.customer_id', operator: '=', right: 'customers.id' },
    ]);
    const back = addTable(
      { ...emptyQuery(), tables: [{ path: ['orders'], alias: '' }] },
      customers,
      [lines],
      quote,
    );
    expect(back.joins[0].on).toEqual([
      { left: 'c.id', operator: '=', right: 'orders.customer_id' },
    ]);
    expect(removeTable(addTable(bare, lines, [customers], quote), 0, quote).joins).toEqual([]);
  });
});
