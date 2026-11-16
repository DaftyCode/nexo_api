import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, typeCode } from '../testing/controls';
import { WorkspaceDocument } from '../domain/models';
import { DbPanel } from './db-panel';
import { DbSection } from './db-panel/section';
import { WorkspaceState } from './workspace-state';

const module = {
  id: 'postgres',
  name: 'PostgreSQL',
  description: '',
  version: '0.7.0',
  state: 'installed',
  downloadSize: 1,
  size: 1,
  licenses: [],
  source: '',
  bundled: false,
};
const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Shop',
  revision: 1,
  updated_at: 0,
  value: { driver: 'postgres', host: 'db', database: 'shop' },
};
const orders = ['shop', 'schemas', 'shop', 'tables', 'orders'];
const integer = (name: string) => ({ name, typeName: 'int4', kind: 'integer' });
const description = {
  kind: 'table',
  name: 'shop.orders',
  properties: [
    { name: 'Owner', value: 'nexo' },
    { name: 'Estimated rows', value: 3 },
    { name: 'Comment', value: null },
  ],
  sections: [
    { id: 'columns', title: 'Columns', columns: ['Name', 'Type'], rows: [['customer', 'int4']] },
    {
      id: 'foreign-keys',
      title: 'Foreign keys',
      columns: ['Name', 'Columns', 'Referenced schema', 'Referenced table', 'Referenced columns'],
      rows: [['orders_customer_fkey', 'customer', 'shop', 'customers', 'id']],
    },
    {
      id: 'references',
      title: 'Referenced by',
      columns: ['Name', 'Columns', 'Referenced columns', 'Schema', 'Table name'],
      rows: [['lines_order_fkey', 'order_id', 'id', 'shop', 'lines']],
    },
    { id: 'triggers', title: 'Triggers', columns: ['Name'], rows: [] },
  ],
};

/** The rows the fake server has, by the table a statement reads. */
function execute(payload: Record<string, unknown>) {
  const sql = String(payload['sql']);
  if (sql.includes('boom')) throw new Error('relation "boom" does not exist');
  if (/^SELECT count/i.test(sql)) return { columns: [integer('count')], rows: [[3]], elapsedMs: 1 };
  if (sql.includes('customers'))
    return { columns: [integer('id'), integer('total')], rows: [[1, 9]], elapsedMs: 1 };
  if (sql.includes('lines'))
    return { columns: [integer('order_id')], rows: [[1]], cursor: 'l1', elapsedMs: 1 };
  return {
    columns: [
      { name: 'status', typeName: 'text', kind: 'text' },
      integer('id'),
      integer('customer'),
    ],
    rows: [
      ['paid', 1, 1],
      ['new', 2, 1],
    ],
    cursor: 'k1',
    elapsedMs: 1,
  };
}

