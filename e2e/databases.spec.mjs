// End-to-end test of the database section against the PostgreSQL fixture
// (tools/sql-fixture.sh): from an installation without modules, choosing PostgreSQL downloads
// its module, the form is filled from a URL, the connection is tested, saved, browsed down to
// the columns of a table with the keyboard, filtered, bookmarked and deleted.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

const environment = process.env;

test('a PostgreSQL connection downloads its module and is browsed with the keyboard', async ({
  page,
  nexo,
}) => {
  test.skip(
    !nexo.moduleIds.includes('postgres'),
    'Build the PostgreSQL driver: cargo build -p nexo-driver-postgres',
  );
  test.skip(!environment.NEXO_SQL_PG_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Databases' })
    .click();
  await expect(page.getByRole('heading', { name: 'Databases', exact: true })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // The engine first: its module is downloaded after asking.
  await page.getByRole('toolbar', { name: 'Navigator' }).getByRole('button').first().click();
  await page.getByRole('button', { name: /^PostgreSQL/ }).click();
  const download = page.getByRole('dialog', { name: 'Download the PostgreSQL module' });
  await expect(download.getByRole('button', { name: 'Download' })).toBeFocused();
  await download.getByRole('button', { name: 'Download' }).click();
  await expect(download).toBeHidden();

  // A pasted URL fills the form; its password goes to the vault.
  const { NEXO_SQL_PG_USER: user, NEXO_SQL_PG_PASSWORD: password } = environment;
  await page
    .getByLabel('Paste a connection URL')
    .fill(
      `postgresql://${user}:${password}@${environment.NEXO_SQL_PG_HOST}:${environment.NEXO_SQL_PG_PORT}/${environment.NEXO_SQL_PG_DATABASE}?application_name=nexo-e2e`,
    );
  await page.getByRole('button', { name: 'Use URL' }).click();
  await expect(page.getByText('The password left the URL')).toBeVisible();
  await page.getByLabel('Connection name').fill('Shop');
  await page.getByRole('button', { name: 'Test connection' }).click();
  const report = page.getByRole('status', { name: 'Connection test' });
  await expect(report).toContainText('PostgreSQL');
  expect(await violations(page)).toEqual([]);

  // A production connection is red in the tree and in its tab.
  await page.getByRole('button', { name: 'General' }).click();
  await page.getByLabel('Connection type').selectOption('production');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Connection saved' })).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Connections' });
  const shop = tree.getByRole('treeitem', { name: /^Shop/ });
  await expect(shop).toHaveClass(/db-type-production/);
  await expect(page.getByRole('tab', { name: 'Shop' })).toHaveClass(/db-tab-production/);

  // The keyboard opens the connection and walks down to the columns of a table.
  await shop.click();
  await page.keyboard.press('ArrowRight');
  const database = tree.getByRole('treeitem', { name: 'shop', exact: true }).first();
  await expect(database).toBeVisible();
  await expect(shop).toHaveAttribute('aria-expanded', 'true');
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  await open(database);
  await open(tree.getByRole('treeitem', { name: 'Schemas', exact: true }));
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }).nth(1));
  await open(tree.getByRole('treeitem', { name: 'Tables', exact: true }));
  const orders = tree.getByRole('treeitem', { name: /^orders/ });
  await open(orders);
  await open(tree.getByRole('treeitem', { name: 'Columns', exact: true }));
  await expect(tree.getByRole('treeitem', { name: /^total/ })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // The text filter keeps what matches among the loaded objects.
  await page.getByLabel('Filter loaded objects').fill('customers');
  await expect(tree.getByRole('treeitem', { name: /^customers/ })).toBeVisible();
  await expect(orders).toBeHidden();
  await page.getByLabel('Filter loaded objects').fill('');

  // Shift+F10 opens a node's actions; a bookmark is listed above the tree.
  await orders.focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  expect(await violations(page)).toEqual([]);
  await menu.getByRole('menuitem', { name: 'Bookmark' }).click();
  await expect(page.getByRole('region', { name: 'Bookmarks' })).toContainText('orders');

  // Deleting asks for the name.
  await shop.focus();
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog', { name: 'Delete connection' });
  await expect(dialog.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await dialog.getByLabel('Type Shop to confirm').fill('Shop');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Connection deleted' })).toBeVisible();
  await expect(tree).toBeHidden();
  expect(await violations(page)).toEqual([]);
});
