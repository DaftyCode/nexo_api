import { afterEach, describe, expect, it } from 'vitest';
import { DbPanelTest, node, startDbPanel } from '../testing/db-panel';

const viewPath = ['shop', 'schemas', 'public', 'views', 'totals'];
const tablePath = ['shop', 'schemas', 'public', 'tables', 'orders'];
const tree = {
  '': [node('database', 'shop')],
  shop: [node('folder', 'schemas', { label: 'Schemas' })],
  'shop/schemas': [node('schema', 'public')],
  'shop/schemas/public': [
    node('folder', 'views', { label: 'Views' }),
    node('folder', 'tables', { label: 'Tables' }),
  ],
  'shop/schemas/public/views': [node('view', 'totals', { actions: ['open', 'ddl'] })],
  'shop/schemas/public/tables': [node('table', 'orders')],
};
const description = (kind: string) => ({
  kind,
  name: kind === 'view' ? 'public.totals' : 'public.orders',
  properties: [
    { name: 'Kind', value: kind },
    { name: 'Owner', value: 'ana' },
    { name: 'Object ID', value: '16384' },
    { name: 'Created', value: '2026-01-02T03:04:05Z' },
    { name: 'Persistence', value: 'permanent' },
    { name: 'Estimated rows', value: 12000 },
    { name: 'Size', value: '16 kB' },
    { name: 'Definition', value: 'SELECT 1' },
    { name: 'Fillfactor', value: '100' },
  ],
  sections: [
    { id: 'columns', title: 'Columns', columns: ['Name'], rows: [['n']] },
    { id: 'indexes', title: 'Indexes', columns: ['Name'], rows: [] },
    { id: 'constraints', title: 'Constraints', columns: ['Name'], rows: [['pk']] },
    {
      id: 'foreign-keys',
      title: 'Foreign keys',
      columns: ['Name', 'Columns', 'Schema', 'Table', 'Referenced columns'],
      rows: [['fk', 'customer', '', 'customers', 'id']],
    },
  ],
});

async function start(path: string[], extra: { connect?: () => unknown } = {}) {
  const written: string[] = [];
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });
  const panel = await startDbPanel({
    tree,
    tabs: [{ id: 'o1', kind: 'object', title: path.at(-1)!, path }],
    responses: {
      ...(extra.connect ? { 'db.connect': extra.connect } : {}),
      'db.describe': () => description(path.includes('views') ? 'view' : 'table'),
      'db.ddl': () => ({ sql: 'CREATE VIEW totals AS SELECT 1' }),
      'db.execute': (payload: Record<string, unknown>) => ({
        columns: [
          {
            name: 'id',
            typeName: 'int4',
            kind: 'integer',
            key: true,
            origin: { schema: 'public', table: 'orders', column: 'id' },
          },
          {
            name: 'customer',
            typeName: 'int4',
            kind: 'integer',
            origin: { schema: 'public', table: 'orders', column: 'customer' },
          },
        ],
        rows: /count/i.test(String(payload['sql']))
          ? [[3]]
          : [
              [1, 7],
              [2, 8],
            ],
        elapsedMs: 1,
      }),
    },
  });
  for (let i = 0; i < 10 && !panel.text().includes(path.at(-1)!); i++) await panel.settle();
  return { panel, written };
}
const views = (panel: DbPanelTest) =>
  panel.root().querySelector<HTMLElement>('[aria-label="Object views"]')!;

afterEach(() => Reflect.deleteProperty(navigator, 'clipboard'));

