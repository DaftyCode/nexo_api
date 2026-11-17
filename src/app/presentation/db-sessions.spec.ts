import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbPanelTest, driverHello, startDbPanel } from '../testing/db-panel';

const sessions = {
  privilege: 'pg_monitor',
  sessions: [
    {
      id: '7',
      user: 'nexo',
      application: 'Nexo',
      sql: 'SELECT * FROM pg_stat_activity',
      active: true,
      own: true,
    },
    {
      id: '42',
      user: 'ana',
      database: 'shop',
      application: 'psql',
      client: '10.0.0.2:5000',
      state: 'active',
      seconds: 75,
      wait: 'Lock: transactionid',
      sql: 'SELECT pg_sleep(60)',
      active: true,
    },
    { id: '43', user: 'eva', state: 'idle', seconds: 5, sql: 'COMMIT', active: false },
  ],
};

async function sessionsTab(
  options: { kill?: string[]; connection?: Record<string, unknown>; done?: boolean } = {},
) {
  const panel = await startDbPanel({
    hello: driverHello({
      methods: ['sessions', 'locks', 'kill'],
      kill: options.kill ?? ['cancel', 'terminate'],
    }),
    connection: options.connection,
    responses: {
      'db.sessions': () => sessions,
      'db.session.kill': () => ({ done: options.done ?? true }),
    },
  });
  await panel.menu('Shop', 'Sessions');
  await panel.settle(20);
  return panel;
}
const view = (panel: DbPanelTest) => panel.root().querySelector('app-db-sessions')!;
const cell = (panel: DbPanelTest, row: number) =>
  view(panel).querySelector<HTMLElement>(`[role="gridcell"][data-row="${row}"][data-column="1"]`)!;

describe('DbSessions', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists the sessions of the server, filtered, without the idle ones if asked', async () => {
    const panel = await sessionsTab();
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'sessions', title: 'Sessions' });
    expect(panel.text()).toContain('Shop · Sessions');
    expect(panel.calls('db.sessions')[0]).toMatchObject({ session: 'tree:c1' });
    expect(view(panel).textContent).toContain(
      'Only some sessions are listed: the user lacks pg_monitor.',
    );
    expect(view(panel).textContent).toContain('3 rows loaded');

    await panel.fill('Filter sessions', 'sleep');
    expect(view(panel).textContent).toContain('1 rows loaded');
    await panel.fill('Filter sessions', '');
    const idle = panel.control('Show idle sessions') as HTMLInputElement;
    idle.checked = false;
    idle.dispatchEvent(new Event('change'));
    await panel.settle();
    expect(view(panel).textContent).toContain('2 rows loaded');

    await panel.click('Refresh', view(panel));
    expect(panel.calls('db.sessions')).toHaveLength(2);
    expect(await panel.menuEntries('Shop')).toEqual(expect.arrayContaining(['Sessions', 'Locks']));
    await panel.menu('Shop', 'Sessions');
    expect(
      panel
        .section()
        .tabs.tabs()
        .filter((tab) => tab.kind === 'sessions'),
    ).toHaveLength(1);
  });

  it('shows the statement of the session chosen, and cancels it once confirmed', async () => {
    const panel = await sessionsTab();
    const cancel = () => panel.buttons('Cancel the query', view(panel))[0] as HTMLButtonElement;
    expect(cancel().disabled).toBe(true);
    cell(panel, 0).click();
    await panel.settle();
    expect(view(panel).querySelector('.db-admin-detail')?.textContent).toContain('This session');
    expect(cancel().disabled).toBe(true);
    expect(cancel().title).toContain("Nexo's own session");

    cell(panel, 1).click();
    await panel.settle();
    expect(view(panel).querySelector('.db-admin-detail pre')?.textContent).toBe(
      'SELECT pg_sleep(60)',
    );
    await panel.click('Cancel the query', view(panel));
    const dialog = panel.dialog('Cancel the query');
    expect(dialog.textContent).toContain('session 42 of ana');
    expect(dialog.querySelector('.db-kill-sql')?.textContent).toBe('SELECT pg_sleep(60)');
    await panel.click('No', dialog);
    expect(panel.root().querySelector('app-db-kill-dialog')).toBeNull();
    expect(panel.calls('db.session.kill')).toEqual([]);

    await panel.click('End the session', view(panel));
    await panel.click(/^End the session$/, panel.dialog('End the session'));
    await panel.settle(10);
    expect(panel.calls('db.session.kill')[0]).toMatchObject({
      session: 'tree:c1',
      target: '42',
      mode: 'terminate',
      confirm: true,
    });
    expect(panel.state.toast()?.title).toBe('Session ended');
  });

  it('asks for the id on production, and says when the session was gone', async () => {
    const panel = await sessionsTab({
      connection: { driver: 'postgres', host: 'db', database: 'shop', type: 'production' },
      done: false,
    });
    cell(panel, 1).click();
    await panel.settle();
    await panel.click('Cancel the query', view(panel));
    const dialog = panel.dialog('Cancel the query');
    const confirm = () => panel.buttons(/^Cancel the query$/, dialog)[0] as HTMLButtonElement;
    expect(confirm().disabled).toBe(true);
    await panel.fill('This connection is for production: type 42 to confirm', '42', dialog);
    expect(confirm().disabled).toBe(false);
    confirm().click();
    await panel.settle(10);
    expect(panel.calls('db.session.kill')[0]).toMatchObject({ confirmName: '42', mode: 'cancel' });
    expect(panel.state.toast()?.title).toBe('The session was no longer there');
  });

  it('cancels nothing on a read-only connection, nor where the driver cannot', async () => {
    const panel = await sessionsTab({
      connection: { driver: 'postgres', host: 'db', database: 'shop', readOnly: true },
    });
    expect(view(panel).textContent).toContain('cannot cancel nor end the sessions');
    expect(panel.buttons('Cancel the query', view(panel))).toHaveLength(0);
  });

  it('offers only what the driver can do to a session', async () => {
    const panel = await sessionsTab({ kill: ['terminate'] });
    expect(panel.buttons('Cancel the query', view(panel))).toHaveLength(0);
    expect(panel.buttons('End the session', view(panel))).toHaveLength(1);
  });

  it('reads itself again every few seconds when asked, until told not to', async () => {
    const panel = await sessionsTab();
    vi.useFakeTimers();
    try {
      const every = view(panel).querySelector('select') as HTMLSelectElement;
      every.value = '2';
      every.dispatchEvent(new Event('change'));
      await vi.advanceTimersByTimeAsync(4_100);
      expect(panel.calls('db.sessions').length).toBeGreaterThanOrEqual(3);
      every.value = '0';
      every.dispatchEvent(new Event('change'));
      const asked = panel.calls('db.sessions').length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(panel.calls('db.sessions')).toHaveLength(asked);
    } finally {
      vi.useRealTimers();
    }
  });
});
