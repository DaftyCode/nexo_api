// End-to-end test of the MySQL module against the fixture's MySQL and MariaDB
// (tools/sql-fixture.sh): connections from a MySQL and a MariaDB JDBC URL, the tree of
// databases, a table opened with a double click on its data filtered on the server with a
// `?` parameter, its DDL, a procedure's two results in two tabs, and a cancelled statement
// after which the session answers.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, folder, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

/** The fixture's MySQL (`MYSQL`) or MariaDB (`MARIADB`), as the wizard offers MySQL. */
const server = (flavour, scheme) => ({
  label: 'MySQL',
  url: () =>
    `jdbc:${scheme}://${environment[`NEXO_SQL_${flavour}_USER`]}:${environment[`NEXO_SQL_${flavour}_PASSWORD`]}@${environment[`NEXO_SQL_${flavour}_HOST`]}:${environment[`NEXO_SQL_${flavour}_PORT`]}/${environment[`NEXO_SQL_${flavour}_DATABASE`]}`,
});

test('MySQL and MariaDB connect from their URLs, show their objects and run statements', async ({
  page,
  nexo,
}) => {
  test.setTimeout(150_000);
  test.skip(
    !nexo.moduleIds.includes('mysql'),
    'Build the MySQL driver: cargo build -p nexo-driver-mysql',
  );
  test.skip(!environment.NEXO_SQL_MYSQL_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Tienda', server('MYSQL', 'mysql'));
  await addConnection(page, 'Maria', server('MARIADB', 'mariadb'));
  const tree = page.getByRole('tree', { name: 'Connections' });
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('ArrowRight');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  await open(tree.getByRole('treeitem', { name: /^Maria/ }));
  await open(folder(tree, 'Databases'));
  await expect(tree.getByRole('treeitem', { name: 'shop', exact: true })).toBeVisible();
  await tree.getByRole('treeitem', { name: /^Maria/ }).focus();
  await page.keyboard.press('ArrowLeft');
  await open(tree.getByRole('treeitem', { name: /^Tienda/ }));
  await open(folder(tree, 'Databases'));
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }));
  await open(folder(tree, 'Tables'));

  // A double click opens the table on its data, filtered on the server with a parameter.
  await tree.getByRole('treeitem', { name: /^orders/ }).dblclick();
  await expect(page.getByRole('heading', { name: 'shop.orders' })).toBeVisible();
  const grid = page.getByRole('grid', { name: 'Rows' });
  await expect(grid).toContainText('120.50');
  expect(await violations(page)).toEqual([]);
  await grid.getByRole('gridcell', { name: 'paid' }).click();
  await page.getByRole('button', { name: 'Filter by this value' }).click();
  await page.getByRole('menuitem', { name: 'Filter: equal to this value' }).click();
  await page.getByRole('button', { name: 'Statement', exact: true }).click();
  await expect(page.locator('.db-data-statement')).toContainText('`status` = ?');
  await expect(grid.getByRole('gridcell', { name: '9.99' })).toBeHidden();
  const views = page.getByRole('navigation', { name: 'Object views' });
  await views.getByRole('button', { name: 'DDL' }).click();
  await expect(page.locator('app-db-object-tab .cm-content')).toContainText(
    'CREATE TABLE `orders`',
  );

  // A procedure's two results, each in its tab; a cancelled statement, then the next one.
  await newScript(page);
  await write(page, 'CALL two_results()');
  await page.keyboard.press('ControlOrMeta+Enter');
  const results = page.getByRole('tablist', { name: 'Results' });
  await expect(results.getByRole('tab', { name: /^1 · CALL two_results/ })).toBeVisible();
  await results.getByRole('tab', { name: /^2 · CALL two_results/ }).click();
  await expect(page.locator('app-data-grid')).toContainText('two');
  await write(page, 'SELECT SLEEP(30)');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await write(page, 'SELECT 41 + 1 AS answer');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(results.getByRole('tab', { name: /SELECT 41 \+ 1/ })).toBeVisible();
  await expect(page.locator('app-data-grid')).toContainText('42');
});
