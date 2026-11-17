// End-to-end test of the database search on a SQLite file: objects found by name open their
// tab, a value found in the data opens the table on the rows that hold it, and a line of the
// history opens in a script. It needs no server.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'search' });

test('the search finds objects, data and history, and opens each one', async ({ page, nexo }) => {
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
  await write(
    page,
    `CREATE TABLE orders (id INTEGER, order_note TEXT);
CREATE TABLE notes (id INTEGER, body TEXT);
INSERT INTO orders VALUES (1, 'gift 50%_off'), (2, 'plain');
INSERT INTO notes VALUES (3, 'nothing'), (4, 'GIFT 50%_OFF too');
CREATE VIEW open_orders AS SELECT * FROM orders WHERE id > 0;
SELECT count(*) AS stored FROM orders`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /AS stored/ })).toBeVisible();

  // Objects by name.
  await page.keyboard.press('ControlOrMeta+h');
  const dialog = page.getByRole('dialog', { name: 'Search the databases' });
  await dialog.getByLabel('Name, with * or % as wildcards').fill('%order%');
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  const objects = dialog.getByRole('region', { name: 'Objects found' });
  await expect(objects).toContainText('open_orders');
  await expect(objects).toContainText('orders.order_note');
  expect(await violations(page)).toEqual([]);
  await objects.getByRole('button', { name: /^Table\s+orders/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { name: 'orders' })).toBeVisible();

  // A value in the data, its wildcards literal.
  await page.keyboard.press('ControlOrMeta+h');
  await dialog.getByRole('button', { name: 'Data', exact: true }).click();
  await dialog.getByRole('button', { name: 'List the tables' }).click();
  await expect(dialog.getByLabel('notes')).toBeChecked();
  await dialog.getByLabel('Text to find').fill('50%_off');
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  const data = dialog.getByRole('region', { name: 'Data found' });
  // The two tables, and the view that shows one of them.
  await expect(data.getByRole('button')).toHaveCount(3);
  await expect(data).toContainText('open_orders');
  expect(await violations(page)).toEqual([]);
  await data.getByRole('button', { name: /^notes/ }).click();
  const grid = page.getByRole('grid', { name: 'Rows' });
  await expect(grid).toContainText('GIFT 50%_OFF too');
  await expect(grid).not.toContainText('nothing');

  // A line of the history, opened in a script.
  await page.keyboard.press('ControlOrMeta+h');
  await dialog.getByRole('button', { name: 'Scripts', exact: true }).click();
  await dialog.getByLabel('Text to find').fill('CREATE VIEW open_orders');
  await dialog.getByRole('button', { name: 'Search', exact: true }).click();
  const lines = dialog.getByRole('region', { name: 'Lines found' });
  await expect(lines.getByRole('button').first()).toContainText('History');
  await lines.getByRole('button').first().click();
  await expect(page.locator('.cm-content[aria-label="SQL script"]').last()).toContainText(
    'CREATE VIEW open_orders',
  );
});
