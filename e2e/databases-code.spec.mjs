// End-to-end test of the code of a statement (DB-33) on SQLite, which needs no server: the
// program of the statement at the cursor, in another language, and a string pasted from a
// program put back in the editor as SQL.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

test.use({ ownServer: 'sqlite' });

test('the code of a statement reads the connection from DATABASE_URL', async ({ page, nexo }) => {
  test.setTimeout(90_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  const file = test.info().outputPath('code.db').replaceAll('\\', '/');
  await nexo.signIn(page);
  await addConnection(page, 'Code', {
    label: 'SQLite',
    url: () => `jdbc:sqlite:${file}?create=true`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const connection = tree.getByRole('treeitem', { name: /^Code/ });
  await connection.focus();
  await page.keyboard.press('ArrowRight');
  await expect(connection).toHaveAttribute('aria-expanded', 'true');
  await newScript(page);
  await write(page, "SELECT 'it''s' AS quote");
  await page.getByRole('button', { name: 'Code', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Code' });
  const program = dialog.locator('.cm-content[aria-label="Code"]');
  await expect(program).toContainText("import Database from 'better-sqlite3';");
  await expect(program).toContainText('process.env.DATABASE_URL');
  await expect(program).not.toContainText(file);
  expect(await violations(page)).toEqual([]);
  await dialog.getByLabel('Language').selectOption('python');
  await expect(program).toContainText('import sqlite3');

  await dialog.getByText('Paste from code').click();
  await dialog
    .getByRole('textbox', { name: /A string of a statement/ })
    .fill('sql = ("SELECT 2 "\n  "AS two")');
  await expect(dialog.locator('pre')).toHaveText('SELECT 2 AS two');
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Put it in the editor' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.cm-content[aria-label="SQL script"]')).toContainText(
    'SELECT 2 AS two',
  );
});
