// End-to-end test of the SQLite module: a connection from a pasted URL that makes a new file
// (the web version types the path), a table created from a script, opened from the tree with
// a double click on its data, and its DDL. It needs no server, so it always runs.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, folder, newScript, write } from './databases-helpers.mjs';

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'sqlite' });

test('a SQLite file is made, written from a script and browsed', async ({ page, nexo }) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  // A file of the test's own folder, which Playwright empties before the next run.
  const file = test.info().outputPath('shop.db').replaceAll('\\', '/');
  await nexo.signIn(page);
  await addConnection(page, 'Tienda local', {
    label: 'SQLite',
    url: () => `jdbc:sqlite:${file}?create=true`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const connection = tree.getByRole('treeitem', { name: /^Tienda local/ });
  await connection.focus();
  await page.keyboard.press('ArrowRight');
  await expect(connection).toHaveAttribute('aria-expanded', 'true');

  await newScript(page);
  await write(
    page,
    `CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT);
INSERT INTO items (label) VALUES ('lamp'), ('desk');
SELECT count(*) AS stored FROM items`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /SELECT count\(\*\) AS stored/ })).toBeVisible();
  await expect(page.locator('app-data-grid')).toContainText('2');

  const tables = folder(tree, 'Tables');
  await tables.focus();
  await page.keyboard.press('ArrowRight');
  await tree.getByRole('treeitem', { name: /^items/ }).dblclick();
  await expect(page.getByRole('heading', { name: 'items' })).toBeVisible();
  const grid = page.getByRole('grid', { name: 'Rows' });
  await expect(grid).toContainText('desk');
  expect(await violations(page)).toEqual([]);
  const views = page.getByRole('navigation', { name: 'Object views' });
  await views.getByRole('button', { name: 'DDL' }).click();
  await expect(page.locator('app-db-object-tab .cm-content')).toContainText('CREATE TABLE items');
});
