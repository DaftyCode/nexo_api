import { describe, expect, it } from 'vitest';
import { DbPanelTest, dbConnection, node, startDbPanel } from '../testing/db-panel';

const orders = ['shop', 'schemas', 'sales', 'tables', 'orders'];
const tree = {
  '': [node('database', 'shop')],
  shop: [node('folder', 'schemas')],
  'shop/schemas': [node('schema', 'sales')],
  'shop/schemas/sales': [node('folder', 'tables')],
  'shop/schemas/sales/tables': [node('table', 'orders')],
};
const structure = {
  between: false,
  objects: [
    { kind: 'table', name: 'items', status: 'equal', differences: [] },
    {
      kind: 'table',
      name: 'orders',
      status: 'different',
      sourcePath: orders,
      targetPath: orders,
      differences: [
        {
          part: 'column',
          name: 'total',
          status: 'different',
          fields: ['type', 'nullable'],
          source: {},
          target: {},
        },
      ],
    },
    {
      kind: 'view',
      name: 'report',
      status: 'different',
      differences: [],
      sourceDefinition: 'SELECT 1',
      targetDefinition: 'SELECT 2',
    },
  ],
  counts: { different: 2, equal: 1 },
};
const data = {
  counts: { onlySource: 1, onlyTarget: 0, different: 1, equal: 8 },
  key: ['id'],
  columns: ['qty'],
  differences: [
    { kind: 'onlySource', key: [1], source: [1, 4], target: null, columns: [] },
    {
      kind: 'different',
      key: [2],
      source: [2, { $t: 'decimal', v: '5.0' }],
      target: [2, 6],
      columns: ['qty'],
    },
  ],
  complete: false,
};

async function compareTab(target: Record<string, unknown> = {}) {
  const synced: unknown[] = [];
  const panel = await startDbPanel({
    tree,
    documents: [
      dbConnection({ driver: 'postgres', host: 'db', database: 'copy', ...target }, 'c2', 'Copy'),
    ],
    responses: {
      'db.compare.schema': () => structure,
      'db.compare.script': () => ({
        statements: ['ALTER TABLE orders ALTER total TYPE numeric'],
        warnings: [{ text: 'db.compare.warn.others', params: { v0: 1 } }],
      }),
      'db.compare.data': () => data,
      'db.sync.data': (payload: Record<string, unknown>) => {
        synced.push(payload);
        return payload['script']
          ? { statements: ['DELETE FROM orders WHERE id = 9;'] }
          : { inserted: 1, updated: 1, deleted: 0 };
      },
      'db.ddl': (payload: Record<string, unknown>) => ({
        sql: `CREATE TABLE ${(payload['path'] as string[]).at(-1)} (\n  total int\n)`,
      }),
      'db.cancel': () => ({}),
    },
  });
  panel.section().tabs.open({
    kind: 'compare',
    connection: 'c1',
    path: orders,
    part: 'table',
    title: 'Compare',
  });
  await panel.settle();
  return { panel, synced };
}

const view = (panel: DbPanelTest) => panel.root().querySelector<HTMLElement>('app-db-compare')!;
const choose = async (panel: DbPanelTest, label: string, value: string) => {
  const select = panel.control(label, view(panel)) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('input'));
  select.dispatchEvent(new Event('change'));
  await panel.settle(20);
};

