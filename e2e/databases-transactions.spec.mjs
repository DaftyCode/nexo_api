// End-to-end test of manual transactions on a SQLite file: the commit mode switched from the
// tab, a write counted until it is rolled back, its log, the list of pending transactions,
// and the question when a tab with changes is closed. It needs no server, so it always runs.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, newScript, write } from './databases-helpers.mjs';

// The other database files leave their sessions open, up to the limit a server allows.
test.use({ ownServer: 'transactions' });

test('a manual transaction is counted, logged, rolled back and asked about', async ({
  page,
  nexo,
}) => {
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
  await write(page, 'CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT)');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('button', { name: 'Auto-commit' })).toBeVisible();

  // Manual commit: the write waits, counted, until it is rolled back.
  await page.getByRole('button', { name: 'Auto-commit' }).click();
  await write(page, "INSERT INTO items (label) VALUES ('lamp')");
  await page.keyboard.press('ControlOrMeta+Enter');
  const commit = page.getByRole('button', { name: /^Commit/ });
  await expect(commit).toBeEnabled();
  await expect(commit).toContainText('1');
  await page.getByRole('button', { name: 'Transaction log' }).click();
  const log = page.getByRole('dialog', { name: 'Transaction log' });
  await expect(log).toContainText("INSERT INTO items (label) VALUES ('lamp')");
  expect(await violations(page)).toEqual([]);
  await log.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: /^Transactions/ }).click();
  const pending = page.getByRole('dialog', { name: 'Pending transactions' });
  await expect(pending.getByRole('article', { name: 'Tienda' })).toBeVisible();
  await pending.getByRole('button', { name: 'Rollback' }).click();
  await expect(pending).toContainText('No transaction waits');
  await pending.getByRole('button', { name: 'Close' }).click();
  await expect(commit).toBeDisabled();

  // Closing the tab with a change pending asks; committing closes it.
  await write(page, "INSERT INTO items (label) VALUES ('desk')");
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(commit).toBeEnabled();
  const scripts = page.getByRole('tab', { name: /Tienda · SQL/ });
  const open = await scripts.count();
  await page
    .getByRole('tab', { name: /Tienda · SQL/, selected: true })
    .locator('.db-tab-close')
    .click();
  const closing = page.getByRole('dialog', { name: 'Changes not committed' });
  await expect(closing).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await closing.getByRole('button', { name: 'Commit' }).click();
  await expect(scripts).toHaveCount(open - 1);
});
