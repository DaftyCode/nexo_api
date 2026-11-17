// End-to-end test of the entity-relationship diagrams on a SQLite file (DB-20): the diagram of
// the tables of a connection opened from the navigator, an entity moved with the keyboard and
// kept there, the notation changed, the diagram shown as a list and exported as SVG; then the
// «Diagram» view of a table. Checked with axe. It needs no server.
import { readFile } from 'node:fs/promises';
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, folder, newScript, write } from './databases-helpers.mjs';

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'diagrams' });

test('a diagram is opened, moved, drawn in another notation and exported', async ({
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
  await write(
    page,
    `CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, person INTEGER REFERENCES people (id), total REAL);
CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
SELECT count(*) AS made FROM orders`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /AS made/ })).toBeVisible();
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Tienda/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Refresh/ }).click();
  await tree.getByRole('treeitem', { name: /^Tienda/ }).focus();
  await page.keyboard.press('ArrowRight');
  const tables = folder(tree, 'Tables');
  await expect(tables).toBeVisible();

  // The diagram of every table, from the menu of their folder.
  await tables.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'View diagram' }).click();
  const canvas = page.getByRole('group', { name: 'Diagram', exact: true });
  const orders = canvas.getByRole('button', { name: /^orders/ });
  await expect(orders).toBeVisible();
  await expect(orders).toContainText('person');
  await expect(canvas.getByRole('button', { name: /^people/ })).toBeVisible();
  await expect(canvas.getByRole('button', { name: /^notes/ })).toContainText('body');
  await expect(page.locator('.erd-relation')).toHaveCount(1);
  expect(await violations(page)).toEqual([]);

  // An entity moved with the keyboard stays where it was put, also after another tab.
  const before = await orders.getAttribute('transform');
  await orders.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('ArrowRight');
  await expect(orders).not.toHaveAttribute('transform', before ?? '');
  const moved = await orders.getAttribute('transform');
  await newScript(page);
  await page.getByRole('tab', { name: /Diagram: Tables/ }).click();
  await expect(canvas.getByRole('button', { name: /^orders/ })).toHaveAttribute(
    'transform',
    moved ?? '',
  );

  // Another notation: UML writes the multiplicities.
  await page.getByLabel('Notation').selectOption('uml');
  await expect(page.locator('.erd-label').first()).toHaveText(/^(\*|1|0\.\.1)$/);
  await page.getByLabel('Columns shown').selectOption('keys');
  await expect(canvas.getByRole('button', { name: /^notes/ })).not.toContainText('body');

  // As a list, for a screen reader.
  await page.getByRole('button', { name: 'As a list' }).click();
  await expect(page.getByRole('heading', { name: 'Tables (3)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Relations (1)' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: 'As a list' }).click();

  // Exported as SVG, in the colors of the theme.
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'SVG', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('Tables.svg');
  const svg = await readFile(await download.path(), 'utf8');
  expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
  expect(svg).toContain('>orders</text>');
  expect(svg).not.toContain('var(--');

  // The «Diagram» view of a table: the table and those one step away.
  await page.keyboard.press('Escape');
  await tables.focus();
  await page.keyboard.press('ArrowRight');
  await tree.getByRole('treeitem', { name: /^orders/ }).dblclick();
  await page
    .getByRole('navigation', { name: 'Object views' })
    .getByRole('button', { name: 'Diagram' })
    .click();
  const near = page.getByRole('group', { name: 'Diagram', exact: true });
  await expect(near.getByRole('button', { name: /^people/ })).toBeVisible();
  await expect(near.getByRole('button', { name: /notes/ })).toHaveCount(0);
  expect(await violations(page)).toEqual([]);
});
