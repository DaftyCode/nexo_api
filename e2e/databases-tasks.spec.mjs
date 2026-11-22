// End-to-end test of saved database tasks (DB-31) on SQLite, which needs no server: a script
// is saved, a task runs it by hand, its run is in its history, and a statement on every row
// fails until the task authorizes it.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

test.use({ ownServer: 'sqlite' });

test('a task runs a saved script, keeps its run and asks for what it authorizes', async ({
  page,
  nexo,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('sqlite'),
    'Build the SQLite driver: cargo build -p nexo-driver-sqlite',
  );
  const file = test.info().outputPath('tasks.db').replaceAll('\\', '/');
  await nexo.signIn(page);
  await addConnection(page, 'Tasks', {
    label: 'SQLite',
    url: () => `jdbc:sqlite:${file}?create=true`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const connection = tree.getByRole('treeitem', { name: /^Tasks/ });
  await connection.focus();
  await page.keyboard.press('ArrowRight');
  await expect(connection).toHaveAttribute('aria-expanded', 'true');
  await newScript(page);
  await write(
    page,
    `CREATE TABLE IF NOT EXISTS logs (id INTEGER);
INSERT INTO logs VALUES (1), (2);
DELETE FROM logs`,
  );
  await page.getByRole('button', { name: /^Save/ }).click();
  const naming = page.getByRole('dialog', { name: 'Save script' });
  await naming.getByLabel('Script name').fill('Clean logs');
  await naming.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(naming).toBeHidden();

  await page.getByRole('button', { name: 'Database tasks' }).click();
  const tasks = page.getByRole('dialog', { name: 'Database tasks' });
  await expect(tasks).toContainText('No tasks yet.');
  await tasks.getByRole('button', { name: 'New task' }).click();
  await tasks.getByLabel('Name', { exact: true }).fill('Nightly clean');
  await tasks.getByLabel('Clean logs', { exact: true }).check();
  await tasks.getByLabel('Tasks', { exact: true }).check();
  await tasks.getByRole('button', { name: 'Save', exact: true }).click();
  const row = tasks.getByRole('row', { name: /Nightly clean/ });
  await expect(row).toContainText('By hand');
  expect(await violations(page)).toEqual([]);

  await row.getByRole('button', { name: /Run$/ }).click();
  await expect(row).toContainText('Failed');
  await expect(tasks.locator('.db-tasks-runs')).toContainText('does not authorize');

  await row.getByRole('button', { name: 'Edit' }).click();
  await tasks.getByLabel(/^Statements on every row/).check();
  await expect(tasks.getByRole('note')).toContainText('without anybody confirming it');
  expect(await violations(page)).toEqual([]);
  await tasks.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row).toContainText('Authorized without asking');
  await row.getByRole('button', { name: /Run$/ }).click();
  await expect(row).toContainText('Passed');
  await expect(tasks.locator('.db-tasks-runs li')).toHaveCount(2);
  await tasks.getByRole('button', { name: 'Close' }).click();
  await expect(tasks).toBeHidden();
});
