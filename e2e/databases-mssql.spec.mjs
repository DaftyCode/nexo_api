// End-to-end test of the SQL Server module against the fixture's server
// (tools/sql-fixture.sh, x86-64 only): the connection from a JDBC URL, the tree of
// databases and schemas, a table's sheet with its DDL and data filtered on the server with
// a parameter, a procedure's two results in two tabs, and a cancelled statement after which
// the session answers.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { SQL_SERVER, addConnection, folder, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

test('SQL Server connects from its JDBC URL, shows its objects and runs batches', async ({
  page,
  nexo,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('mssql'),
    'Build the SQL Server driver: cargo build -p nexo-driver-mssql',
  );
  test.skip(!environment.NEXO_SQL_MSSQL_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Ventas', SQL_SERVER);
  const tree = page.getByRole('tree', { name: 'Connections' });
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  await open(tree.getByRole('treeitem', { name: /^Ventas/ }));
  await open(folder(tree, 'Databases'));
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }).first());
  await open(folder(tree, 'Schemas'));
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }).nth(1));
  await open(folder(tree, 'Tables'));
  await tree.getByRole('treeitem', { name: /^orders/ }).focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu').getByRole('menuitem', { name: 'Open' }).click();

  // The sheet, its DDL and its data, filtered on the server with a parameter.
  await expect(page.getByRole('heading', { name: 'shop.orders' })).toBeVisible();
  const views = page.getByRole('navigation', { name: 'Object views' });
  await views.getByRole('button', { name: 'DDL' }).click();
  await expect(page.locator('app-db-object-tab .cm-content')).toContainText(
    'CREATE TABLE [shop].[orders]',
  );
  await views.getByRole('button', { name: 'Data', exact: true }).click();
  const grid = page.getByRole('grid', { name: 'Rows' });
  await expect(grid).toContainText('120.50');
  expect(await violations(page)).toEqual([]);
  await grid.getByRole('gridcell', { name: 'paid' }).click();
  await page.getByRole('button', { name: 'Filter by this value' }).click();
  await page.getByRole('menuitem', { name: 'Filter: equal to this value' }).click();
  await page.getByRole('button', { name: 'Statement', exact: true }).click();
  await expect(page.locator('.db-data-statement')).toContainText('status = @P1');
  await expect(grid.getByRole('gridcell', { name: '9.99' })).toBeHidden();

  // A procedure's two results, each in its tab; a cancelled statement, then the next one.
  await newScript(page);
  await write(page, 'EXEC shop.two_results');
  await page.keyboard.press('ControlOrMeta+Enter');
  const results = page.getByRole('tablist', { name: 'Results' });
  await expect(results.getByRole('tab', { name: /^1 · EXEC shop.two_results/ })).toBeVisible();
  await results.getByRole('tab', { name: /^2 · EXEC shop.two_results/ }).click();
  await expect(page.locator('app-data-grid')).toContainText('total');
  await write(page, "WAITFOR DELAY '00:00:30'");
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await write(page, 'SELECT 41 + 1 AS answer');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(results.getByRole('tab', { name: /SELECT 41 \+ 1/ })).toBeVisible();
  await expect(page.locator('app-data-grid')).toContainText('42');
});
