import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, fill, renderDeferred } from '../testing/controls';
import { MongoIndexes } from './mongo-indexes';
import { WorkspaceState } from './workspace-state';
import { WorkspaceDocument } from '../domain/models';

const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://{{host}}' },
};
const int = (n: number) => ({ $numberInt: String(n) });

describe('MongoIndexes', () => {
  let fixture: ComponentFixture<MongoIndexes>;
  let api: TestApi;
  let state: WorkspaceState;
  let indexes: Record<string, unknown>[];
  let changed = 0;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent?.replace(/\s+/g, ' ') ?? '';
  const settle = async () => {
    for (let i = 0; i < 4; i++) await fixture.whenStable();
    await renderDeferred(fixture);
  };
  const click = async (label: string | RegExp, within: Element = root()) => {
    await clickButton(fixture, label, within);
    await settle();
  };
  const dialog = () => root().querySelector<HTMLElement>('[role="dialog"]');
  const calls = (operation: string) => api.calls.filter((c) => c.operation === operation);

  async function mount(writable: boolean) {
    fixture = TestBed.createComponent(MongoIndexes);
    fixture.componentRef.setInput('connection', connection);
    fixture.componentRef.setInput('target', { database: 'shop', collection: 'orders' });
    fixture.componentRef.setInput('writable', writable);
    fixture.componentInstance.changed.subscribe(() => changed++);
    await settle();
  }

  beforeEach(async () => {
    changed = 0;
    indexes = [
      { name: '_id_', spec: { key: { _id: int(1) } }, size: 4096, accesses: 3 },
      {
        name: 'at_1',
        spec: { key: { at: int(1) }, expireAfterSeconds: int(3600) },
        size: 36864,
        accesses: 12,
        since: '2024-01-02T03:04:05Z',
      },
    ];
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.indexes': () => ({ indexes }),
        'mongo.index.create': ({ keys, options }: Record<string, unknown>) => {
          const name = (options as { name?: string } | undefined)?.name ?? 'status_1_at_-1';
          indexes = [...indexes, { name, spec: { key: keys, unique: true } }];
          return { done: true };
        },
        'mongo.index.hide': () => ({ done: true }),
        'mongo.index.drop': ({ name }: Record<string, unknown>) => {
          indexes = indexes.filter((index) => index['name'] !== name);
          return { done: true };
        },
      }),
      imports: [MongoIndexes],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
  });

  it('lists each index with its kind, size and use', async () => {
    await mount(true);
    expect(calls('mongo.indexes')[0].payload).toEqual({
      workspace: 'local',
      connection: { uri: 'mongodb://{{host}}' },
      database: 'shop',
      collection: 'orders',
    });
    expect(text()).toContain('{ _id: 1 }');
    expect(text()).toContain('TTL');
    expect(text()).toContain('documents expire after 3600 s');
    expect(text()).toContain('36.0 KB');
    expect(text()).toMatch(/12 uses since/);
    // The _id index can be neither hidden nor dropped.
    expect(buttons(root(), 'Drop index _id_')).toHaveLength(0);
    expect(buttons(root(), 'Drop index at_1')).toHaveLength(1);
  });

  it('creates an index from its form, and says what to correct first', async () => {
    await mount(true);
    await click('New index');
    await click('Create index');
    expect(text()).toContain('Write the keys as a document with at least one field');
    expect(calls('mongo.index.create')).toHaveLength(0);

    await fill(fixture, 'Keys', '{ status: 1, at: -1 }');
    root().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await settle();
    await fill(fixture, 'Partial filter', "{ status: { $in: ['A', 'B'] } }");
    await click('Create index');
    expect(calls('mongo.index.create')[0].payload).toEqual({
      workspace: 'local',
      connection: { uri: 'mongodb://{{host}}' },
      connectionId: 'c1',
      database: 'shop',
      collection: 'orders',
      keys: { status: 1, at: -1 },
      options: { unique: true, partialFilterExpression: { status: { $in: ['A', 'B'] } } },
    });
    expect(state.toast()).toMatchObject({
      kind: 'success',
      title: 'Index created',
      params: { v0: 'status_1_at_-1' },
    });
    expect(text()).toContain('status_1_at_-1');
    expect(changed).toBe(1);
  });

  it('hides and drops indexes after saying what changes, and keeps the dialog on failure', async () => {
    await mount(true);
    await click('Hide index at_1');
    expect(dialog()?.textContent).toContain('The query planner stops using at_1');
    await click(/^\s*Hide index\s*$/, dialog()!);
    expect(calls('mongo.index.hide')[0].payload).toMatchObject({ name: 'at_1', hidden: true });
    expect(state.toast()).toMatchObject({ title: 'Index hidden', params: { v0: 'at_1' } });
    expect(dialog()).toBeNull();

    api.responses['mongo.index.drop'] = () => {
      throw new Error('The server refused the command: index not found (IndexNotFound)');
    };
    await click('Drop index at_1');
    const drop = buttons(dialog()!, /^\s*Drop index\s*$/)[0];
    expect(drop.disabled).toBe(true);
    await fill(fixture, 'Type at_1 to confirm', 'at_1', dialog()!);
    await click(/^\s*Drop index\s*$/, dialog()!);
    expect(dialog()?.textContent).toContain('IndexNotFound');
    expect(calls('mongo.index.drop')[0].payload).toMatchObject({ name: 'at_1', confirm: 'at_1' });

    api.responses['mongo.index.drop'] = () => {
      indexes = indexes.filter((index) => index['name'] !== 'at_1');
      return { done: true };
    };
    await click(/^\s*Drop index\s*$/, dialog()!);
    expect(dialog()).toBeNull();
    expect(state.toast()).toMatchObject({ title: 'Index dropped', params: { v0: 'at_1' } });
    expect(text()).not.toContain('at_1');
    expect(changed).toBe(2);
  });

  it('only lists indexes on a read-only connection, and says why it cannot', async () => {
    await mount(false);
    expect(buttons(root(), 'New index')).toHaveLength(0);
    expect(buttons(root(), /Drop|Hide/)).toHaveLength(0);
    api.responses['mongo.indexes'] = () => {
      throw new Error('The user may not do this: not authorized');
    };
    await click('Refresh');
    expect(root().querySelector('[role="alert"]')?.textContent).toContain('not authorized');
  });
});
