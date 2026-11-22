import {
  collectionFolders,
  emptyMonitorForm,
  failuresToNotify,
  monitorForm,
  monitorProblem,
  monitorValue,
  readMonitor,
  readMonitorHistory,
  scheduleText,
} from './monitors';

const document = (value: unknown, kind = 'monitor') => ({ id: 'm1', kind, name: 'Nightly', value });

describe('monitors', () => {
  it('reads a monitor from its document, with defaults for what is missing', () => {
    expect(readMonitor(document({}, 'collection'))).toBeUndefined();
    const monitor = readMonitor(
      document({
        collection: 'orders',
        folder: 'admin',
        environment: 'stage',
        schedule: { every: 2, unit: 'hours' },
        iterations: 3,
        delay: 50,
        data: [{ id: 1 }],
        paused: true,
        notify: true,
        allowChanges: true,
      }),
    )!;
    expect(monitor).toMatchObject({
      id: 'm1',
      name: 'Nightly',
      collection: 'orders',
      folder: 'admin',
      environment: 'stage',
      unit: 'hours',
      every: '2',
      iterations: 3,
      delay: 50,
      paused: true,
      notify: true,
      allowChanges: true,
    });
    expect(JSON.parse(monitor.data)).toEqual([{ id: 1 }]);
    expect(monitorForm(monitor)).not.toHaveProperty('id');
    const cron = readMonitor(document({ schedule: { cron: '0 9 * * 1-5' } }))!;
    expect(cron).toMatchObject({ unit: 'cron', cron: '0 9 * * 1-5', every: '15', data: '' });
    expect(readMonitor(document(null))).toMatchObject({
      unit: 'minutes',
      notify: false,
      iterations: 1,
    });
  });

  it('stores only what is set and keeps values the backend accepts', () => {
    const form = { ...emptyMonitorForm('orders'), name: 'A' };
    expect(monitorValue(form, false)).toEqual({
      collection: 'orders',
      schedule: { every: 15, unit: 'minutes' },
      iterations: 1,
      paused: false,
      notify: true,
      allowChanges: false,
    });
    const full = monitorValue(
      {
        ...form,
        folder: 'admin',
        environment: 'stage',
        unit: 'hours',
        every: '5',
        iterations: 5000,
        delay: 70_000,
        data: '[{"id": 1}]',
      },
      true,
    );
    expect(full).toMatchObject({
      folder: 'admin',
      environment: 'stage',
      schedule: { every: 1, unit: 'hours' },
      iterations: 1000,
      delay: 60_000,
      data: [{ id: 1 }],
      paused: true,
    });
    expect(monitorValue({ ...form, unit: 'cron', cron: ' 0 9 * * * ' }, false)['schedule']).toEqual(
      { cron: '0 9 * * *' },
    );
    expect(() => monitorValue({ ...form, data: '{}' }, false)).toThrowError(
      'Iteration data must be a JSON array',
    );
  });

  it('tells what is missing before saving', () => {
    expect(monitorProblem(emptyMonitorForm())).toBe('Choose the collection to run');
    const form = emptyMonitorForm('orders');
    expect(monitorProblem(form)).toBeUndefined();
    expect(monitorProblem({ ...form, unit: 'cron', cron: '0 9 *' })).toContain('five fields');
    expect(monitorProblem({ ...form, data: 'rows' })).toBe('Iteration data must be a JSON array');
  });

  it('describes the schedule and lists the folders that can run alone', () => {
    expect(scheduleText({ unit: 'minutes', every: '15', cron: '' })).toEqual({
      key: 'monitor.everyMinutes',
      params: { v0: '15' },
    });
    expect(scheduleText({ unit: 'hours', every: '2', cron: '' }).key).toBe('monitor.everyHours');
    expect(scheduleText({ unit: 'cron', every: '1', cron: '0 9 * * *' })).toEqual({
      key: 'monitor.cron',
      params: { v0: '0 9 * * *' },
    });
    expect(
      collectionFolders([
        { name: 'List', request: {} },
        { id: 'f1', name: 'Admin', item: [{ id: 'f2', name: 'Users', item: [] }] },
        { name: 'No id', item: [{ id: 'f3', name: 'Inner', item: [] }] },
      ]),
    ).toEqual([
      { id: 'f1', path: 'Admin' },
      { id: 'f2', path: 'Admin / Users' },
      { id: 'f3', path: 'No id / Inner' },
    ]);
    expect(collectionFolders(undefined)).toEqual([]);
  });

  it('reads the history and picks the failures to notify', () => {
    expect(readMonitorHistory(undefined)).toEqual([]);
    const [failed, odd] = readMonitorHistory({
      runs: [
        {
          startedAt: 5,
          duration: 9,
          trigger: 'manual',
          state: 'failed',
          requests: 2,
          failedAssertions: 1,
          failures: [{ request: 'List', assertion: 'is fast', error: 'slow' }, 'x'],
          error: 'boom',
        },
        { state: 'weird', trigger: 'cron' },
      ],
    });
    expect(failed).toMatchObject({
      trigger: 'manual',
      state: 'failed',
      requests: 2,
      failedAssertions: 1,
      failedRequests: 0,
      error: 'boom',
    });
    expect(failed.failures).toEqual([{ request: 'List', assertion: 'is fast', error: 'slow' }, {}]);
    expect(odd).toMatchObject({ state: 'error', trigger: 'schedule', failures: [] });
    const event = { sequence: 1, workspace: 'w', monitor: 'm', name: 'M' };
    expect(
      failuresToNotify([
        { ...event, state: 'failed', notify: true },
        { ...event, state: 'error', notify: true },
        { ...event, state: 'failed', notify: false },
        { ...event, state: 'passed', notify: true },
        { ...event, state: 'skipped', notify: true },
        { ...event, state: 'differences', notify: true },
      ]).map((e) => e.state),
    ).toEqual(['failed', 'error', 'differences']);
  });
});