describe('DbCompare', () => {
  it('compares the structure of a table with another one and writes its script', async () => {
    const { panel } = await compareTab();
    expect(panel.text()).toContain('orders · Compare');
    expect(view(panel).textContent).toContain('Compares Shop / shop / sales / orders with:');
    const start = panel.buttons(/^\s*Compare\s*$/, view(panel))[0] as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    await choose(panel, 'Compare with the connection', 'c2');
    await choose(panel, 'Table', JSON.stringify(orders));
    expect(start.disabled).toBe(false);
    await panel.click(/^\s*Compare\s*$/, view(panel));
    expect(panel.calls('db.compare.schema')[0]).toMatchObject({
      source: { path: orders, table: true },
      target: { path: orders, table: true },
      ignoreColumnOrder: true,
      ignoreConstraintNames: true,
      ignoreComments: false,
    });
    const names = [...view(panel).querySelectorAll('.db-compare-object span:first-child')].map(
      (e) => e.textContent,
    );
    expect(names).toEqual(['orders', 'report', 'items']);
    expect(view(panel).textContent).toContain('Different: 2');
    await panel.click(/orders\s*Different/, view(panel));
    expect(view(panel).textContent).toMatch(/type\s+nulls/);
    const ddl = view(panel).querySelectorAll('.db-compare-ddl pre');
    expect(ddl).toHaveLength(2);
    await panel.click(/report\s*Different/, view(panel));
    expect(view(panel).querySelectorAll('.db-compare-ddl .changed')).toHaveLength(2);
    (
      panel.control('Also drop the tables only the target has', view(panel)) as HTMLInputElement
    ).click();
    await panel.click('Write the script', view(panel));
    expect(panel.calls('db.compare.script')[0]).toMatchObject({ drop: true });
    expect(view(panel).textContent).toContain('ALTER TABLE orders ALTER total TYPE numeric;');
    expect(view(panel).textContent).toContain(
      '1 views, routines or other objects differ: the script only changes tables',
    );
    await panel.click('Open in a SQL tab of the target', view(panel));
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'sql', connection: 'c2' });
  });

  it('compares the rows of two tables and synchronizes the target once its name is typed', async () => {
    const { panel, synced } = await compareTab({ type: 'production' });
    const asked: unknown[] = [];
    panel.state.confirm = (message, params) => (asked.push([message, params]), true);
    await panel.click('Data', view(panel));
    await choose(panel, 'Compare with the connection', 'c2');
    await choose(panel, 'Table', JSON.stringify(orders));
    await panel.fill('Key columns (empty: the primary key)', 'id', view(panel));
    await panel.fill('Filter (a condition of both tables)', 'qty > 0', view(panel));
    await panel.click(/^\s*Compare\s*$/, view(panel));
    expect(panel.calls('db.compare.data')[0]).toMatchObject({ key: ['id'], filter: 'qty > 0' });
    expect(view(panel).textContent).toContain(
      'Only in the source: 1 · Only in the target: 0 · Different: 1 · Equal: 8',
    );
    expect(view(panel).textContent).toContain('The first 2 differences are shown');
    expect(view(panel).textContent).toContain('2 · 5.0');
    const sync = panel.buttons('Synchronize the target', view(panel))[0] as HTMLButtonElement;
    expect(sync.disabled).toBe(true);
    await panel.fill('Type orders to change the rows of that table', 'orders', view(panel));
    expect(sync.disabled).toBe(false);
    await panel.click('Synchronize the target', view(panel));
    expect(asked).toEqual([['db.compare.confirmProduction', { v0: 'Copy' }]]);
    expect(synced[0]).toMatchObject({ confirmName: 'orders', confirm: true, delete: false });
    expect(panel.state.toast()).toMatchObject({
      title: 'Rows synchronized',
      params: { v0: '1', v1: '1', v2: '0' },
    });
    await panel.click('Write the script', view(panel));
    expect(view(panel).textContent).toContain('DELETE FROM orders WHERE id = 9;');
  });

  it('is offered for schemas, databases, tables and SQLite files', async () => {
    const panel = await startDbPanel({
      tree,
      documents: [dbConnection({ driver: 'sqlite', database: '/a.db' }, 'c3', 'File')],
    });
    await panel.open('Shop');
    expect(await panel.menuEntries('shop')).toContain('Compare with…');
    expect(await panel.menuEntries('File')).toContain('Compare with…');
    expect(await panel.menuEntries('Shop')).not.toContain('Compare with…');
    await panel.menu('File', 'Compare with…');
    expect(panel.section().tabs.active()).toMatchObject({
      kind: 'compare',
      connection: 'c3',
      part: 'schema',
    });
    await choose(panel, 'Compare with the connection', 'c3');
    expect(
      (panel.control('Schema or database', view(panel)) as HTMLSelectElement).textContent,
    ).toContain('File');
  });
});
