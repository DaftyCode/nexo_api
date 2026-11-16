// End-to-end test of an object's tab against the PostgreSQL fixture (tools/sql-fixture.sh):
// opened with a double click, on its data; its header and sections, its DDL, its data filtered and ordered on the server with a
// quick filter from a cell, the count, a foreign key followed to the table it points to and
// the rows that point back, in the References panel.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, folder } from './databases-helpers.mjs';

const environment = process.env;

test("an object's tab shows its data from the server and follows its keys", async ({
  page,
  nexo,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('postgres'),
    'Build the PostgreSQL driver: cargo build -p nexo-driver-postgres',
  );
  test.skip(!environment.NEXO_SQL_PG_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Objects');
  const tree = page.getByRole('tree', { name: 'Connections' });
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  await open(tree.getByRole('treeitem', { name: /^Objects/ }));
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }).first());
  await open(folder(tree, 'Schemas'));
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }).nth(1));
  await open(folder(tree, 'Tables'));
  // A double click opens a table's tab on its data; with the tab open, it opens the table in the
  // tree.
  const orders = tree.getByRole('treeitem', { name: /^orders/ });
  await orders.dblclick();
  await expect(page.getByRole('heading', { name: 'shop.orders' })).toBeVisible();
  const views = page.getByRole('navigation', { name: 'Object views' });
  await expect(views.getByRole('button', { name: 'Data', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('grid', { name: 'Rows' })).toContainText('120.50');
  await expect(orders).toHaveAttribute('aria-expanded', 'false');
  await orders.dblclick();
  await expect(orders).toHaveAttribute('aria-expanded', 'true');

  // The header and the sections, as grids; the DDL.
  await expect(page.locator('.db-object-facts')).toContainText('Owner');
  await views.getByRole('button', { name: 'Columns' }).click();
  await expect(page.getByRole('grid', { name: 'Columns' })).toContainText('customer');
  await views.getByRole('button', { name: 'DDL' }).click();
  await expect(page.locator('app-db-object-tab .cm-content')).toContainText(
    'CREATE TABLE shop.orders',
  );

  // The data, filtered and ordered on the server.
  await views.getByRole('button', { name: 'Data', exact: true }).click();
  const grid = page.getByRole('grid', { name: 'Rows' });
  await expect(grid).toContainText('120.50');
  expect(await violations(page)).toEqual([]);
  const where = page.locator('.cm-content[aria-label="Condition (WHERE)"]');
  await where.click();
  await page.keyboard.insertText('total > 1');
  await page.getByRole('button', { name: 'Run (F5)' }).click();
  await page.getByRole('button', { name: 'Statement', exact: true }).click();
  const statement = page.locator('.db-data-statement');
  await expect(statement).toHaveText('SELECT * FROM shop.orders WHERE (total > 1)');
  await grid.getByRole('button', { name: 'total' }).click();
  await expect(statement).toHaveText(
    'SELECT * FROM shop.orders WHERE (total > 1) ORDER BY total ASC',
  );
  await expect(grid.locator('[aria-rowindex="2"]')).toContainText('9.99');

  // A quick filter from a cell goes as a parameter.
  await grid.getByRole('gridcell', { name: 'paid' }).click();
  await page.getByRole('button', { name: 'Filter by this value' }).click();
  await page.getByRole('menuitem', { name: 'Filter: equal to this value' }).click();
  await expect(statement).toHaveText(
    'SELECT * FROM shop.orders WHERE (total > 1) AND status = $1 ORDER BY total ASC',
  );
  await expect(grid.getByRole('gridcell', { name: '9.99' })).toBeHidden();
  await page.getByRole('button', { name: 'Refresh options' }).click();
  await page.getByRole('button', { name: 'Count the rows' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rows: 1 (of 1)' })).toBeVisible();

  // A foreign key leads to the table it points to, and the rows that point back show.
  await views.getByRole('button', { name: 'Foreign keys' }).click();
  await page.getByRole('grid', { name: 'Foreign keys' }).getByRole('gridcell').first().click();
  await page.getByRole('button', { name: 'Open the related table' }).click();
  await expect(page.getByRole('heading', { name: 'shop.customers' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Object views' })
    .getByRole('button', { name: 'Data', exact: true })
    .click();
  await page
    .getByRole('grid', { name: 'Rows' })
    .getByRole('gridcell', { name: 'ana@example.com' })
    .click();
  await page.getByRole('button', { name: 'References', exact: true }).click();
  const related = page.getByRole('complementary', { name: 'References' });
  await expect(related).toContainText('Pointed to from orders');
  await expect(related.getByRole('grid')).toContainText('120.50');
  expect(await violations(page)).toEqual([]);
});
