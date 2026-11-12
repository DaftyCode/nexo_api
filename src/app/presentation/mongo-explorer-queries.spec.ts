import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, fill, renderDeferred } from '../testing/controls';
import { MongoExplorer } from './mongo-explorer';
import { WorkspaceState } from './workspace-state';
import { WorkspaceDocument } from '../domain/models';
import collscan from '../testing/explain/mongo-8.0-collscan.json';

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

describe('MongoExplorer', { timeout: 20_000 }, () => {
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
        'mongo.explain': { explain: collscan },
        'mongo.indexes': { indexes: [{ name: '_id_', spec: { key: { _id: 1 } } }] },
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
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Query saved',
      params: { v0: 'Open orders' },
    });
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

  it('explains the query of the bar, with its stages, and offers indexes and the profiler', async () => {
    await openOrders();
    await fill(fixture, 'Filter', "{status: 'A'}");
    await fill(fixture, 'Sort', '{at: -1}');
    await clickButton(fixture, /^\s*Explain\s*$/, root().querySelector('.mongo-actions')!);
    await settle();
    expect(calls('mongo.explain')[0].payload).toMatchObject({
      workspace: 'local',
      database: 'shop',
      collection: 'orders',
      filter: { status: 'A' },
      sort: { at: -1 },
      verbosity: 'executionStats',
    });
    // The explain tab shows the plan: a collection scan and a sort in memory, marked.
    const stages = [...root().querySelectorAll('.explain-stage strong')].map((s) => s.textContent);
    expect(stages).toEqual(['COLLSCAN', 'SORT']);
    expect(text()).toContain('Collection scan: no index is used');
    expect(text()).toContain('Sorted in memory');
    expect(text()).toContain('Run and measured');
    expect(root().querySelector('.explain-stage.danger')?.textContent).toContain('2000');
    await click('Plan only');
    expect(calls('mongo.explain')[1].payload).toMatchObject({ verbosity: 'queryPlanner' });
    await click(/^\s*JSON\s*$/);
    expect(root().querySelector('.explain-json')?.textContent).toContain('"winningPlan"');

    await click(/^\s*Indexes\s*$/);
    expect(calls('mongo.indexes')).toHaveLength(1);
    expect(root().querySelector('app-mongo-indexes')?.textContent).toContain('_id_');
    // A view has no indexes of its own.
    await click(/^recent/);
    expect(buttons(root(), /^\s*Indexes\s*$/)).toHaveLength(0);
    expect(buttons(root(), /^\s*Profiler\s*$/)).toHaveLength(1);
  });
});
