import { signal } from '@angular/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceDocument } from '../../domain/models';
import { databaseCases } from '../../testing/database-cases';
import { DashboardRun } from './dashboard-run';
import { SectionDashboards } from './dashboards';
import type { DbSection } from './section';
import { DbTabsStore } from './tabs-store';

const panels = [
  { id: 'sessions', title: 'Sessions', sql: 'SELECT active', chart: 'line', interval: 2 },
  {
    id: 'tps',
    title: 'Transactions',
    sql: 'SELECT commits',
    chart: 'area',
    delta: true,
    interval: 2,
  },
];

function fakeSection(
  options: { methods?: string[]; installed?: boolean; slow?: boolean; fail?: string } = {},
) {
  let commits = 100;
  let release: () => void = () => undefined;
  const fake = databaseCases({
    'db.connect': () => ({ serverVersion: '1' }),
    'db.transaction': () => ({ autoCommit: true, open: false }),
    'db.disconnect': () => ({}),
    'db.dashboards': () => ({ dashboards: panels }),
    'db.dashboard.read': (payload: Record<string, unknown>) => {
      if (payload['sql'] === options.fail) throw new Error('only reads');
      if (payload['sql'] === 'SELECT commits')
        return { columns: [{ name: 'commits' }], rows: [[(commits += 10)]] };
      if (options.slow)
        return new Promise((done) => (release = () => done({ columns: [], rows: [] })));
      return { columns: [{ name: 'active' }], rows: [[3]] };
    },
  });
  let ids = 0;
  const tabs = new DbTabsStore(() => `t${++ids}`);
  const documents = [{ id: 'c1', name: 'Shop', kind: 'connection', value: { driver: 'postgres' } }];
  const section = {
    tabs,
    cases: async () => fake.cases,
    connection: (id: string) =>
      documents.find((document) => document.id === id) as WorkspaceDocument,
    driverOf: () => 'postgres',
    ensure: async () => options.installed !== false,
    drivers: {
      learn: async () => undefined,
      capabilities: () => ({ methods: options.methods ?? ['dashboards'] }),
    },
    state: {
      workspaceId: () => 'w',
      scopes: () => ({}),
      describe: (error: unknown) => (error as Error).message,
      databaseSession: signal({
        dashboards: { c1: { order: ['tps'], hidden: [], wide: [], interval: 0, custom: [] } },
      }),
    },
  } as unknown as DbSection;
  return { section, fake, tabs, release: () => release() };
}

