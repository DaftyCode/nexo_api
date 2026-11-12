import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, fill, renderDeferred } from '../testing/controls';
import { MongoExplorer } from './mongo-explorer';
import { WorkspaceState } from './workspace-state';
import { WorkspaceDocument } from '../domain/models';

const connection = (readOnly = false): WorkspaceDocument => ({
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://localhost', ...(readOnly ? { readOnly: true } : {}) },
});

const order = {
  _id: { $oid: '65a1b2c3d4e5f6a7b8c9d0e1' },
  at: { $date: { $numberLong: '1704164645006' } },
  price: { $numberDecimal: '1.10' },
  items: [{ sku: 'S1' }],
};

/** Each test drives the whole explorer through several dialogs. */
const SLOW = 20_000;

describe('MongoDB writes in the explorer', () => {
  let fixture: ComponentFixture<MongoExplorer>;

  let api: TestApi;

  let state: WorkspaceState;

  let changes = 0;

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

  const dialog = () => root().querySelector<HTMLElement>('[role="dialog"]');

  const confirm = async (label: string | RegExp) => {
    await clickButton(fixture, label, dialog()!);
    await settle();
  };

  const calls = (operation: string) => api.calls.filter((c) => c.operation === operation);

  /** A write answers as the backend: with the record it saved. */
  const written = (operation: string) => () => {
    const id = `change-${++changes}`;
    api.documentsStore.push({
      id,
      workspace_id: 'local',
      kind: 'database-change',
      name: `${operation} shop.orders`,
      revision: 0,
      updated_at: changes,
      value: { connection: 'c1', operation, changes: [{ before: order, after: order }] },
    });
    return { matched: 1, modified: 1, deleted: 1, inserted: [], change: id };
  };

  const open = async (readOnly = false) => {
    fixture = TestBed.createComponent(MongoExplorer);
    fixture.componentRef.setInput('connection', connection(readOnly));
    await settle();
    await click('shop');
    await click(/^orders/);
  };

  beforeEach(async () => {
    changes = 0;
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.databases': { databases: [{ name: 'shop', empty: false }] },
        'mongo.collections': {
          collections: [{ name: 'orders', kind: 'collection', capped: false }],
        },
        'mongo.find': { documents: [order], truncated: false, elapsedMs: 1 },
        'mongo.count': { count: 42 },
        'mongo.stats': {
          count: 1,
          size: 10,
          storageSize: 10,
          totalIndexSize: 10,
          indexes: [],
          capped: false,
        },
      }),
      imports: [MongoExplorer],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    for (const operation of [
      'mongo.insert',
      'mongo.update',
      'mongo.replace',
      'mongo.delete',
      'mongo.undo',
    ])
      api.responses[operation] = written(operation);
  }, SLOW);

  it(
    'counts before writing to many documents and asks for names',
    async () => {
      await open();
      await fill(fixture, 'Filter', "{status: 'A'}");
      await click('Update many…');
      expect(dialog()?.textContent).toContain('42 documents match the filter and will be updated');
      await fill(fixture, 'Update', '{name: 1}', dialog()!);
      await confirm('Update documents');
      expect(dialog()?.textContent).toContain('Write update operators');
      await fill(fixture, 'Update', '{$inc: {n: 1}}', dialog()!);
      await confirm('Update documents');
      expect(calls('mongo.update')[0].payload).toMatchObject({
        filter: { status: 'A' },
        update: { $inc: { n: 1 } },
        many: true,
        expected: 42,
      });

      await click('Empty collection');
      const submit = buttons(dialog()!, 'Delete documents')[0];
      expect(submit.disabled).toBe(true);
      await fill(fixture, 'Type orders to confirm', 'orders', dialog()!);
      expect(submit.disabled).toBe(false);
      await confirm('Delete documents');
      expect(calls('mongo.delete')[0].payload).toMatchObject({
        filter: {},
        many: true,
        expected: 42,
        confirm: 'orders',
      });

      api.responses['mongo.collection.drop'] = {};
      await click('Drop collection');
      await fill(fixture, 'Type orders to confirm', 'orders', dialog()!);
      await confirm('Drop collection');
      expect(calls('mongo.collection.drop')[0].payload).toMatchObject({ confirm: 'orders' });
      expect(text()).toContain('Choose a collection to query it.');
    },
    SLOW,
  );

  it(
    'creates, renames and drops collections and databases',
    async () => {
      await open();
      for (const operation of [
        'mongo.collection.create',
        'mongo.collection.rename',
        'mongo.database.drop',
      ])
        api.responses[operation] = {};
      await click('＋ New collection');
      await fill(fixture, 'Collection name', 'metrics', dialog()!);
      await fill(fixture, 'Time field (time series)', 'at', dialog()!);
      await confirm(/^Create$/);
      expect(calls('mongo.collection.create')[0].payload).toMatchObject({
        database: 'shop',
        collection: 'metrics',
        options: { timeseries: { timeField: 'at' } },
      });
      await click('＋ New database');
      await fill(fixture, 'Database name', 'reports', dialog()!);
      await fill(fixture, 'Collection name', 'daily', dialog()!);
      dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
      await settle();
      await fill(fixture, 'Size in bytes', '4096', dialog()!);
      await confirm(/^Create$/);
      expect(calls('mongo.collection.create')[1].payload).toMatchObject({
        database: 'reports',
        collection: 'daily',
        options: { capped: true, size: 4096 },
      });
      await click(/^orders/);
      await click('Rename collection');
      await fill(fixture, 'New name', 'purchases', dialog()!);
      await confirm(/^Rename$/);
      expect(calls('mongo.collection.rename')[0].payload).toMatchObject({
        collection: 'orders',
        to: 'purchases',
      });
      await click('Drop database');
      await fill(fixture, 'Type shop to confirm', 'shop', dialog()!);
      await confirm('Drop database');
      expect(calls('mongo.database.drop')[0].payload).toMatchObject({
        database: 'shop',
        confirm: 'shop',
      });
      // Escape closes a dialog without writing.
      await click('＋ New database');
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await settle();
      expect(dialog()).toBeNull();
    },
    SLOW,
  );
});
