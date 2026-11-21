// End-to-end test of comparing two SQLite files: their structure part by part with the
// script that makes the target like the source, opened in a SQL tab of the target; and the
// rows of a table compared and synchronized once its name is typed. It needs no server.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, folder, write } from './databases-helpers.mjs';

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'compare' });

/** Opens the menu of a node of the tree and chooses an entry. */
async function nodeMenu(page, name, entry) {
  await page
    .getByRole('tree', { name: 'Connections' })
    .getByRole('treeitem', { name: new RegExp(`^${name}`) })
    .first()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: entry }).click();
}

/** Runs a script on a connection, in a SQL tab of its own. */
async function run(page, connection, script, done) {
  await nodeMenu(page, connection, /^New SQL script/);
  await write(page, script);
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: new RegExp(done) })).toBeVisible();
}

test('two SQLite files are compared and the rows of a table synchronized', async ({
  page,
  nexo,
}) => {
  test.setTimeout(180_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  const file = (name) => test.info().outputPath(name).replaceAll('\\', '/');
  await nexo.signIn(page);
  for (const [name, path] of [
    ['Uno', file('uno.db')],
    ['Dos', file('dos.db')],
  ])
    await addConnection(page, name, {
      label: 'SQLite',
      url: () => `jdbc:sqlite:${path}?create=true`,
    });
  await run(
    page,
    'Uno',
    `CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, price REAL);
CREATE INDEX items_label ON items (label);
CREATE TABLE extra (id INTEGER PRIMARY KEY);
INSERT INTO items VALUES (1, 'lamp', 9.5), (2, 'desk', 120), (3, 'chair', 45);
SELECT count(*) AS uno FROM items`,
    'AS uno',
  );
  await run(
    page,
    'Dos',
    `CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL, price INTEGER);
INSERT INTO items VALUES (1, 'lamp', 9.5), (2, 'desk', 99), (4, 'stool', 12);
SELECT count(*) AS dos FROM items`,
    'AS dos',
  );

  // The structure: the whole files.
  await nodeMenu(page, 'Uno', 'Compare with…');
  const compare = page.locator('app-db-compare');
  await expect(compare).toContainText('Compares Uno with:');
  await compare.getByLabel('Compare with the connection').selectOption({ label: 'Dos' });
  await compare.getByLabel('Schema or database').selectOption({ label: 'Dos' });
  await compare.getByRole('button', { name: 'Compare', exact: true }).click();
  const objects = compare.locator('.db-compare-objects');
  await expect(objects.getByRole('button', { name: /^items\s*Different/ })).toBeVisible();
  await expect(objects.getByRole('button', { name: /^extra\s*Only in the source/ })).toBeVisible();
  await objects.getByRole('button', { name: /^items/ }).click();
  const parts = compare.locator('.db-compare-parts');
  await expect(parts.getByRole('row', { name: /Column price Different type/ })).toBeVisible();
  await expect(
    parts.getByRole('row', { name: /Index items_label Only in the source/ }),
  ).toBeVisible();
  await expect(compare.getByLabel('Source', { exact: true })).toContainText('price REAL');
  await expect(compare.getByLabel('Target', { exact: true })).toContainText('price INTEGER');
  expect(await violations(page)).toEqual([]);
  await compare.getByRole('button', { name: 'Write the script' }).click();
  const script = compare.getByLabel('Script', { exact: true });
  await expect(script).toContainText('CREATE TABLE');
  await expect(script).toContainText('extra');
  await expect(script).toContainText('items_label');
  await compare.getByRole('button', { name: 'Open in a SQL tab of the target' }).click();
  await expect(page.locator('.cm-content[aria-label="SQL script"]')).toContainText('extra');

  // The rows of one table.
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Uno/ }).focus();
  await page.keyboard.press('ArrowRight');
  await folder(tree, 'Tables').first().focus();
  await page.keyboard.press('ArrowRight');
  await nodeMenu(page, 'items', 'Compare with…');
  const rows = page.locator('app-db-compare').filter({ hasText: 'Compares Uno / items with:' });
  await rows.getByRole('button', { name: 'Data', exact: true }).click();
  await rows.getByLabel('Compare with the connection').selectOption({ label: 'Dos' });
  await rows.getByRole('combobox', { name: /^Table/ }).selectOption({ label: 'items' });
  await rows.getByRole('button', { name: 'Compare', exact: true }).click();
  const counts = rows.getByRole('status');
  await expect(counts).toHaveText(
    'Only in the source: 1 · Only in the target: 1 · Different: 1 · Equal: 1',
  );
  await expect(rows.locator('.db-compare-parts')).toContainText('2 · desk · 120');
  expect(await violations(page)).toEqual([]);
  await rows.getByLabel('Also delete the rows only the target has').check();
  const synchronize = rows.getByRole('button', { name: 'Synchronize the target' });
  await expect(synchronize).toBeDisabled();
  await rows.getByLabel('Type items to change the rows of that table').fill('items');
  await synchronize.click();
  await expect(page.locator('.toast').filter({ hasText: 'Rows synchronized' })).toContainText(
    '1 inserted, 1 updated and 1 deleted.',
  );
  await rows.getByRole('button', { name: 'Compare', exact: true }).click();
  await expect(counts).toHaveText(
    'Only in the source: 0 · Only in the target: 0 · Different: 0 · Equal: 3',
  );
});