describe('the dashboard of a connection', () => {
  afterEach(() => vi.useRealTimers());

  it('opens its own session, reads each panel at its interval and never twice at once', async () => {
    vi.useFakeTimers();
    let now = 10_000;
    const { section, fake } = fakeSection();
    const visible = signal(true);
    const layout = signal({ order: [], hidden: [], wide: [], interval: 0, custom: [] as never[] });
    const run = new DashboardRun(section, 'c1', layout, visible, () => now);
    await run.start();
    expect(run.status()).toBe('open');
    expect(fake.named('db.connect')[0]).toMatchObject({ session: 'dashboard:c1' });
    expect(run.panels().map((panel) => panel.id)).toEqual(['sessions', 'tps']);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.data()['sessions'].series[0].points).toEqual([{ at: 10_000, value: 3 }]);
    expect(run.data()['tps'].series[0].points).toEqual([]);

    now = 11_000;
    run.tick();
    expect(fake.named('db.dashboard.read')).toHaveLength(2);
    now = 12_000;
    await vi.advanceTimersByTimeAsync(600);
    expect(run.data()['tps'].series[0].points).toEqual([{ at: 12_000, value: 5 }]);

    run.paused.set(true);
    now = 20_000;
    run.tick();
    visible.set(false);
    run.paused.set(false);
    run.tick();
    expect(fake.named('db.dashboard.read')).toHaveLength(4);
    visible.set(true);
    layout.set({ ...layout(), interval: 1, hidden: ['tps'] as never[] });
    run.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.named('db.dashboard.read')).toHaveLength(5);

    run.forget('sessions');
    expect(run.data()['sessions']).toBeUndefined();
    await run.stop();
    expect(run.status()).toBe('closed');
    expect(fake.named('db.disconnect')[0]).toMatchObject({ session: 'dashboard:c1' });
    now = 99_000;
    run.tick();
    expect(fake.named('db.dashboard.read')).toHaveLength(5);
  });

  it('skips a panel whose reading has not ended, and keeps each panel’s error', async () => {
    const { section, release } = fakeSection({ slow: true, fail: 'SELECT commits' });
    let now = 0;
    const layout = () => ({ order: [], hidden: [], wide: [], interval: 1, custom: [] });
    const run = new DashboardRun(
      section,
      'c1',
      layout,
      () => true,
      () => now,
    );
    await run.start();
    await Promise.resolve();
    now = 5_000;
    run.tick();
    const cases = await section.cases();
    expect(run.errors()['tps']).toBe('only reads');
    release();
    await Promise.resolve();
    await Promise.resolve();
    expect(cases).toBeDefined();
    await run.stop();
  });

  it('says why it cannot open, and closes a session that opened after it stopped', async () => {
    const missing = new DashboardRun(
      fakeSection({ installed: false }).section,
      'c1',
      () => ({ order: [], hidden: [], wide: [], interval: 0, custom: [] }),
      () => true,
    );
    await missing.start();
    expect([missing.status(), missing.error()]).toEqual(['error', 'db.dashboard.module']);
    const gone = new DashboardRun(
      fakeSection().section,
      'c9',
      () => ({ order: [], hidden: [], wide: [], interval: 0, custom: [] }),
      () => true,
    );
    await gone.start();
    expect(gone.error()).toBe('The connection is no longer there');

    const { section, fake } = fakeSection({ methods: [] });
    const quick = new DashboardRun(
      section,
      'c1',
      () => ({ order: [], hidden: [], wide: [], interval: 0, custom: [] }),
      () => true,
    );
    const starting = quick.start();
    await quick.stop();
    await starting;
    expect(quick.status()).toBe('closed');
    expect(fake.named('db.disconnect')).toHaveLength(1);
    expect(fake.named('db.dashboards')).toEqual([]);
    await quick.start();
    expect(quick.predefined()).toEqual([]);
    await quick.start();
    await quick.stop();
  });

  it('keeps where each panel is, and one dashboard per open tab', async () => {
    const { section, tabs, fake } = fakeSection();
    const dashboards = new SectionDashboards(section);
    expect(dashboards.layout('c1').order).toEqual(['tps']);
    dashboards.open({
      key: 'k',
      type: 'folder',
      level: 1,
      label: 'x',
      expandable: false,
      expanded: false,
    });
    expect(tabs.tabs()).toEqual([]);
    dashboards.open({
      key: 'c',
      type: 'connection',
      level: 1,
      label: 'Shop',
      connection: 'c1',
      expandable: true,
      expanded: false,
    });
    const tab = tabs.active()!;
    expect(tab).toMatchObject({ kind: 'dashboard', connection: 'c1' });
    const run = dashboards.run(tab);
    expect(dashboards.run(tab)).toBe(run);
    void run.start();
    await vi.waitFor(() => expect(run.status()).toBe('open'));
    expect(run.panels().map((panel) => panel.id)).toEqual(['tps', 'sessions']);

    dashboards.move(run, 'sessions', -1);
    expect(dashboards.layout('c1').order).toEqual(['sessions', 'tps']);
    dashboards.move(run, 'sessions', -1);
    dashboards.place(run, 'sessions', 'tps', 'after');
    expect(dashboards.layout('c1').order).toEqual(['tps', 'sessions']);
    dashboards.place(run, 'sessions', 'gone', 'before');
    dashboards.toggleWide('c1', 'tps');
    dashboards.toggleShown('c1', 'sessions');
    expect(dashboards.layout('c1')).toMatchObject({ wide: ['tps'], hidden: ['sessions'] });
    dashboards.toggleShown('c1', 'sessions');
    dashboards.setInterval(run, 10);
    expect(dashboards.layout('c1').interval).toBe(10);

    const mine = {
      id: 'custom-1',
      title: 'Mine',
      sql: 'SELECT 1',
      chart: 'value' as const,
      delta: false,
      interval: 5,
    };
    dashboards.keepCustom(run, mine);
    dashboards.keepCustom(run, { ...mine, title: 'Mine again' });
    expect(dashboards.layout('c1').custom).toEqual([
      { ...mine, title: 'Mine again', custom: true },
    ]);
    dashboards.toggleWide('c1', 'custom-1');
    dashboards.removeCustom(run, 'custom-1');
    expect(dashboards.layout('c1')).toMatchObject({ custom: [], wide: ['tps'] });

    dashboards.close('other');
    dashboards.closeAll();
    await vi.waitFor(() => expect(fake.named('db.disconnect')).toHaveLength(1));
    expect(dashboards.run(tab)).not.toBe(run);
    dashboards.closeAll();
  });
});
