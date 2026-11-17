// End-to-end test of a server's dashboard against the PostgreSQL fixture (tools/sql-fixture.sh),
// DB-22: its panels draw what the driver offers, a slow query of another tab shows as one
// more active session a few seconds later, the charts read as tables, and closing the tab
// closes its session on the server, as the session manager shows. Checked with axe.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'dashboard' });

test('the dashboard reflects a load, reads as tables and stops when closed', async ({
  page,
  nexo,
}) => {
  test.setTimeout(150_000);
  test.skip(
    !nexo.moduleIds.includes('postgres'),
    'Build the PostgreSQL driver: cargo build -p nexo-driver-postgres',
  );
  test.skip(!environment.NEXO_SQL_PG_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Tienda');
  const tree = page.getByRole('tree', { name: 'Connections' });
  const menu = async (entry) => {
    await tree.getByRole('treeitem', { name: /^Tienda/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: entry, exact: true }).click();
  };

  // The dashboard, read every second.
  await menu('Dashboard');
  const dashboard = page.locator('app-db-dashboard');
  const sessions = dashboard.getByRole('region', { name: 'Sessions', exact: true });
  await expect(sessions.locator('.chart-legend')).toContainText('active');
  await dashboard.getByLabel('Read every').selectOption('1');
  expect(await violations(page)).toEqual([]);

  // A slow query in a SQL tab: one more active session.
  await newScript(page);
  await write(page, 'SELECT pg_sleep(12)');
  await page.keyboard.press('ControlOrMeta+Enter');
  await page.getByRole('tab', { name: /Tienda · Dashboard/ }).click();
  await sessions.getByRole('button', { name: 'As a table' }).click();
  const active = sessions.locator('tbody tr').first().locator('td').first();
  await expect(active).toHaveText(/^([2-9]|\d{2,}) sessions$/, { timeout: 15_000 });
  expect(await violations(page)).toEqual([]);

  // Closed, its session leaves the server.
  await menu('Sessions');
  const manager = page.locator('app-db-sessions');
  await manager.getByLabel('Filter sessions').fill('Nexo');
  const count = async () => Number(/(\d+) rows loaded/.exec(await manager.textContent())?.[1]);
  await expect.poll(count).toBeGreaterThan(1);
  const before = await count();
  await page.getByRole('tab', { name: /Tienda · Dashboard/ }).press('Delete');
  await expect(page.getByRole('tab', { name: /Tienda · Dashboard/ })).toHaveCount(0);
  await page.getByRole('tab', { name: /Tienda · Sessions/ }).click();
  await expect
    .poll(async () => {
      await manager.getByRole('button', { name: 'Refresh' }).click();
      return count();
    })
    .toBe(before - 1);
});
