import { describe, expect, it } from 'vitest';
import { DbPanelTest, driverHello, startDbPanel } from '../testing/db-panel';

const waits = [
  {
    waiting: '43',
    blocking: '42',
    object: 'public.orders',
    mode: 'ShareLock',
    seconds: 3,
    waitingUser: 'eva',
    waitingSql: 'UPDATE orders SET n = 2',
    blockingUser: 'ana',
    blockingSql: 'UPDATE orders SET n = 1',
  },
];

async function locksTab(
  options: { waits?: unknown[]; connection?: Record<string, unknown>; privilege?: string } = {},
) {
  let answer = { waits: options.waits ?? waits, privilege: options.privilege };
  const panel = await startDbPanel({
    hello: driverHello({ methods: ['sessions', 'locks', 'kill'], kill: ['cancel', 'terminate'] }),
    connection: options.connection,
    responses: {
      'db.locks': () => answer,
      'db.session.kill': () => {
        answer = { waits: [], privilege: undefined };
        return { done: true };
      },
    },
  });
  await panel.menu('Shop', 'Locks');
  await panel.settle(20);
  return panel;
}
const view = (panel: DbPanelTest) => panel.root().querySelector('app-db-locks')!;
const rows = (panel: DbPanelTest) =>
  [...view(panel).querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent?.replace(/\s+/g, ' ').trim()),
  );

describe('DbLocks', () => {
  it('shows who waits for whom, the blocker on top, and ends it once confirmed', async () => {
    const panel = await locksTab();
    expect(panel.section().tabs.active()).toMatchObject({ kind: 'locks' });
    expect(panel.text()).toContain('Shop · Locks');
    expect(rows(panel)).toEqual([
      ['42', '—', 'ana', '', '', 'UPDATE orders SET n = 1', 'End session 42'],
      ['└ 43', '42', 'eva', 'ShareLock · public.orders', '3 s', 'UPDATE orders SET n = 2', ''],
    ]);
    await panel.click('End session 42', view(panel));
    const dialog = panel.dialog('End the session');
    expect(dialog.textContent).toContain('Session 42 of ana');
    await panel.click(/^End the session$/, dialog);
    await panel.settle(10);
    expect(panel.calls('db.session.kill')[0]).toMatchObject({ target: '42', mode: 'terminate' });
    expect(panel.state.toast()?.title).toBe('Session ended');
    expect(view(panel).textContent).toContain('No session waits for a lock.');

    const every = view(panel).querySelector('select') as HTMLSelectElement;
    every.value = '5';
    every.dispatchEvent(new Event('change'));
    every.value = '0';
    every.dispatchEvent(new Event('change'));
    await panel.click('Refresh', view(panel));
    expect(panel.calls('db.locks').length).toBeGreaterThanOrEqual(3);
  });

  it('says which privilege is missing, and ends nothing on a read-only connection', async () => {
    const panel = await locksTab({
      privilege: 'VIEW SERVER STATE',
      connection: { driver: 'postgres', host: 'db', database: 'shop', readOnly: true },
    });
    expect(view(panel).textContent).toContain(
      'The locks of other sessions are not listed: the user lacks VIEW SERVER STATE.',
    );
    expect(panel.buttons(/End session/, view(panel))).toHaveLength(0);
  });

  it('asks for the id of the session on production', async () => {
    const panel = await locksTab({
      connection: { driver: 'postgres', host: 'db', database: 'shop', type: 'production' },
    });
    await panel.click('End session 42', view(panel));
    const dialog = panel.dialog('End the session');
    await panel.click('Close dialog', dialog);
    expect(panel.root().querySelector('app-db-kill-dialog')).toBeNull();
    await panel.click('End session 42', view(panel));
    await panel.fill(
      'This connection is for production: type 42 to confirm',
      '42',
      panel.dialog('End the session'),
    );
    await panel.click(/^End the session$/, panel.dialog('End the session'));
    await panel.settle(10);
    expect(panel.calls('db.session.kill')[0]).toMatchObject({ confirmName: '42' });
  });
});
