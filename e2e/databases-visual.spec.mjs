// End-to-end tests of the visual query builder (DB-26) and of importing connections (DB-25),
// on SQLite, which needs no server: two related tables built from a script, joined on the
// canvas by their foreign key, a column chosen, a condition with a quote and the query run; and
// a list of URLs read and imported, with the report shown first.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

test.use({ ownServer: 'sqlite' });

test('the visual builder joins two tables by their key and runs what it writes', async ({
  page,
  nexo,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  const file = test.info().outputPath('visual.db').replaceAll('\\', '/');
  await nexo.signIn(page);
  await addConnection(page, 'Visual', {
    label: 'SQLite',
    url: () => `jdbc:sqlite:${file}?create=true`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const connection = tree.getByRole('treeitem', { name: /^Visual/ });
  await connection.focus();
  await page.keyboard.press('ArrowRight');
  await expect(connection).toHaveAttribute('aria-expanded', 'true');
  await newScript(page);
  await write(
    page,
    `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id), total REAL);
INSERT INTO users VALUES (1, 'Ada'), (2, 'O''Brien');
INSERT INTO orders VALUES (1, 1, 10), (2, 2, 20), (3, 2, 30)`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.locator('app-db-results')).toContainText('3');

  await newScript(page);
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  const builder = page.getByRole('region', { name: 'Visual query builder' });
  await builder.getByRole('button', { name: 'Add users' }).click();
  await builder.getByRole('button', { name: 'Add orders' }).click();
  const sql = builder.getByLabel('The SQL it writes');
  await expect(sql).toContainText('INNER JOIN orders o ON o.user_id = u.id');
  await builder.getByRole('group', { name: 'users' }).getByLabel('name').check();
  await builder.getByRole('group', { name: 'orders' }).getByLabel('total').check();
  await builder.getByRole('button', { name: 'Conditions', exact: true }).click();
  await builder.getByRole('button', { name: '＋ Condition' }).first().click();
  await builder.getByLabel('Column or expression').first().fill('u.name');
  await builder.getByLabel('Column or expression').first().press('Tab');
  await builder.getByLabel('Value', { exact: true }).fill("O'Brien");
  await builder.getByLabel('Value', { exact: true }).press('Tab');
  await expect(sql).toContainText("WHERE u.name = 'O''Brien'");
  expect(await violations(page)).toEqual([]);
  await builder.getByRole('button', { name: /Run$/ }).click();
  const grid = page.locator('app-data-grid');
  await expect(grid).toContainText('30');
  await expect(grid).not.toContainText('Ada');

  // Back to the text: the statement is there, as the builder wrote it.
  await page.getByRole('button', { name: 'Text', exact: true }).click();
  await expect(page.locator('.cm-content[aria-label="SQL script"]')).toContainText(
    'SELECT u.name,',
  );
});

test('connections are imported from a list of URLs after seeing what comes', async ({
  page,
  nexo,
}) => {
  test.setTimeout(60_000);
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Databases' })
    .click();
  await page.getByRole('button', { name: 'Navigator options' }).click();
  await page.getByRole('menuitem', { name: 'Import connections…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import connections' });
  await dialog
    .getByLabel('Or paste URLs or the content of a file')
    .fill('postgresql://ana:secret@db.example.com:5432/shop\nftp://nowhere');
  await dialog.getByRole('button', { name: 'Read', exact: true }).click();
  await expect(dialog).toContainText('From a list of URLs: 1 connections');
  await expect(dialog).toContainText('It is not a URL of a database Nexo knows');
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Import 1 connections' }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('tree', { name: 'Connections' }).getByRole('treeitem', {
      name: /^ana@db\.example\.com:5432\/shop/,
    }),
  ).toBeVisible();
});

test('test data fills a table with a key and a unique column, the dialog checked by axe', async ({
  page,
  nexo,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  const file = test.info().outputPath('mock.db').replaceAll('\\', '/');
  await nexo.signIn(page);
  await addConnection(page, 'Mock', {
    label: 'SQLite',
    url: () => `jdbc:sqlite:${file}?create=true`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const connection = tree.getByRole('treeitem', { name: /^Mock/ });
  await connection.focus();
  await page.keyboard.press('ArrowRight');
  await newScript(page);
  await write(
    page,
    `CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO teams VALUES (1, 'Red'), (2, 'Blue');
CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, team_id INTEGER REFERENCES teams (id))`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.locator('app-db-results')).toContainText('Last inserted rowid');
  await expect(page.locator('.db-sql-running')).toHaveCount(0);
  const tables = tree.getByRole('treeitem', { name: /^Tables/ });
  await tables.focus();
  await page.keyboard.press('F5');
  await page.keyboard.press('ArrowRight');
  const people = tree.getByRole('treeitem', { name: /^people/ });
  await people.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Generate test data…' }).click();
  const dialog = page.getByRole('dialog', { name: /^Test data for/ });
  await expect(dialog).toContainText('A key of teams, read before writing');
  await dialog.getByLabel('Rows', { exact: true }).fill('50');
  await dialog.getByLabel('Rows', { exact: true }).press('Tab');
  await dialog.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(dialog.getByRole('table', { name: 'Preview' })).toContainText('@example.com');
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect(dialog).toContainText('50 rows written; 0 refused by the database.');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await write(page, 'SELECT count(*) AS made, count(DISTINCT email) AS emails FROM people');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('app-data-grid')).toContainText('50');
});

test('a query is charted without being told how, and its table has the same numbers', async ({
  page,
  nexo,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  const file = test.info().outputPath('chart.db').replaceAll('\\', '/');
  await nexo.signIn(page);
  await addConnection(page, 'Charts', {
    label: 'SQLite',
    url: () => `jdbc:sqlite:${file}?create=true`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Charts/ }).focus();
  await page.keyboard.press('ArrowRight');
  await newScript(page);
  await write(
    page,
    `CREATE TABLE sales (city TEXT, total INTEGER);
INSERT INTO sales VALUES ('Lima', 3), ('Quito', 5), ('Lima', 4);
SELECT city, sum(total) AS total FROM sales GROUP BY city ORDER BY city`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /SELECT city/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Result views' })
    .getByRole('button', { name: 'Chart' })
    .click();
  const chart = page.locator('app-result-chart');
  await expect(
    chart.getByRole('img', { name: 'Chart of city: 2 categories, 1 series' }),
  ).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await chart.getByRole('button', { name: 'Show as a table' }).click();
  await expect(chart.getByRole('table')).toContainText('Lima7');
  await expect(chart.getByRole('table')).toContainText('Quito5');
  expect(await violations(page)).toEqual([]);
});