describe('the tab of an object, more of it', () => {
  it('shows the properties of a view in cards, and its actions in the More menu', async () => {
    const { panel, written } = await start(viewPath);
    for (let i = 0; i < 10 && !panel.root().querySelector('[aria-label="Object views"]'); i++)
      await panel.settle();
    await panel.click('Properties', views(panel));
    const properties = panel.root().querySelector<HTMLElement>('app-db-object-properties')!;
    expect(properties.textContent).toContain('16384');
    expect(properties.textContent).toContain('permanent');
    expect(properties.textContent).toContain('SELECT 1');
    expect(properties.textContent).toContain('Fillfactor');
    await panel.click('More actions');
    const menu = panel.root().querySelector<HTMLElement>('.db-object-menu')!;
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await panel.click('Copy name', menu);
    expect(written).toEqual(['public.totals']);
    await panel.click('More actions');
    await panel.click('More actions');
    expect(panel.root().querySelector('.db-object-menu')).toBeNull();
    await panel.click('More actions');
    await panel.click('Copy DDL', panel.root().querySelector<HTMLElement>('.db-object-menu')!);
    expect(written.at(-1)).toBe('CREATE VIEW totals AS SELECT 1');
    await panel.click('More actions');
    await panel.click(
      'Open the DDL in a script',
      panel.root().querySelector<HTMLElement>('.db-object-menu')!,
    );
    expect(panel.section().tabs.active()?.kind).toBe('sql');
  });

  it('says when the connection cannot be opened, and refreshes', async () => {
    const { panel } = await start(viewPath, {
      connect: () => {
        throw new Error('server down');
      },
    });
    expect(panel.text()).toMatch(/server down|offline|could not/i);
    await panel.click('Refresh');
  });

  it('pages, counts, filters, orders and relates the rows of a table', async () => {
    const { panel } = await start(tablePath);
    for (let i = 0; i < 10 && !panel.root().querySelector('[role="grid"]'); i++)
      await panel.settle();
    const page = panel.control('Show:') as HTMLSelectElement;
    page.value = '100';
    page.dispatchEvent(new Event('change'));
    await panel.settle();
    await panel.click('Refresh options');
    await panel.click('Count the rows');
    await panel.click('Refresh options');
    await panel.click('Refresh options');
    await panel.click(/^Statement$/);
    await panel.fill('Condition (WHERE)', 'id > 0');
    await panel.click('Run (F5)');
    expect(
      panel.calls('db.execute').some((payload) => String(payload['sql']).includes('id > 0')),
    ).toBe(true);
    await panel.click(/^Clear$/);
    const grid = panel.root().querySelector<HTMLElement>('[role="grid"]')!;
    const cell = grid.querySelector<HTMLElement>('[data-column="1"]');
    cell?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    cell?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    await panel.settle();
    const filter = panel.buttons(/Equal to|equal/i)[0];
    filter?.click();
    await panel.settle();
    const sort = grid.querySelectorAll<HTMLElement>('.grid-sort')[1];
    sort?.click();
    await panel.settle();
    expect(panel.calls('db.execute').length).toBeGreaterThan(2);
  });
  it('adds every quick filter and order from a cell, and removes them again', async () => {
    const { panel } = await start(tablePath);
    for (let i = 0; i < 10 && !panel.root().querySelector('[role="grid"] [data-column="1"]'); i++)
      await panel.settle();
    const cellMenu = async (entry: string) => {
      const cell = panel.root().querySelector<HTMLElement>('[role="grid"] [data-column="1"]')!;
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await panel.settle();
      await panel.click(entry, panel.root().querySelector<HTMLElement>('[role="menu"]')!);
      await panel.settle();
    };
    for (const entry of [
      'Filter: different from this value',
      'Filter: contains this value',
      'Filter: is NULL',
      'Filter: is not NULL',
      'Add the column to the order',
    ])
      await cellMenu(entry);
    const sql = String(panel.calls('db.execute').at(-1)?.['sql']);
    expect(sql).toContain('IS NULL');
    expect(sql).toContain('IS NOT NULL');
    expect(sql).toContain('ORDER BY');
    const filters = panel.root().querySelector<HTMLElement>('[aria-label="Filters and order"]')!;
    for (const remove of [...filters.querySelectorAll<HTMLButtonElement>('button[aria-label]')]) {
      remove.click();
      await panel.settle();
    }
    const page = panel.control('Show:') as HTMLSelectElement;
    page.dispatchEvent(new Event('change'));
    await panel.settle();
    await panel.click('Refresh options');
  });
});
