// End-to-end test of the data grid against the PostgreSQL fixture (tools/sql-fixture.sh): a
// result of 100 000 rows read page after page and whole while only a few hundred cells are
// drawn, the keyboard, find, the panels and the record view, and «Copy as INSERT» that,
// run, inserts the same rows.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, gridTool, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

test('the data grid reads a large result, finds, copies and shows its panels', async ({
  page,
  nexo,
}) => {
  // Reading 100 000 rows and running the copies take longer than one ordinary test.
  test.setTimeout(180_000);
  test.skip(
    !nexo.moduleIds.includes('postgres'),
    'Build the PostgreSQL driver: cargo build -p nexo-driver-postgres',
  );
  test.skip(!environment.NEXO_SQL_PG_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await nexo.signIn(page);
  await addConnection(page, 'Grid');
  await newScript(page);
  await write(page, 'SELECT n, label FROM public.numbers ORDER BY n');
  await page.keyboard.press('ControlOrMeta+Enter');

  const grid = page.getByRole('grid', { name: 'Rows' });
  const footer = page.locator('.grid-footer');
  await expect(grid).toBeVisible();
  await expect(footer).toContainText('200 rows loaded');
  expect(await page.locator('[role="gridcell"]').count()).toBeLessThan(1000);
  expect(await violations(page)).toEqual([]);

  // The keyboard reaches the end of what was read, and the next page comes.
  await grid.focus();
  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await expect(footer).toContainText('400 rows loaded');

  // The panels and the record view, from the tools at the end of the header.
  await gridTool(page, 'Value');
  await expect(page.getByRole('complementary', { name: 'Value' })).toContainText('200');
  await gridTool(page, 'Calc');
  await expect(page.getByRole('complementary', { name: 'Calc' })).toContainText('Count');
  expect(await violations(page)).toEqual([]);
  await gridTool(page, 'Record');
  await expect(page.getByRole('region', { name: 'Record' })).toContainText('label');
  await page.getByRole('button', { name: 'Back to the grid' }).click();

  // Everything, after saying it may be much; still a few hundred cells drawn.
  page.once('dialog', (question) => question.accept());
  await page.getByRole('button', { name: 'Read all' }).click();
  await expect(footer).toContainText('100,000 rows loaded', { timeout: 60_000 });
  await grid.focus();
  await page.keyboard.press('ControlOrMeta+End');
  await expect(grid.getByRole('gridcell', { name: 'row 100000', exact: true })).toBeVisible();
  expect(await page.locator('[role="gridcell"]').count()).toBeLessThan(1000);

  // Find in the results.
  await gridTool(page, 'Find');
  await page.getByLabel('Find in results').fill('row 99999');
  await expect(page.getByText('1 found')).toBeVisible();
  await page.getByLabel('Find in results').press('Enter');
  await expect(page.locator('.grid-active')).toHaveText('row 99999');

  // «Copy as INSERT» of a table, run into a copy of it, inserts the same rows.
  const copy = `public.customers_copy_${Date.now()}`;
  await write(
    page,
    `CREATE TABLE ${copy} (LIKE shop.customers);
SELECT * FROM shop.customers ORDER BY id`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /SELECT \* FROM shop.customers/ })).toBeVisible();
  await page.getByRole('grid', { name: 'Rows' }).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.getByRole('button', { name: 'Export', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'INSERT', exact: true }).click();
  const inserts = await page.evaluate(() => navigator.clipboard.readText());
  expect(inserts).toMatch(/^INSERT INTO shop\.customers \(/);
  // The inserts and the comparison run as one script, in order.
  const copied = inserts.replaceAll('INSERT INTO shop.customers', `INSERT INTO ${copy}`);
  await write(
    page,
    `${copied}
SELECT count(*) AS missing FROM (SELECT * FROM shop.customers EXCEPT SELECT * FROM ${copy}) AS rest`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /SELECT count\(\*\) AS missing/ })).toBeVisible();
  await expect(page.getByRole('grid', { name: 'Rows' }).getByRole('gridcell').first()).toHaveText(
    '0',
  );
});
