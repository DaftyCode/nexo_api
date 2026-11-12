// End-to-end test of the query tools of the MongoDB explorer: a SELECT translated by the
// engine and run against the seeded server, its filter shown as blocks, and its driver code.
import { expect, test } from './fixture.mjs';
import { deleteMongoConnection, violations } from './helpers.mjs';

test('MongoDB: SQL becomes a query that runs, shows as blocks and as code', async ({
  page,
  nexo,
}) => {
  test.skip(!process.env.NEXO_MONGO_PLAIN, 'Needs the MongoDB servers of tools/mongo-fixture.sh');
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'MongoDB' })
    .click();
  const editor = page.getByRole('region', { name: 'Connection', exact: true });
  await editor.getByLabel('Paste a connection string').fill(process.env.NEXO_MONGO_PLAIN);
  await editor.getByRole('button', { name: 'Use URI' }).click();
  await editor.getByLabel('Connection name').fill('SQL');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await editor.getByRole('button', { name: 'Browse data' }).click();

  const tree = page.getByRole('navigation', { name: 'Databases' });
  await tree.getByRole('button', { name: /^nexo / }).click();
  await tree.getByRole('button', { name: /^big$/ }).click();
  const query = page.getByRole('region', { name: 'Query', exact: true });
  await query
    .getByRole('navigation', { name: 'Collection views' })
    .getByRole('button', { name: 'SQL', exact: true })
    .click();
  await query
    .locator('.cm-content[aria-label="SQL"]')
    .fill("SELECT n FROM big WHERE customer.address.city = 'Madrid' ORDER BY n DESC LIMIT 3");
  await query.getByRole('button', { name: 'Translate', exact: true }).click();
  await expect(query.locator('.cm-content[aria-label="MongoDB query"]')).toContainText('Madrid');
  expect(await violations(page)).toEqual([]);
  await query.getByRole('button', { name: 'Run in Documents' }).click();
  const results = query.getByRole('group', { name: 'Results' });
  await expect(results.locator('tbody tr')).toHaveCount(3);
  await expect(results.locator('tbody tr').first()).toContainText('99999');

  // The filter of the SELECT, as blocks.
  await query.getByRole('button', { name: 'Blocks', exact: true }).click();
  await expect(query.getByLabel('Field', { exact: true }).first()).toHaveValue(
    'customer.address.city',
  );
  expect(await violations(page)).toEqual([]);

  // Its driver code reads the connection from the environment.
  await query.getByRole('button', { name: 'Code', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Code' });
  await expect(dialog.locator('.cm-content[aria-label="Code"]')).toContainText(
    'getCollection("big")',
  );
  await dialog.getByLabel('Language').selectOption('python');
  await expect(dialog.locator('.cm-content[aria-label="Code"]')).toContainText('MONGODB_URI');
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await deleteMongoConnection(page, 'SQL');
});
