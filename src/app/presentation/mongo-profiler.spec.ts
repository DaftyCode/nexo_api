import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { buttons, clickButton, fill, renderDeferred } from '../testing/controls';
import { MongoProfiler } from './mongo-profiler';
import { WorkspaceState } from './workspace-state';
import { WorkspaceDocument } from '../domain/models';
import { Explainable } from '../domain/mongo-indexes';

const connection: WorkspaceDocument = {
  id: 'c1',
  workspace_id: 'local',
  kind: 'connection',
  name: 'Local',
  revision: 1,
  updated_at: 0,
  value: { uri: 'mongodb://localhost' },
};

describe('MongoProfiler', () => {
  let fixture: ComponentFixture<MongoProfiler>;
  let api: TestApi;
  let state: WorkspaceState;
  let level = 0;
  const explained: Explainable[] = [];
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
    fixture = TestBed.createComponent(MongoProfiler);
    fixture.componentRef.setInput('connection', connection);
    fixture.componentRef.setInput('database', 'shop');
    fixture.componentRef.setInput('collection', 'orders');
    fixture.componentRef.setInput('writable', writable);
    fixture.componentInstance.explain.subscribe((entry) => explained.push(entry));
    await settle();
  }

  beforeEach(async () => {
    level = 0;
    explained.length = 0;
    await TestBed.configureTestingModule({
      providers: testProviders({
        'mongo.profile': () => ({ level, slowms: 100 }),
        'mongo.profile.set': (payload: Record<string, unknown>) => {
          level = payload['level'] as number;
          return { level, slowms: payload['slowms'] };
        },
        'mongo.profile.entries': {
          entries: [
            {
              op: 'query',
              ns: 'shop.orders',
              millis: 812,
              ts: '2024-01-02T03:04:05Z',
              planSummary: 'COLLSCAN',
              docsExamined: 100000,
              keysExamined: 0,
              returned: 3,
              command: { find: 'orders', filter: { status: 'A' }, $db: 'shop' },
            },
            { op: 'insert', ns: 'shop.orders', millis: 20, command: { insert: 'orders' } },
          ],
        },
      }),
      imports: [MongoProfiler],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
  });

  it('lists the slowest operations, and explains a recorded query again', async () => {
    await mount(true);
    expect(text()).toContain('Profiler of shop: Off');
    expect(calls('mongo.profile.entries')[0].payload).toEqual({
      workspace: 'local',
      connection: { uri: 'mongodb://localhost' },
      database: 'shop',
    });
    expect(text()).toContain('812');
    expect(text()).toContain('COLLSCAN');
    // Only the find can be explained again.
    expect(buttons(root(), /^\s*Explain\s*$/)).toHaveLength(1);
    await click(/^\s*Explain\s*$/);
    expect(explained).toEqual([
      {
        database: 'shop',
        collection: 'orders',
        query: { filter: { status: 'A' } },
      },
    ]);
    // Only the operations of the collection shown.
    root().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    await settle();
    expect(calls('mongo.profile.entries').at(-1)?.payload).toMatchObject({
      collection: 'orders',
    });
  });

  it('changes the profiler on the server only after saying what it does', async () => {
    await mount(true);
    const select = root().querySelector<HTMLSelectElement>('select')!;
    select.value = '2';
    select.dispatchEvent(new Event('change'));
    await fill(fixture, 'Slower than (ms)', '20');
    await click('Apply');
    expect(dialog()?.textContent).toContain('records every operation of every client in shop');
    await click(/^\s*Cancel\s*$/, dialog()!);
    expect(calls('mongo.profile.set')).toHaveLength(0);

    await click('Apply');
    await click(/^\s*Change the profiler\s*$/, dialog()!);
    expect(calls('mongo.profile.set')[0].payload).toEqual({
      workspace: 'local',
      connection: { uri: 'mongodb://localhost' },
      connectionId: 'c1',
      database: 'shop',
      level: 2,
      slowms: 20,
    });
    expect(state.toast()).toMatchObject({ title: 'Profiler changed' });
    expect(text()).toContain('Every operation');

    await fill(fixture, 'Slower than (ms)', 'fast');
    expect(buttons(root(), 'Apply')[0].disabled).toBe(true);
  });

  it('only reads the profiler on a read-only connection', async () => {
    await mount(false);
    expect(buttons(root(), 'Apply')).toHaveLength(0);
    expect(root().querySelector('select')).toBeNull();
  });
});
