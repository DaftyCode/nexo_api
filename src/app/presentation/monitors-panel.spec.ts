import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { WorkspaceDocument } from '../domain/models';
import { buttons, clickButton, fill } from '../testing/controls';
import { TEST_API, TestApi, testProviders } from '../testing/providers';
import { MonitorsPanel } from './monitors-panel';
import { WorkspaceState } from './workspace-state';

const NEXT = Date.UTC(2026, 10, 19, 11, 0);

describe('MonitorsPanel', () => {
  let fixture: ComponentFixture<MonitorsPanel>;
  let api: TestApi;
  let state: WorkspaceState;
  const root = () => fixture.nativeElement as HTMLElement;
  const text = () => root().textContent ?? '';
  const settle = async () => {
    for (let i = 0; i < 5; i++) await fixture.whenStable();
  };
  const click = async (label: string | RegExp) => {
    await clickButton(fixture, label);
    await settle();
  };
  const doc = (id: string, kind: string, name: string, value: unknown): WorkspaceDocument => ({
    id,
    workspace_id: 'local',
    kind,
    name,
    revision: 1,
    updated_at: 1,
    value,
  });
  const monitor = () => api.documentsStore.find((d) => d.kind === 'monitor')!;

  async function open(documents: WorkspaceDocument[]) {
    await TestBed.configureTestingModule({
      providers: testProviders({
        'monitor.status': () => ({
          monitors: api.documentsStore
            .filter((d) => d.kind === 'monitor')
            .map((d) => ({ id: d.id, running: false, next: NEXT })),
          finished: [],
          sequence: 0,
          scheduler: true,
        }),
        'monitor.run': { state: 'running' },
      }),
      imports: [MonitorsPanel],
    }).compileComponents();
    api = TestBed.inject(TEST_API);
    api.documentsStore.push(...documents);
    state = TestBed.inject(WorkspaceState);
    state.workspaceId.set('local');
    state.documents.set([...documents]);
    fixture = TestBed.createComponent(MonitorsPanel);
    await settle();
  }

  afterEach(() => vi.restoreAllMocks());

  it('needs a collection first, and says monitors run only while Nexo is open', async () => {
    await open([]);
    expect(text()).toContain('Monitors run only while Nexo is open');
    expect(text()).toContain('Create a collection first: a monitor runs one.');
    expect(buttons(root(), '＋ New monitor')[0].disabled).toBe(true);
  });

  it('creates, runs, pauses, edits and deletes a monitor', async () => {
    await open([
      doc('orders', 'collection', 'Orders', {
        info: { name: 'Orders' },
        item: [
          { id: 'admin', name: 'Admin', item: [] },
          { name: 'List', request: {} },
        ],
      }),
      doc('stage', 'environment', 'Staging', { values: [], protection: 'confirm' }),
      doc('prod', 'environment', 'Production', { values: [], protection: 'readonly' }),
    ]);
    expect(text()).toContain('No monitors yet.');
    expect(text()).toContain('Keep an eye on your API');
    await click('＋ New monitor');
    expect(text()).toContain('New monitor');
    await fill(fixture, 'Name', 'Nightly');
    await fill(fixture, 'Folder', 'admin');
    await fill(fixture, 'Environment', 'prod');
    expect(text()).toContain('This environment is read-only');
    await fill(fixture, 'Environment', 'stage');
    expect(text()).toContain('Send changes without asking');
    await fill(fixture, 'Run', 'cron');
    await fill(fixture, 'Cron expression', '0 9 *');
    expect(text()).toContain('Write the cron expression as five fields');
    expect(buttons(root(), 'Save monitor')[0].disabled).toBe(true);
    await fill(fixture, 'Run', 'hours');
    await fill(fixture, 'Hours', '6');
    await fill(fixture, 'Iteration data (JSON array)', '[{"id": 1}]');
    await click('Save monitor');

    expect(monitor()).toMatchObject({
      kind: 'monitor',
      name: 'Nightly',
      value: {
        collection: 'orders',
        folder: 'admin',
        environment: 'stage',
        schedule: { every: 6, unit: 'hours' },
        data: [{ id: 1 }],
        notify: true,
        paused: false,
      },
    });
    expect(state.toast()).toMatchObject({ title: 'Monitor saved', params: { v0: 'Nightly' } });
    expect(text()).toContain('Every 6 h');
    expect(text()).toContain('Staging');
    expect(text()).toContain('One folder');
    expect(text()).toContain('2026');
    expect(text()).toContain('It has not run yet.');

    await click('▷ Run now');
    expect(api.calls.find((c) => c.operation === 'monitor.run')?.payload).toEqual({
      workspace: 'local',
      id: monitor().id,
    });

    await click('Pause schedule');
    expect(monitor().value).toMatchObject({ paused: true });
    expect(text()).toContain('Resume schedule');
    expect(root().querySelector('.monitor-item .status-pill')?.textContent).toContain('Paused');

    await click(/^Edit$/);
    expect(text()).toContain('Edit monitor');
    await fill(fixture, 'Name', 'Nightly checks');
    await click('Save monitor');
    expect(monitor()).toMatchObject({ name: 'Nightly checks', value: { paused: true } });

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await click(/^Delete$/);
    expect(api.documentsStore.some((d) => d.kind === 'monitor')).toBe(false);
    expect(state.toast()).toMatchObject({ title: 'Monitor deleted' });
    expect(text()).toContain('No monitors yet.');
  });

  it('shows the last runs with what failed', async () => {
    await open([
      doc('orders', 'collection', 'Orders', { info: { name: 'Orders' }, item: [] }),
      doc('m1', 'monitor', 'Hourly', {
        collection: 'gone',
        schedule: { cron: '0 * * * *' },
        allowChanges: true,
      }),
      doc('m1~history', 'monitor-history', 'Hourly', {
        runs: [
          {
            startedAt: NEXT,
            duration: 1200,
            trigger: 'schedule',
            state: 'failed',
            requests: 2,
            passedAssertions: 3,
            failedAssertions: 1,
            failures: [{ request: 'List orders', assertion: 'is fast', error: 'took 3 s' }],
          },
          {
            startedAt: NEXT,
            trigger: 'schedule',
            state: 'skipped',
            error: 'The previous run had not finished',
          },
          { startedAt: NEXT, trigger: 'manual', state: 'passed', requests: 1 },
        ],
      }),
    ]);
    await click('Hourly');
    expect(text()).toContain('Cron 0 * * * *');
    expect(text()).toContain('The collection no longer exists');
    expect(text()).toContain('Sends changes without asking');
    const runs = [...root().querySelectorAll('.monitor-run')];
    expect(runs.map((run) => run.querySelector('.status-pill')?.textContent?.trim())).toEqual([
      'Failed',
      'Skipped',
      'Passed',
    ]);
    expect(runs[0].textContent).toContain('2 requests · 3 assertions passed · 1 failed');
    expect(runs[0].textContent).toContain('is fast');
    expect(runs[0].textContent).toContain('took 3 s');
    expect(runs[1].textContent).toContain('The previous run had not finished');
    expect(runs[2].textContent).toContain('By hand');
    expect(runs[2].textContent).toContain('Nothing failed.');
  });
});
