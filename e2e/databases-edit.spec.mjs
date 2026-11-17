// End-to-end test of editing rows in the grid of a table's «Data» tab, on a SQLite file:
// cells typed in place, a new row and a deleted one, pending until saved as one; the script
// of the save; and the table as the save left it. It needs no server, so it always runs.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, folder, newScript, write } from './databases-helpers.mjs';

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'edit' });

test('rows edited in the grid are saved as one', async ({ page, nexo }) => {
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
    `CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT, price DECIMAL(10, 2));
INSERT INTO items (label, price) VALUES ('lamp', 9.99), ('desk', 120), ('chair', 45);
SELECT count(*) AS stored FROM items`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /AS stored/ })).toBeVisible();

  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Tienda/ }).focus();
  await page.keyboard.press('ArrowRight');
  await folder(tree, 'Tables').focus();
  await page.keyboard.press('ArrowRight');
  await tree.getByRole('treeitem', { name: /^items/ }).dblclick();
  const grid = page.getByRole('grid', { name: 'Rows' });
  await expect(grid).toContainText('chair');

  // Two cells typed in place.
  await grid.getByRole('gridcell', { name: 'lamp' }).click();
  await page.keyboard.press('F2');
  const input = grid.locator('.grid-editor');
  await input.fill('LED lamp');
  await input.press('Enter');
  await grid.getByRole('gridcell', { name: '120', exact: true }).click();
  await page.keyboard.type('130.50');
  await grid.locator('.grid-editor').press('Enter');
  // A new row, and a deleted one.
  await page.getByRole('button', { name: 'Add row' }).click();
  await grid.getByRole('gridcell', { name: 'chair' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete the rows' }).click();
  const save = page.getByRole('button', { name: /^Save \(/ });
  await expect(save).toHaveText('Save (4)');
  expect(await violations(page)).toEqual([]);

  await page.getByRole('button', { name: 'View script' }).click();
  const script = page.getByRole('dialog', { name: 'The script of the save' });
  await expect(script).toContainText("UPDATE items SET label = 'LED lamp' WHERE id = 1;");
  await expect(script).toContainText('DELETE FROM items WHERE id = 3;');
  await script.getByRole('button', { name: 'Close' }).click();

  await save.click();
  await expect(page.locator('.toast').filter({ hasText: 'Changes saved' })).toBeVisible();
  await expect(save).toBeHidden();
  await expect(grid).toContainText('LED lamp');
  await expect(grid).toContainText('130.5');
  await expect(grid).not.toContainText('chair');
  await expect(grid.getByRole('row')).toHaveCount(4);
});
