import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { WorkspaceUseCases } from '../application/workspace-use-cases';
import { WORKSPACE } from '../composition/providers';
import { MonitorEvent, MonitorStatus } from '../domain/monitors';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { MonitorsStore } from './monitors-store';
import { WorkspaceState } from './workspace-state';

describe('MonitorsStore', () => {
  let api: TestApi;
  let state: WorkspaceState;
  let store: MonitorsStore;
  let answer: MonitorStatus;
  const shown: string[][] = [];
  const event = (sequence: number, state: MonitorEvent['state'], notify = true): MonitorEvent => ({
    sequence,
    workspace: 'local',
    monitor: 'm1',
    name: 'Nightly',
    state,
    notify,
    failedAssertions: 2,
    failedRequests: 1,
  });
  const statuses = () => api.calls.filter((call) => call.operation === 'monitor.status');
  const monitor = {
    id: 'm1',
    workspace_id: 'local',
    kind: 'monitor',
    name: 'Nightly',
    revision: 1,
    updated_at: 1,
    value: { collection: 'c', schedule: { every: 5, unit: 'minutes' } },
  };

  beforeEach(async () => {
    shown.length = 0;
    answer = {
      monitors: [{ id: 'm1', running: true, next: null }],
      finished: [],
      sequence: 4,
      scheduler: true,
    };
    const providers = testProviders({ 'monitor.status': () => answer });
    const testApi = (
      providers.find((p) => (p as { provide?: unknown }).provide === TEST_API) as {
        useValue: TestApi;
      }
    ).useValue;
    await TestBed.configureTestingModule({
      providers: [
        ...providers,
        {
          provide: WORKSPACE,
          useValue: new WorkspaceUseCases(testApi, undefined as never, undefined, undefined, {
            permission: () => 'granted',
            request: async () => 'granted',
            show: (title, body) => void shown.push([title, body]),
          }),
        },
      ],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    state = TestBed.inject(WorkspaceState);
    store = TestBed.inject(MonitorsStore);
  });
  afterEach(() => vi.useRealTimers());

  it('asks only while the workspace has monitors, and notifies the failures after the first answer', async () => {
    state.workspaceId.set('local');
    TestBed.tick();
    await Promise.resolve();
    expect(statuses()).toEqual([]);

    state.documents.set([monitor]);
    TestBed.tick();
    await vi.waitFor(() => expect(store.status()?.sequence).toBe(4));
    expect(statuses()[0].payload).toEqual({ workspace: 'local', after: 0 });
    expect(store.live('m1')?.running).toBe(true);
    expect(store.live('other')).toBeUndefined();

    // What finished before is not notified; what finishes later is, when it fails.
    answer = {
      ...answer,
      finished: [event(5, 'failed'), event(6, 'passed'), event(7, 'error', false)],
      sequence: 7,
    };
    await store.refresh();
    expect(statuses().at(-1)?.payload).toEqual({ workspace: 'local', after: 4 });
    expect(shown).toEqual([['Monitor «Nightly» failed', '2 assertions and 1 requests failed']]);
    expect(store.finished().map((e) => e.sequence)).toEqual([5, 6, 7]);
    answer = { ...answer, finished: [{ ...event(8, 'error'), error: 'Boom' }], sequence: 8 };
    await store.refresh();
    expect(shown.at(-1)).toEqual(['Monitor «Nightly» failed', 'Boom']);

    // Without monitors it stops asking.
    state.documents.set([]);
    TestBed.tick();
    const asked = statuses().length;
    await store.refresh();
    expect(statuses().length).toBe(asked);
  });

  it('asks every two seconds while a monitor runs and every fifteen while none does', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    state.workspaceId.set('local');
    state.documents.set([monitor]);
    TestBed.tick();
    await vi.waitFor(() => expect(statuses().length).toBe(1));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses().length).toBe(2);
    answer = { ...answer, monitors: [{ id: 'm1', running: false, next: null }] };
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses().length).toBe(3);
    await vi.advanceTimersByTimeAsync(14_000);
    expect(statuses().length).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses().length).toBe(4);
    // Something started here asks at once and then soon.
    answer = { ...answer, monitors: [{ id: 'm1', running: true, next: null }] };
    await store.refresh();
    expect(statuses().length).toBe(5);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(statuses().length).toBe(6);
  });
});