describe('DbObjectTab', () => {
  let fixture: ComponentFixture<DbPanel>;
  let api: TestApi;
  const root = () => fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      fixture.detectChanges();
      await fixture.whenStable();
      await new Promise((done) => setTimeout(done));
    }
  };
  const calls = (operation: string) =>
    api.calls.filter((call) => call.operation === operation).map((call) => call.payload);
  const sqls = () => calls('db.execute').map((payload) => payload['sql']);
  const part = async (name: string) => {
    const nav = root().querySelector('[aria-label="Object views"]')!;
    await clickButton(fixture, name, nav);
    await settle();
  };
  const statement = () => root().querySelector('.db-data-statement')?.textContent?.trim();
  const shown = () =>
    root().querySelector('[aria-label="Object views"] [aria-current="page"]')?.textContent?.trim();

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'modules.list': () => [module],
        'db.connect': () => ({ serverVersion: '18', database: 'shop', tls: false }),
        'db.dialect': () => ({
          driver: { id: 'postgres', name: 'PostgreSQL', version: '1' },
          capabilities: {},
          dialect: { name: 'postgresql', quoteOpen: '"', quoteClose: '"', parameters: 'numbered' },
        }),
        'db.describe': () => description,
        'db.ddl': () => ({ sql: 'CREATE TABLE shop.orders (id integer)' }),
        'db.execute': execute,
        'db.fetch': () => ({ rows: [['sent', 3, 2]], cursor: null }),
      }),
      imports: [DbPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    const state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    api.documentsStore.push(connection);
    await state.refresh();
    state.databaseSession.set({
      expanded: [],
      active: 'c1',
      bookmarks: [],
      simple: true,
      tabs: [{ id: 'o1', kind: 'object', connection: 'c1', title: 'orders', path: orders }],
      activeTab: 'o1',
      drafts: {},
    });
    fixture = TestBed.createComponent(DbPanel);
    await settle();
  });

  it('shows its header, properties, sections and DDL, and follows its keys', async () => {
    expect(root().querySelector('h2')?.textContent).toContain('shop.orders');
    const facts = root().querySelector('.db-object-facts')!.textContent!;
    expect(facts).toContain('nexo');
    expect(facts).toContain('Estimated rows');
    expect(facts).not.toContain('Comment');
    // A table opens on its data.
    expect(shown()).toBe('Data');
    await part('Properties');
    expect(root().querySelector('.db-object-properties')?.textContent).toContain('Owner');
    await part('Triggers');
    expect(root().textContent).toContain('No objects');
    await part('Columns');
    expect(root().querySelector('[role="grid"]')?.textContent).toContain('customer');
    await part('DDL');
    expect(root().querySelector('app-db-object-tab .cm-content')?.textContent).toContain(
      'CREATE TABLE shop.orders',
    );
    await clickButton(fixture, 'Copy DDL');
    await clickButton(fixture, 'Refresh', root().querySelector('.db-object-head')!);
    await settle();
    expect(calls('db.describe')).toHaveLength(2);

    const section = fixture.debugElement.injector.get(DbSection);
    await part('Foreign keys');
    await clickButton(fixture, 'Open the related table');
    expect(section.tabs.active()?.path).toEqual([...orders.slice(0, -1), 'customers']);
    section.tabs.activeId.set('o1');
    await settle();
    // Back on its tab, the object shows the view it was left on.
    expect(shown()).toBe('Foreign keys');
    expect(section.tabs.tabs()[0].part).toBe('foreign-keys');
    await part('Referenced by');
    await clickButton(fixture, 'Open the related table');
    expect(section.tabs.active()?.path).toEqual([...orders.slice(0, -1), 'lines']);
    section.tabs.activeId.set('o1');
    await settle();
    await part('DDL');
    await clickButton(fixture, 'Open in a script');
    expect(section.tabs.active()?.kind).toBe('sql');
  });

  // A long walk through the tab: with coverage on a busy machine it takes over 5 seconds.
  it('reads its data on the server, filtered, ordered, counted and related', async () => {
    await part('Data');
    expect(calls('db.connect').at(-1)).toEqual(expect.objectContaining({ session: 'object:o1' }));
    await clickButton(fixture, 'Statement');
    expect(statement()).toBe('SELECT * FROM shop.orders');
    const grid = () => root().querySelector<HTMLElement>('app-db-table-data [role="grid"]')!;
    expect(grid().textContent).toContain('paid');

    // A condition written by hand, then a quick filter from a cell and an order.
    typeCode(root().querySelector('.cm-content[aria-label="Condition (WHERE)"]')!, 'id > 0');
    await settle();
    await clickButton(fixture, 'Apply the filter');
    await settle();
    expect(statement()).toBe('SELECT * FROM shop.orders WHERE (id > 0)');
    grid().querySelector<HTMLElement>('[role="gridcell"][data-row="0"][data-column="0"]')!.click();
    await settle();
    await clickButton(fixture, 'Column', grid().closest('app-data-grid')!);
    await settle();
    const item = [...root().querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
      element.textContent?.includes('Filter: equal to this value'),
    )!;
    item.click();
    await settle();
    expect(statement()).toBe('SELECT * FROM shop.orders WHERE (id > 0) AND status = $1');
    expect(calls('db.execute').at(-1)?.['params']).toEqual(['paid']);
    root().querySelectorAll<HTMLButtonElement>('.grid-sort')[0].click();
    await settle();
    expect(statement()).toContain('ORDER BY status ASC');
    // Changing the filter and order reads the rows again, not the description.
    expect(calls('db.describe')).toHaveLength(1);
    await clickButton(fixture, 'Remove the filter on status');
    await clickButton(fixture, 'Remove status from the order');
    await settle();
    expect(statement()).toBe('SELECT * FROM shop.orders WHERE (id > 0)');

    // The count, more rows and the automatic refresh.
    await clickButton(fixture, 'Count the rows');
    await settle();
    expect(root().querySelector('.db-data-toolbar [role="status"]')?.textContent).toContain(
      '3 rows',
    );
    grid().dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true }),
    );
    await settle();
    // The grid asked for the next page of the cursor.
    expect(calls('db.fetch')[0]).toEqual(expect.objectContaining({ cursor: 'k1' }));
    await clickButton(fixture, 'Refresh by itself');
    expect(buttons(root(), 'Stop refreshing')).toHaveLength(1);
    await clickButton(fixture, 'Stop refreshing');

    // The rows related to the active one, by its keys both ways.
    await clickButton(fixture, 'References');
    await new Promise((done) => setTimeout(done, 300));
    await settle();
    const related = root().querySelector('.db-data-related')!;
    expect(related.textContent).toContain('customers');
    expect(sqls()).toContain('SELECT * FROM shop.customers WHERE id = $1');
    expect(sqls()).toContain('SELECT * FROM shop.lines WHERE order_id = $1');
    await clickButton(fixture, 'Open', related);
    const section = fixture.debugElement.injector.get(DbSection);
    expect(section.tabs.active()?.title).toBe('customers');
    section.tabs.activeId.set('o1');
    await settle();
    await part('Data');
    await clickButton(fixture, 'Statement');

    // An error is said; «Clear» goes back to every row; the statement opens in a script.
    typeCode(root().querySelector('.cm-content[aria-label="Condition (WHERE)"]')!, 'boom');
    await settle();
    await clickButton(fixture, 'Apply the filter');
    await settle();
    expect(root().querySelector('.db-data-error')?.textContent).toContain('boom');
    await clickButton(fixture, 'Clear', root().querySelector('.db-data-actions')!);
    await settle();
    expect(statement()).toBe('SELECT * FROM shop.orders');
    await clickButton(fixture, 'Open in a script', root().querySelector('.db-data-toolbar')!);
    expect(section.tabs.active()?.kind).toBe('sql');
    section.closeTab('o1');
    await settle();
    expect(calls('db.disconnect').at(-1)).toEqual(
      expect.objectContaining({ session: 'object:o1' }),
    );
  }, 15_000);
});
