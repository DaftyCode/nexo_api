// End-to-end test of the administration of a server against the PostgreSQL fixture
// (tools/sql-fixture.sh), DB-21: a slow query of a SQL tab is found in the session manager,
// with Nexo's own session marked, and cancelled from there after a question; then the lock
// manager says that nobody waits. Both views and the question are checked with axe.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'admin' });

test('a slow query is cancelled from the sessions, and the locks say nobody waits', async ({
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

  // A query that would take half a minute, left running in its tab.
  await newScript(page);
  await write(page, 'SELECT pg_sleep(30) AS slept');
  await page.keyboard.press('ControlOrMeta+Enter');

  // The session manager, from the connection's menu.
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Tienda/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Sessions', exact: true }).click();
  const sessions = page.locator('app-db-sessions');
  await expect(sessions.getByRole('gridcell', { name: 'This session' })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await sessions.getByLabel('Filter sessions').fill('pg_sleep(30)');
  await expect(sessions).toContainText('1 rows loaded');
  await sessions.locator('[role="gridcell"][data-row="0"][data-column="1"]').click();
  await expect(sessions.locator('.db-admin-detail pre')).toContainText(
    'SELECT pg_sleep(30) AS slept',
  );
  await sessions.getByRole('button', { name: 'Cancel the query' }).click();
  const question = page.getByRole('dialog', { name: 'Cancel the query' });
  await expect(question).toContainText('pg_sleep(30)');
  expect(await violations(page)).toEqual([]);
  await question.getByRole('button', { name: 'Cancel the query' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Query cancelled' })).toBeVisible();
  // The session stays open, idle: its query stopped.
  await sessions.getByLabel('Show idle sessions').uncheck();
  await expect(sessions).toContainText('0 rows loaded');

  // The lock manager: nobody waits.
  await tree.getByRole('treeitem', { name: /^Tienda/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Locks', exact: true }).click();
  await expect(page.locator('app-db-locks')).toContainText('No session waits for a lock.');
  expect(await violations(page)).toEqual([]);
});
