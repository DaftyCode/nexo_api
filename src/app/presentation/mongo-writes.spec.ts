import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, codeText, fill, renderDeferred } from '../testing/controls';
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
    'edits a field keeping its type, the whole document, and undoes a change',
    async () => {
      await open();
      await click('2024-01-02T03:04:05.006Z');
      await click('Edit value');
      expect(codeText(dialog()!, 'Value')).toBe('ISODate("2024-01-02T03:04:05.006Z")');
      await fill(fixture, 'Value', 'ISODate("2025-05-05T00:00:00Z")', dialog()!);
      await confirm(/^Save$/);
      const update = calls('mongo.update')[0].payload;
      expect(update).toEqual({
        workspace: 'local',
        connection: { uri: 'mongodb://localhost' },
        connectionId: 'c1',
        database: 'shop',
        collection: 'orders',
        filter: { _id: order._id },
        update: { $set: { at: { $date: { $numberLong: '1746403200000' } } } },
      });
      expect(dialog()).toBeNull();
      expect(text()).toContain('Value saved');
      // The page is read again after a write.
      expect(calls('mongo.find')).toHaveLength(2);

      // An element of an array entered is edited by its full path.
      await click('[ 1 element ]');
      await click(/^S1$/);
      await click('Edit value');
      await fill(fixture, 'Value', "'S2'", dialog()!);
      await confirm(/^Save$/);
      expect(calls('mongo.update')[1].payload['update']).toEqual({ $set: { 'items.0.sku': 'S2' } });

      await click(/^Documents$/);
      await click('Choose document 1');
      await click('Edit document');
      expect(codeText(dialog()!, 'Document')).toContain('"price": NumberDecimal("1.10")');
      await fill(fixture, 'Document', '{a: }', dialog()!);
      await confirm(/^Save$/);
      expect(dialog()?.textContent).toContain('Unexpected character');
      await fill(
        fixture,
        'Document',
        "{_id: ObjectId('65a1b2c3d4e5f6a7b8c9d0e1'), price: NumberDecimal('2.50')}",
        dialog()!,
      );
      await confirm(/^Save$/);
      expect(calls('mongo.replace')[0].payload).toMatchObject({
        filter: { _id: order._id },
        replacement: { _id: order._id, price: { $numberDecimal: '2.50' } },
      });

      // Recorded writes are listed, and undone.
      expect(text()).toContain('mongo.replace shop.orders');
      await click('Undo mongo.replace shop.orders');
      await confirm(/^Undo$/);
      expect(calls('mongo.undo')[0].payload).toMatchObject({
        connectionId: 'c1',
        change: 'change-3',
      });
    },
    SLOW,
  );

  it(
    'removes fields, duplicates, deletes and inserts documents',
    async () => {
      await open();
      await click('2024-01-02T03:04:05.006Z');
      await click('Remove field');
      await confirm(/^Remove field$/);
      expect(calls('mongo.update')[0].payload['update']).toEqual({ $unset: { at: '' } });
      await click('Choose document 1');
      await click('Duplicate document');
      expect(codeText(dialog()!, 'Documents')).not.toContain('_id');
      await confirm(/^Insert$/);
      expect(calls('mongo.insert')[0].payload['documents']).toEqual([
        { at: order.at, price: order.price, items: order.items },
      ]);
      await click('Choose document 1');
      await click('Delete document');
      expect(dialog()?.textContent).toContain('ObjectId("65a1b2c3d4e5f6a7b8c9d0e1")');
      await confirm(/^Delete document$/);
      expect(calls('mongo.delete')[0].payload).toMatchObject({ filter: { _id: order._id } });
      expect(calls('mongo.delete')[0].payload['many']).toBeUndefined();
      await click('Insert documents');
      await fill(fixture, 'Documents', "[{n: NumberLong('1')}, {n: 2}]", dialog()!);
      const concern = root().querySelector<HTMLSelectElement>('.mongo-write-bar select')!;
      concern.value = 'majority';
      concern.dispatchEvent(new Event('change'));
      await confirm(/^Insert$/);
      expect(calls('mongo.insert')[1].payload).toMatchObject({
        documents: [{ n: { $numberLong: '1' } }, { n: 2 }],
        writeConcern: { w: 'majority' },
      });
    },
    SLOW,
  );

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

  it(
    'shows no write on a read-only connection',
    async () => {
      await open(true);
      expect(text()).toContain('Read-only');
      expect(buttons(root(), 'Insert documents')).toEqual([]);
      expect(buttons(root(), 'Edit')).toEqual([]);
      expect(buttons(root(), '＋ New collection')).toEqual([]);
    },
    SLOW,
  );
});
