import { WorkspaceDocument } from '../../domain/models';
import { MonitorEvent, emptyMonitorForm } from '../../domain/monitors';
import { ApiFailure, NotificationPermission, NotificationPort } from '../ports';
import { MonitorCases } from './monitors';

function setup(history: () => unknown = () => ({ value: { runs: [{ state: 'passed' }] } })) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record =
    (method: string, answer?: (...args: unknown[]) => unknown) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return answer?.(...args);
    };
  const api = {
    execute: record('execute', (operation) =>
      operation === 'monitor.status'
        ? { monitors: [], finished: [], sequence: 3, scheduler: true }
        : { state: 'running' },
    ),
    save: record('save', (document) => ({
      ...(document as WorkspaceDocument),
      revision: (document as WorkspaceDocument).revision + 1,
    })),
    remove: record('remove'),
    document: record('document', history),
  };
  const shown: string[][] = [];
  let permission: NotificationPermission = 'default';
  const notifications: NotificationPort = {
    permission: () => permission,
    request: async () => (permission = 'granted'),
    show: (title, body) => void shown.push([title, body]),
  };
  return { cases: new MonitorCases(api as never, notifications), calls, shown };
}

const document = (id: string, name: string, value: unknown): WorkspaceDocument => ({
  id,
  workspace_id: 'local',
  kind: 'monitor',
  name,
  revision: 2,
  updated_at: 1,
  value,
});

describe('MonitorCases', () => {
  it('lists, saves, pauses and deletes monitors', async () => {
    const { cases, calls } = setup();
    const b = document('b', 'Billing', { collection: 'c', paused: true });
    const listed = cases.monitors([
      b,
      document('a', 'Accounts', { collection: 'c' }),
      { ...b, id: 'x', kind: 'collection' },
    ]);
    expect(listed.map((m) => m.name)).toEqual(['Accounts', 'Billing']);

    const created = await cases.save('local', 'n1', { ...emptyMonitorForm('c'), name: ' ' });
    expect(created).toMatchObject({ id: 'n1', kind: 'monitor', name: 'Monitor', revision: 1 });
    expect(created.value).toMatchObject({ collection: 'c', paused: false });
    // Editing keeps it paused.
    const edited = await cases.save('local', 'b', { ...emptyMonitorForm('c'), name: 'B' }, b);
    expect(edited).toMatchObject({ revision: 3, name: 'B', value: { paused: true } });
    const resumed = await cases.setPaused(b, false);
    expect(resumed.value).toEqual({ collection: 'c', paused: false });
    await cases.remove(b);
    expect(calls.map((c) => c.method)).toEqual(['save', 'save', 'save', 'remove']);
  });

  it('reads the history, which does not exist before the first run', async () => {
    expect(await setup().cases.history('m1')).toEqual([
      expect.objectContaining({ state: 'passed' }),
    ]);
    const { cases, calls } = setup(() => {
      throw new ApiFailure('Resource not found', 'not_found', 404);
    });
    expect(await cases.history('m1')).toEqual([]);
    expect(calls[0].args).toEqual(['m1~history']);
    const broken = setup(() => {
      throw new ApiFailure('Unavailable', 'unavailable', 503);
    });
    await expect(broken.cases.history('m1')).rejects.toThrow('Unavailable');
  });

  it('asks for the status, runs one now and notifies the failures asked for', async () => {
    const { cases, calls, shown } = setup();
    expect((await cases.status('local', 2)).sequence).toBe(3);
    await cases.run('local', 'm1');
    expect(calls.map((c) => c.args)).toEqual([
      ['monitor.status', { workspace: 'local', after: 2 }],
      ['monitor.run', { workspace: 'local', id: 'm1' }],
    ]);
    expect(cases.notificationPermission()).toBe('default');
    expect(await cases.allowNotifications()).toBe('granted');
    const event = (state: MonitorEvent['state'], notify: boolean): MonitorEvent => ({
      sequence: 1,
      workspace: 'local',
      monitor: 'm1',
      name: 'Nightly',
      state,
      notify,
    });
    cases.notify(
      [event('failed', true), event('passed', true), event('error', false)],
      (failure) => ({ title: `${failure.name} failed`, body: failure.state }),
    );
    expect(shown).toEqual([['Nightly failed', 'failed']]);
  });
});
