// End-to-end test of the SQL editor of the database section against the PostgreSQL fixture
// (tools/sql-fixture.sh): statements at the cursor, a selection and a whole script, result
// tabs that accumulate and are pinned and run again, cancelling, errors with their line,
// the history, «View data» and «Open» from the navigator, and the tabs coming back after a
// reload without their results.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

const environment = process.env;

/** Creates the fixture's connection from the wizard, downloading the module. */
async function addConnection(page) {
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Databases' })
    .click();
  await page.getByRole('toolbar', { name: 'Navigator' }).getByRole('button').first().click();
  await page.getByRole('button', { name: /^PostgreSQL/ }).click();
  const download = page.getByRole('dialog', { name: 'Download the PostgreSQL module' });
  await expect(download.or(page.getByLabel('Paste a connection URL'))).toBeVisible();
  if (await download.isVisible()) {
    await download.getByRole('button', { name: 'Download' }).click();
    await expect(download).toBeHidden();
  }
  const { NEXO_SQL_PG_USER: user, NEXO_SQL_PG_PASSWORD: password } = environment;
  await page
    .getByLabel('Paste a connection URL')
    .fill(
      `postgresql://${user}:${password}@${environment.NEXO_SQL_PG_HOST}:${environment.NEXO_SQL_PG_PORT}/${environment.NEXO_SQL_PG_DATABASE}`,
    );
  await page.getByRole('button', { name: 'Use URL' }).click();
  await page.getByLabel('Connection name').fill('Sales');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.toast').filter({ hasText: 'Connection saved' })).toBeVisible();
}

/** Replaces the text of the SQL editor, as typing it. */
async function write(page, text) {
  const editor = page.locator('.cm-content[aria-label="SQL script"]');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

test('the SQL editor keeps a result tab per query and comes back after a reload', async ({
  page,
  nexo,
}) => {
  test.skip(
    !nexo.moduleIds.includes('postgres'),
    'Build the PostgreSQL driver: cargo build -p nexo-driver-postgres',
  );
  test.skip(!environment.NEXO_SQL_PG_HOST, 'Start the SQL fixture: tools/sql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page);

  await page.getByRole('button', { name: '＋ SQL' }).click();
  await write(
    page,
    'SELECT id FROM shop.customers ORDER BY id;\nSELECT count(*) FROM shop.orders;\nSELECT 3 AS three',
  );
  const results = page.getByRole('tablist', { name: 'Results' });
  // The statement at the cursor (the last one).
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(results.getByRole('tab', { name: /^1 · SELECT 3 AS three/ })).toBeVisible();
  await expect(page.locator('app-db-result-table')).toContainText('3');
  expect(await violations(page)).toEqual([]);

  // The whole script: one tab per query, after the first one.
  await page.locator('.cm-content[aria-label="SQL script"]').click();
  await page.keyboard.press('Alt+x');
  await expect(results.getByRole('tab', { name: /^4 · SELECT 3 AS three/ })).toBeVisible();
  await expect(
    results.getByRole('tab', { name: /^2 · SELECT id FROM shop.customers/ }),
  ).toBeVisible();

  // A selection runs alone.
  await page.locator('.cm-content[aria-label="SQL script"]').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(results.getByRole('tab', { name: /^5 · SELECT 3 AS three/ })).toBeVisible();

  // Pinned, it stays; «Run again» refreshes the same tab.
  await results.getByRole('tab', { name: /^2 · / }).click();
  await page.getByRole('button', { name: 'Pin', exact: true }).click();
  await page.getByRole('button', { name: 'Run again' }).click();
  await expect(results.getByRole('tab', { name: /Pinned 2 · SELECT id/ })).toBeVisible();
  await page.getByRole('button', { name: 'Close the unpinned' }).click();
  await expect(results.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: 'Detach' }).click();
  const floating = page.getByRole('dialog', { name: /^2 · / });
  await expect(floating).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await floating.getByRole('button', { name: 'Attach again' }).click();

  // A slow statement is cancelled; an error says its line.
  await write(page, 'SELECT pg_sleep(30)');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeDisabled();
  await write(page, 'SELECT 1,\n  2 FORM t');
  await page.keyboard.press('ControlOrMeta+Enter');
  await results.getByRole('tab', { name: /^Messages/ }).click();
  await expect(page.getByRole('button', { name: 'Go to line 2, column 10' })).toBeVisible();
  await expect(page.locator('.db-messages')).toContainText(/cancel/i);

  // The history lists what ran.
  await page
    .getByRole('toolbar', { name: 'SQL editor' })
    .getByRole('button', { name: 'History', exact: true })
    .click();
  const history = page.getByRole('complementary', { name: 'History' });
  await expect(history).toContainText('pg_sleep');
  expect(await violations(page)).toEqual([]);

  // The tab comes back with its text, without results.
  await write(page, 'SELECT 42 AS kept');
  await page.waitForTimeout(1200);
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Databases' })
    .click();
  await expect(page.locator('.cm-content[aria-label="SQL script"]')).toContainText(
    'SELECT 42 AS kept',
  );
  await expect(page.getByRole('tablist', { name: 'Results' }).getByRole('tab')).toHaveCount(1);

  // «View data» and «Open» from the navigator.
  const tree = page.getByRole('tree', { name: 'Connections' });
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('Enter');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  await open(tree.getByRole('treeitem', { name: /^Sales/ }));
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }).first());
  await open(tree.getByRole('treeitem', { name: 'Schemas', exact: true }));
  await open(tree.getByRole('treeitem', { name: 'shop', exact: true }).nth(1));
  await open(tree.getByRole('treeitem', { name: 'Tables', exact: true }));
  const orders = tree.getByRole('treeitem', { name: /^orders/ });
  await orders.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu').getByRole('menuitem', { name: 'View data' }).click();
  await expect(page.getByRole('tablist', { name: 'Results' })).toContainText(
    'SELECT * FROM shop.orders',
  );
  await orders.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu').getByRole('menuitem', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'orders' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Object views' })
    .getByRole('button', { name: 'Columns' })
    .click();
  await expect(page.locator('app-db-object-tab app-db-result-table')).toContainText('customer');
  expect(await violations(page)).toEqual([]);
});
