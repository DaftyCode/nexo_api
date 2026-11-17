// End-to-end test of the structure editor on a SQLite file: a table created from the form
// with its key, a foreign key and an index; a column's type changed in place in its
// «Columns» view (SQLite rebuilds the table and says so); the table dropped after typing
// its name; and a new view started from its template, as a script. It needs no server.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, folder, newScript, write } from './databases-helpers.mjs';

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'structure' });

test('a table is created, changed in place and dropped, and a view starts from a template', async ({
  page,
  nexo,
}) => {
  test.setTimeout(150_000);
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
  await write(page, 'CREATE TABLE people (id INTEGER PRIMARY KEY)');
  await page.keyboard.press('ControlOrMeta+Enter');
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Tienda/ }).focus();
  await page.keyboard.press('ArrowRight');
  const tables = folder(tree, 'Tables');
  await tables.focus();
  await page.keyboard.press('ArrowRight');
  await expect(tree.getByRole('treeitem', { name: /^people/ })).toBeVisible();

  // A new table from the form.
  await tables.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New table…' }).click();
  const editor = page.getByRole('dialog', { name: 'New table' });
  await editor.getByLabel('Table name').fill('orders');
  await editor.getByRole('button', { name: 'Add column' }).click();
  await editor.getByLabel('Name of column 2').fill('person');
  await editor.getByLabel('Name of column 2').press('Tab');
  await editor.getByLabel('Type of person').fill('INTEGER');
  await editor.getByLabel('Type of person').press('Tab');
  await editor.getByRole('button', { name: 'Add column' }).click();
  await editor.getByLabel('Name of column 3').fill('status');
  await editor.getByLabel('Name of column 3').press('Tab');
  await editor.getByLabel('Type of status').fill('TEXT');
  await editor.getByLabel('Type of status').press('Tab');
  await editor.getByRole('button', { name: 'Keys and indexes' }).click();
  await editor.getByRole('button', { name: 'Add foreign key' }).click();
  await editor.getByLabel('Foreign key columns').fill('person');
  await editor.getByLabel('Referenced table').fill('people');
  await editor.getByLabel('Referenced columns').fill('id');
  await editor.getByLabel('Referenced columns').press('Tab');
  await editor.getByRole('button', { name: 'Add index' }).click();
  await editor.getByLabel('Index columns').fill('status');
  await editor.getByLabel('Index columns').press('Tab');
  expect(await violations(page)).toEqual([]);
  await editor.getByRole('button', { name: 'Show the changes' }).click();
  const review = page.getByRole('dialog', { name: 'The statements that make the change' });
  const statements = review.getByLabel('Statements');
  await expect(statements).toHaveValue(/CREATE TABLE "orders"/);
  await expect(statements).toHaveValue(/FOREIGN KEY \("person"\) REFERENCES "people" \("id"\)/);
  await expect(statements).toHaveValue(/CREATE INDEX "orders_index1" ON "orders" \("status"\)/);
  expect(await violations(page)).toEqual([]);
  await review.getByRole('button', { name: 'Run' }).click();
  await expect(editor).toBeHidden();
  const orders = tree.getByRole('treeitem', { name: /^orders/ });
  await expect(orders).toBeVisible();

  // The type of a column changed in its «Columns» view: SQLite rebuilds the table.
  await orders.dblclick();
  await page
    .getByRole('navigation', { name: 'Object views' })
    .getByRole('button', { name: 'Columns' })
    .click();
  const type = page.getByLabel('Type of status');
  await expect(type).toHaveValue('TEXT');
  // The list holds every type of the engine, not only what is written; the current one marked.
  const cell = page.locator('app-db-type-picker').filter({ has: type });
  await cell.getByRole('button', { name: 'Show the types' }).click();
  const types = page.getByRole('listbox', { name: 'Types' });
  await expect.poll(() => types.getByRole('option').count()).toBeGreaterThan(3);
  await expect(types.getByRole('option', { name: 'TEXT', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await violations(page)).toEqual([]);
  await types.getByRole('option', { name: 'INTEGER', exact: true }).click();
  await expect(type).toHaveValue('INTEGER');
  await type.press('ArrowDown');
  await expect(types).toBeVisible();
  await type.press('Escape');
  await expect(types).toBeHidden();
  await type.fill('VARCHAR(10)');
  await type.press('Tab');
  await page
    .getByRole('toolbar', { name: 'Columns' })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(review).toContainText('created again');
  await expect(review.getByLabel('Statements')).toHaveValue(/"status" VARCHAR\(10\)/);
  await review.getByRole('button', { name: 'Run' }).click();
  await expect(review).toBeHidden();
  await expect(page.getByLabel('Type of status')).toHaveValue('VARCHAR(10)');

  // Dropped after typing its name.
  await orders.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Drop table…' }).click();
  const drop = page.getByRole('dialog', { name: 'Drop orders' });
  await drop.getByRole('button', { name: 'Show the DROP' }).click();
  await expect(review.getByRole('button', { name: 'Run' })).toBeDisabled();
  await review.getByLabel('Type orders to confirm').fill('orders');
  await review.getByRole('button', { name: 'Run' }).click();
  await expect(drop).toBeHidden();
  await expect(orders).toBeHidden();

  // Other objects start from a template of their engine, in a new script.
  await folder(tree, 'Views').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New in Views… (as SQL)' }).click();
  await expect(page.locator('.cm-content[aria-label="SQL script"]').last()).toContainText(
    'CREATE VIEW new_view AS',
  );
});
