import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { clickButton, codeText, exerciseControls, fill, renderDeferred } from '../testing/controls';
import { MongoExplorer } from './mongo-explorer';
import { WorkspaceState } from './workspace-state';
import { WorkspaceDocument } from '../domain/models';

const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: {
    uri: 'mongodb://{{host}}:27017',
    password: '{{vault:mongo-password:c1}}',
    color: '#57ab5a',
  },
};
const oid = (n: number) => ({ $oid: `65a1b2c3d4e5f6a7b8c9d0e${n}` });
const order = (n: number) => ({
  _id: oid(n),
  n: { $numberInt: String(n) },
  at: { $date: { $numberLong: '1704164645006' } },
  customer: { name: `C${n}`, city: 'Madrid' },
  items: [{ sku: 'S1', qty: { $numberInt: '2' } }, { sku: 'T1' }],
});

describe('MongoExplorer', () => {
  let fixture: ComponentFixture<MongoExplorer>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const click = async (label: string | RegExp) => {
    await clickButton(fixture, label);
    await settle();
  };
  const calls = (operation: string) => api.calls.filter((c) => c.operation === operation);
  const copied: string[] = [];

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.databases': { databases: [{ name: 'shop', sizeOnDisk: 2048, empty: false }] },
        'mongo.collections': {
          collections: [
            { name: 'orders', kind: 'collection', capped: false },
            { name: 'recent', kind: 'view', viewOn: 'orders', capped: false },
            { name: 'fs.files', kind: 'collection', gridfs: 'fs', capped: false },
          ],
        },
        'mongo.stats': {
          count: 100000,
          size: 3 * 1024 * 1024,
          storageSize: 1024,
          averageDocumentSize: 31,
          totalIndexSize: 4096,
          indexes: [{ name: '_id_', keys: { _id: { $numberInt: '1' } }, unique: true }],
          capped: false,
        },
        'mongo.find': {
          documents: [order(1), order(2)],
          cursor: 'c-1',
          truncated: false,
          elapsedMs: 4,
        },
        'mongo.more': { documents: [order(3)], truncated: false, elapsedMs: 2 },
        'mongo.count': { count: 42 },
        'mongo.cancel': { cancelled: true },
      }),
      imports: [MongoExplorer],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    copied.length = 0;
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value: string) => void copied.push(value) },
    });
    fixture = TestBed.createComponent(MongoExplorer);
    fixture.componentRef.setInput('connection', connection);
    await settle();
  });

  const openOrders = async () => {
    await click('shop');
    await click(/^orders/);
  };

  it('lists databases and collections, and pages through a query with its cursor', async () => {
    expect(text()).toContain('shop');
    expect(text()).toContain('2.0 KB');
    await click('shop');
    expect(calls('mongo.collections')[0].payload).toMatchObject({
      database: 'shop',
      connection: { uri: 'mongodb://{{host}}:27017', password: '{{vault:mongo-password:c1}}' },
    });
    expect(text()).toContain('View');
    expect(text()).toContain('GridFS');
    await click(/^orders/);
    // Choosing a collection runs its query, as Compass does, and reads its statistics.
    expect(calls('mongo.find')).toHaveLength(1);
    expect(text()).toContain('100000');
    expect(text()).toContain('3.0 MB');
    expect(root().querySelector('[data-testid="mongo-range"]')?.textContent).toContain(
      'Documents 1 to 2',
    );

    await fill(
      fixture,
      'Filter',
      "{customer.city: 'Madrid', _id: {$gte: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1')}}",
    );
    await fill(fixture, 'Sort', '{n: -1}');
    await fill(fixture, 'Page', '20');
    await click(/^Find$/);
    const find = calls('mongo.find')[1].payload;
    expect(find).toMatchObject({
      workspace: 'local',
      database: 'shop',
      collection: 'orders',
      filter: { 'customer.city': 'Madrid', _id: { $gte: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' } } },
      sort: { n: -1 },
      pageSize: 20,
    });
    // Only the fields the backend accepts (it refuses unknown ones).
    expect(Object.keys(find).sort()).toEqual([
      'collection',
      'connection',
      'database',
      'filter',
      'id',
      'pageSize',
      'sort',
      'workspace',
    ]);
    expect(Object.keys(calls('mongo.stats')[0].payload).sort()).toEqual([
      'collection',
      'connection',
      'database',
      'workspace',
    ]);
    expect(
      api.calls.filter((c) => c.operation === 'mongo.close').map((c) => c.payload['cursor']),
    ).toEqual(['c-1']);

    await click('Next page');
    expect(calls('mongo.more')[0].payload).toMatchObject({ cursor: 'c-1', pageSize: 20 });
    expect(root().querySelector('[data-testid="mongo-range"]')?.textContent).toContain(
      'Documents 3 to 3',
    );
    expect(root().querySelector<HTMLButtonElement>('[aria-label="Next page"]')?.disabled).toBe(
      true,
    );
    await click('Previous page');
    expect(calls('mongo.more')).toHaveLength(1);
    expect(calls('mongo.find')).toHaveLength(2);
    await click('Count documents');
    expect(calls('mongo.count')[0].payload).toMatchObject({ filter: find['filter'] });
    expect(text()).toContain('of 42');

    // Each query run is in the history, without its results.
    const history = api.documentsStore.filter((d) => d.kind === 'query-history');
    expect(history.map((d) => d.name)).toEqual([
      'shop.orders',
      "shop.orders {customer.city: 'Madrid', _id: {$gte: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1')}}",
    ]);
    expect(JSON.stringify(history)).not.toContain('C1');
  });

  it('shows each value with its type, opens documents and arrays, and copies', async () => {
    await openOrders();
    expect(text()).toContain('65a1b2c3d4e5f6a7b8c9d0e1');
    expect(text()).toContain('2024-01-02T03:04:05.006Z');
    // An embedded document opens into columns of its fields.
    await click('{ 2 fields }');
    const headers = () =>
      [...root().querySelectorAll('thead th')].map((th) =>
        th.textContent?.replace(/[⊞⊟]/g, '').trim(),
      );
    expect(headers()).toContain('customer.name');
    expect(headers()).toContain('customer.city');
    await click('Show customer as one column again');
    expect(headers()).toContain('customer');
    await click('{ 2 fields }');
    // An array is entered as a table of its own.
    await click('[ 2 elements ]');
    expect(text()).toContain('items (1)');
    expect(text()).toContain('S1');
    await click(/^S1$/);
    await click('Copy value');
    expect(copied).toEqual(['S1']);
    await click(/^Documents$/);
    await click('65a1b2c3d4e5f6a7b8c9d0e1');
    await click('Copy ObjectId date');
    await click('Copy document');
    expect(copied[1]).toBe('2024-01-12T21:44:35.000Z');
    expect(copied[2]).toContain('"_id": ObjectId("65a1b2c3d4e5f6a7b8c9d0e1")');
    expect(text()).toContain('Document copied');

    await click(/^Tree$/);
    expect(text()).toContain('(1) 65a1b2c3d4e5f6a7b8c9d0e1');
    await click('(1) 65a1b2c3d4e5f6a7b8c9d0e1');
    expect(text()).toContain('Int32');
    await click(/^JSON$/);
    expect(codeText(root(), 'Results')).toContain('"n": NumberInt(1)');
    await fill(fixture, 'Format', 'canonical');
    expect(codeText(root(), 'Results')).toContain('"$numberInt": "1"');
  });

  it('explains a query it cannot read, and cancels one that runs', async () => {
    await openOrders();
    await fill(fixture, 'Filter', '{a: }');
    await click(/^Find$/);
    expect(calls('mongo.find')).toHaveLength(1);
    expect(root().querySelector('.mongo-problem')?.textContent).toMatch(
      /Filter:\s+Unexpected character\s+\(}\)\s+—\s+line 1, column 5/,
    );
    await fill(fixture, 'Filter', '{user: {{userId}}}');
    await click(/^Find$/);
    expect(text()).toContain('The variable userId is not defined in the active environment');

    let release: (value: unknown) => void = () => undefined;
    api.responses['mongo.find'] = () => new Promise((resolve) => (release = resolve));
    await fill(fixture, 'Filter', '{}');
    await clickButton(fixture, /^Find$/);
    await fixture.whenStable();
    const running = calls('mongo.find').at(-1)!.payload['id'];
    await click(/^Cancel$/);
    expect(calls('mongo.cancel')[0].payload).toEqual({ workspace: 'local', id: running });
    release({ documents: [], truncated: false, elapsedMs: 1 });
    await settle();
    expect(text()).toContain('No documents');
  });

  it('saves queries, reopens them, and runs them from the history', async () => {
    await openOrders();
    await fill(fixture, 'Filter', "{status: 'A'}");
    await click('More options');
    await fill(fixture, 'Limit', '10');
    await fill(fixture, 'Query name', 'Open orders');
    await fill(fixture, 'Folder', 'Reports');
    await click('Save query');
    const [saved] = api.documentsStore.filter((d) => d.kind === 'query');
    expect(saved).toMatchObject({
      name: 'Open orders',
      value: {
        folder: 'Reports',
        connection: 'c1',
        database: 'shop',
        collection: 'orders',
        filter: "{status: 'A'}",
        limit: '10',
      },
    });
    expect(text()).toContain('Query saved');
    expect(root().querySelector('.mongo-folder')?.textContent).toBe('Reports');
    await click(/^Clear$/);
    await click('Open orders');
    expect(calls('mongo.find').at(-1)!.payload).toMatchObject({
      filter: { status: 'A' },
      limit: 10,
    });
    await click(/^Clear$/);
    await click(/^shop\.orders$/);
    expect(calls('mongo.find').at(-1)!.payload['filter']).toBeUndefined();
    state.confirm = () => true;
    await click('Delete the query Open orders');
    expect(api.documentsStore.filter((d) => d.kind === 'query')).toEqual([]);
  });

  it('every control of the query reaches the model', async () => {
    await openOrders();
    await click('More options');
    const unchanged = await exerciseControls(fixture, () => fixture.componentInstance['model'](), {
      skip: (control) => control.closest('.mongo-format') !== null,
    });
    expect(unchanged).toEqual([]);
  });
});
