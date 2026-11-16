import { readDatabaseSession } from './session';
import {
  emptyTableQuery,
  foreignKeys,
  orderBy,
  tableCount,
  tableOfPath,
  tableSelect,
} from './table-query';
import { cellText } from './results';

const postgres = { name: 'postgresql', quoteOpen: '"', quoteClose: '"', parameters: 'numbered' };
const tsql = { name: 'tsql', quoteOpen: '[', quoteClose: ']', parameters: 'named' };
const mysql = { name: 'mysql', quoteOpen: '`', quoteClose: '`', parameters: 'question' };

describe("the queries of an object's Data tab", () => {
  it('writes MySQL with question marks, and a LIKE without an escape it already has', () => {
    const query = {
      ...emptyTableQuery(),
      quick: [
        { column: 'status', operator: 'eq' as const, value: 'paid' },
        { column: 'note', operator: 'contains' as const, value: '50%' },
      ],
    };
    expect(tableSelect('`shop`.`orders`', query, mysql)).toEqual({
      sql: 'SELECT * FROM `shop`.`orders` WHERE status = ? AND CAST(note AS CHAR) LIKE ?',
      params: ['paid', '%50\\%%'],
    });
  });

  it('filters by the condition and the quick filters, with the values as parameters', () => {
    const query = {
      where: 'total > 10',
      quick: [
        { column: 'status', operator: 'eq' as const, value: "it's" },
        { column: 'Note', operator: 'contains' as const, value: '50%_off' },
        { column: 'sent', operator: 'null' as const },
        { column: 'id', operator: 'ne' as const, value: { $t: 'integer', v: '7' } },
      ],
      order: [
        { column: 'total', descending: true },
        { column: 'id', descending: false },
      ],
    };
    expect(tableSelect('shop.orders', query, postgres)).toEqual({
      sql:
        'SELECT * FROM shop.orders WHERE (total > 10) AND status = $1 AND CAST("Note" AS TEXT) ILIKE $2 ' +
        "ESCAPE '\\' AND sent IS NULL AND (id <> $3 OR id IS NULL) ORDER BY total DESC, id ASC",
      params: ["it's", '%50\\%\\_off%', { $t: 'integer', v: '7' }],
    });
    expect(
      tableCount('[dbo].[t]', { ...emptyTableQuery(), quick: query.quick.slice(0, 1) }, tsql),
    ).toEqual({
      sql: 'SELECT count(*) FROM [dbo].[t] WHERE status = @P1',
      params: ["it's"],
    });
    expect(tableSelect('t', emptyTableQuery(), postgres).sql).toBe('SELECT * FROM t');
  });

  it('orders by one column, turns it round, or adds another level', () => {
    let query = orderBy(emptyTableQuery(), 'a', false);
    expect(query.order).toEqual([{ column: 'a', descending: false }]);
    query = orderBy(query, 'a', false);
    expect(query.order).toEqual([{ column: 'a', descending: true }]);
    query = orderBy(query, 'b', true);
    expect(query.order).toEqual([
      { column: 'a', descending: true },
      { column: 'b', descending: false },
    ]);
    expect(orderBy(query, 'b', false).order).toEqual([{ column: 'b', descending: true }]);
  });

  it('names the table of a path, with or without its nodes loaded', () => {
    const path = ['shop', 'schemas', 'Sales', 'tables', 'orders'];
    expect(tableOfPath(path, [], postgres)).toBe('"Sales".orders');
    const nodes = [
      { kind: 'schema', name: 'Sales', label: 'Sales', hasChildren: true, actions: [] },
      { kind: 'table', name: 'orders', label: 'orders', hasChildren: true, actions: [] },
    ];
    expect(tableOfPath(path, nodes, tsql)).toBe('[Sales].orders');
  });

  it('reads the keys of a description and keeps the query in the session', () => {
    const section = {
      columns: ['Name', 'Columns', 'Referenced schema', 'Referenced table', 'Referenced columns'],
      rows: [['orders_customer_fkey', 'customer', 'shop', 'customers', 'id']],
    };
    expect(
      foreignKeys(section, { schema: 'Referenced schema', table: 'Referenced table' }, cellText),
    ).toEqual([
      {
        name: 'orders_customer_fkey',
        columns: ['customer'],
        schema: 'shop',
        table: 'customers',
        referenced: ['id'],
      },
    ]);
    expect(
      foreignKeys({ columns: ['Name'], rows: [['x']] }, { schema: 'S', table: 'T' }, cellText),
    ).toEqual([]);
    const session = readDatabaseSession({
      tabs: [
        {
          id: 'o',
          kind: 'object',
          connection: 'a',
          title: 'orders',
          path: ['x'],
          query: {
            where: 'id > 1',
            quick: [{ column: 'a', operator: 'bad' }],
            order: [{ column: 'id' }],
          },
          part: 'data',
        },
        { id: 's', kind: 'sql', connection: 'a', title: 'SQL', part: 'data' },
      ],
    });
    expect(session.tabs[0].query).toEqual({
      where: 'id > 1',
      quick: [],
      order: [{ column: 'id', descending: false }],
    });
    // The view an object tab shows is kept; other tabs have none.
    expect(session.tabs.map((tab) => tab.part)).toEqual(['data', undefined]);
  });
});
