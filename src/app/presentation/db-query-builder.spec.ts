import { describe, expect, it } from 'vitest';
import { codeView } from '../testing/controls';
import { DbPanelTest, driverHello, node, startDbPanel } from '../testing/db-panel';

const TABLES: Record<string, { columns: string[]; keys: [string, string][] }> = {
  orders: { columns: ['id', 'user_id', 'total'], keys: [['user_id', 'users']] },
  users: { columns: ['id', 'name'], keys: [] },
};

function model(payload: Record<string, unknown>) {
  const name = (payload['path'] as string[]).at(-1)!;
  const table = TABLES[name];
  return {
    table: {
      schema: 'public',
      name,
      columns: table.columns.map((column) => ({ name: column, typeName: 'int4', nullable: true })),
      primaryKey: { columns: ['id'] },
      foreignKeys: table.keys.map(([column, target]) => ({
        columns: [column],
        referencedSchema: 'public',
        referencedTable: target,
        referencedColumns: ['id'],
      })),
    },
  };
}

/** The whole script is one statement, as the backend splits it. */
function split(payload: Record<string, unknown>) {
  const text = String(payload['script']);
  if (!text.trim()) return { statements: [], current: null };
  const classification = {
    kind: 'read',
    missingWhere: false,
    truncate: false,
    drop: [],
    drops: false,
  };
  return {
    statements: [{ text, start: 0, end: text.length, line: 1, classification }],
    current: 0,
  };
}

async function start(text: string, parse: (sql: string) => unknown = () => ({})) {
  const panel = await startDbPanel({
    connection: { driver: 'postgres', host: 'db', database: 'shop' },
    hello: driverHello({ methods: ['ddl.model'] }),
    tree: {
      '': [node('database', 'shop')],
      shop: [node('folder', 'schemas')],
      'shop/schemas': [node('schema', 'public')],
      'shop/schemas/public': [node('folder', 'tables')],
      'shop/schemas/public/tables': [node('table', 'orders'), node('table', 'users')],
    },
    tabs: [{ id: 's1', kind: 'sql', title: 'SQL' }],
    drafts: { s1: { text, cursor: 0 } },
    responses: {
      'db.ddl.model': model,
      'db.split': split,
      'db.query.parse': (payload: Record<string, unknown>) => parse(String(payload['sql'])),
      'db.execute': () => ({ columns: [], rows: [], affected: 0, elapsedMs: 1 }),
    },
  });
  await panel.click(/^Visual$/);
  await panel.settle(20);
  return panel;
}
const script = (panel: DbPanelTest) =>
  codeView(
    panel.root().querySelector('.cm-content[aria-label="SQL script"]')!,
  ).state.doc.toString();

describe('the visual query builder', () => {
  it('builds a SELECT of two related tables, joined by their foreign key, and runs it', async () => {
    const panel = await start('');
    expect(panel.text()).toContain('Drag tables here from the navigator');
    await panel.click('Add users');
    await panel.click('Add orders');
    await panel.settle(20);
    expect(script(panel)).toBe(
      'SELECT *\nFROM public.users u\n  INNER JOIN public.orders o ON o.user_id = u.id',
    );
    const name = panel.control('name') as HTMLInputElement;
    name.click();
    await panel.settle();
    expect(script(panel)).toContain('SELECT u.name\n');
    await panel.click('INNER');
    expect(script(panel)).toContain('LEFT OUTER JOIN');
    await panel.click(/^Page$/);
    await panel.fill('Rows at most', '10');
    expect(script(panel)).toMatch(/LIMIT 10$/);
    await panel.click(/^Conditions$/);
    await panel.click('＋ Condition');
    const [column] = panel.buttons('＋ Condition').length
      ? [
          ...panel
            .root()
            .querySelectorAll<HTMLInputElement>('.qb-row input[aria-label="Column or expression"]'),
        ]
      : [];
    column.value = 'u.name';
    column.dispatchEvent(new Event('change'));
    await panel.settle();
    const value = panel
      .root()
      .querySelector<HTMLInputElement>('.qb-row input[aria-label="Value"]')!;
    value.value = "O'Brien";
    value.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(script(panel)).toContain("WHERE u.name = 'O''Brien'");
    await panel.click(/^▶ Run$/, panel.root().querySelector('.db-builder')!);
    expect(panel.calls('db.execute').at(-1)).toMatchObject({
      sql: expect.stringContaining('FROM public.users u'),
    });
    await panel.click('Take public.orders away');
    expect(script(panel)).not.toContain('orders');
  });

  it('reads a SELECT back into its tables', async () => {
    const panel = await start('select * from public.orders o', () => ({
      model: {
        distinct: false,
        tables: [{ path: ['public', 'orders'], alias: 'o' }],
        joins: [],
        columns: [],
        where: null,
        groupBy: [],
        having: null,
        orderBy: [],
        limit: null,
        offset: null,
      },
    }));
    expect(panel.root().querySelector('.qb-table')?.textContent).toContain('total');
    await panel.click(/^Order$/);
    await panel.click('＋ Order by');
    const order = panel.root().querySelector<HTMLInputElement>('.qb-panel input')!;
    order.value = 'o.total';
    order.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(script(panel)).toBe('SELECT *\nFROM public.orders o\nORDER BY o.total');
  });

  it('only shows a statement it cannot hold, and never rewrites it', async () => {
    const other = await start('select * from (select 1) x', () => ({ unsupported: 'subqueries' }));
    expect(other.text()).toContain('Visual only shows this statement: it has subqueries');
    expect((other.buttons('Add orders')[0] as HTMLButtonElement).disabled).toBe(true);
    expect(script(other)).toBe('select * from (select 1) x');
    await other.click(/^Text$/);
    expect(other.root().querySelector('app-db-query-builder')).toBeNull();
  });
});
