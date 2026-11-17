// End-to-end test of execution plans: on a SQLite file, a filter reads the table whole and
// says so until an index serves it, with the plan as SQLite wrote it; on PostgreSQL, the
// actual plan of an UPDATE is measured, asked first, and changes nothing.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { POSTGRES, addConnection, newScript, write } from './databases-helpers.mjs';

const environment = process.env;

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'plan' });

test('a plan warns about a full scan until an index serves the filter', async ({ page, nexo }) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  const file = test.info().outputPath('shop.db').replaceAll('\\', '/');
  await nexo.signIn(page);
  await addConnection(page, 'Tienda', {
    label: 'SQLite',
    url: () => `jdbc:sqlite:${file}?create=true`,
  });
  await newScript(page);
  await write(
    page,
    `CREATE TABLE items (id INTEGER, label TEXT);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
INSERT INTO items SELECT i, 'item ' || i FROM n;
SELECT count(*) AS stored FROM items`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /AS stored/ })).toBeVisible();

  await write(page, 'SELECT label FROM items WHERE id = 5');
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  const plan = page.locator('app-db-plan');
  await expect(plan.getByText('Estimated plan')).toBeVisible();
  await expect(plan.getByRole('table', { name: 'Plan nodes' })).toContainText('SCAN');
  await expect(plan.getByRole('list', { name: 'Warnings' })).toContainText('items is read whole');
  // SQLite only estimates: there is nothing to measure.
  await expect(plan.getByRole('button', { name: 'Run it to measure' })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
  await plan.getByRole('button', { name: 'Original plan' }).click();
  await expect(plan.locator('.cm-content')).toContainText('QUERY PLAN');

  await write(page, 'CREATE INDEX items_id ON items (id)');
  await page.keyboard.press('ControlOrMeta+Enter');
  await write(page, 'SELECT label FROM items WHERE id = 5');
  await page.getByRole('button', { name: 'Explain', exact: true }).click();
  const indexed = page.locator('app-db-plan');
  await expect(indexed.getByRole('table', { name: 'Plan nodes' })).toContainText('items_id');
  await expect(indexed.getByRole('list', { name: 'Warnings' })).toHaveCount(0);
});

test('the actual plan of an UPDATE is measured and changes nothing', async ({ page, nexo }) => {
  test.setTimeout(120_000);
  test.skip(!environment.NEXO_SQL_PG_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Planes', POSTGRES);
  await newScript(page);
  // A table of its own: dropping one would ask for its name.
  const table = `public.e2e_plans_${Date.now()}`;
  await write(
    page,
    `CREATE TABLE ${table} AS SELECT n AS id, 'row' AS label FROM generate_series(1, 3000) n;
SELECT count(*) AS stored FROM ${table}`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /AS stored/ })).toBeVisible();

  await write(page, `UPDATE ${table} SET label = 'changed' WHERE id < 100`);
  await page.keyboard.press('ControlOrMeta+Shift+KeyE');
  const plan = page.locator('app-db-plan');
  await expect(plan.getByText('Estimated plan')).toBeVisible();
  await plan.getByRole('button', { name: 'Run it to measure' }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm the statement' });
  await expect(confirm).toContainText('rolled back at the end');
  expect(await violations(page)).toEqual([]);
  await confirm.getByRole('button', { name: 'Run' }).click();
  await expect(plan.getByText('Actual plan')).toBeVisible();
  await expect(plan.getByText('Rolled back')).toBeVisible();
  await expect(plan.getByRole('table', { name: 'Plan nodes' })).toContainText('Update');
  expect(await violations(page)).toEqual([]);

  await write(page, `SELECT count(*) AS changed FROM ${table} WHERE label = 'changed'`);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('grid', { name: 'Rows' }).last()).toContainText('0');
});
