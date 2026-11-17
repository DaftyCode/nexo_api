// End-to-end test of the SQL editor's help, on a SQLite file: columns of an alias and the
// condition of a foreign key suggested from the schema, formatting, a template, the values
// of a named parameter asked for and bound, and the console. It needs no server.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'assist' });

/** Puts the cursor after the first `marker` of the editor's text, and asks for suggestions. */
async function suggestAt(page, text, marker) {
  await write(page, text);
  await page.keyboard.press('ControlOrMeta+Home');
  for (let i = 0; i < text.indexOf(marker) + marker.length; i++)
    await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+Space');
  return page.locator('.cm-tooltip-autocomplete');
}

test('the SQL editor suggests, formats, fills templates and asks for parameters', async ({
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
    `CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id), total REAL);
INSERT INTO users (name) VALUES ('Ann'), ('O''Brien');
INSERT INTO orders (user_id, total) VALUES (1, 10), (2, 25.5);
SELECT count(*) AS stored FROM orders`,
  );
  await page.keyboard.press('Alt+x');
  await expect(page.getByRole('tab', { name: /AS stored/ })).toBeVisible();
  // The tree learns the new tables.
  const tree = page.getByRole('tree', { name: 'Connections' });
  await tree.getByRole('treeitem', { name: /^Tienda/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Refresh/ }).click();

  // The columns of an alias, and the condition of the foreign key after JOIN … ON.
  let suggestions = await suggestAt(page, 'SELECT o. FROM orders o', 'o.');
  await expect(suggestions).toContainText('user_id');
  await expect(suggestions).toContainText('total');
  expect(await violations(page)).toEqual([]);
  await page.keyboard.press('Escape');
  suggestions = await suggestAt(page, 'SELECT * FROM orders o JOIN users u ON ', ' ON ');
  await expect(suggestions).toContainText('o.user_id = u.id');
  await page.keyboard.press('Escape');

  // Formatting the statement keeps its words and puts each clause on its line.
  await write(page, 'select id,total from orders where total>5 order by id');
  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  const editor = page.locator('.cm-content[aria-label="SQL script"]');
  await expect(editor).toContainText('SELECT');
  await expect(page.locator('.cm-line').filter({ hasText: /^FROM orders/ })).toHaveCount(1);
  await expect(page.locator('.cm-line').filter({ hasText: /^WHERE total > 5/ })).toHaveCount(1);

  // A template: its abbreviation and Tab.
  await write(page, '');
  await page.keyboard.type('scount');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('scount');
  await page.keyboard.press('Tab');
  await expect(editor).toContainText('SELECT COUNT(*) FROM');

  // A named parameter, asked for and bound: a quote in its value breaks nothing.
  await write(page, 'SELECT id FROM users WHERE name = :name');
  await page.keyboard.press('ControlOrMeta+Enter');
  const parameters = page.getByRole('dialog', { name: 'The parameters of the statement' });
  await expect(parameters).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await parameters.getByLabel(':name').fill("O'Brien");
  await parameters.getByRole('button', { name: 'Run' }).click();
  await expect(page.getByRole('grid', { name: 'Rows' })).toContainText('2');

  // The console: a statement, its rows as text.
  await tree.getByRole('treeitem', { name: /^Tienda/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'SQL console' }).click();
  const prompt = page.getByLabel('Statement to run');
  await prompt.fill('SELECT name FROM users ORDER BY id');
  await prompt.press('Enter');
  const log = page.getByRole('log');
  await expect(log).toContainText('> SELECT name FROM users ORDER BY id');
  await expect(log).toContainText("O'Brien");
  expect(await violations(page)).toEqual([]);
});
