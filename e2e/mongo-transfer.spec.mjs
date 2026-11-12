// End-to-end test of MongoDB exports and imports in the browser: a query exported to a file
// the browser downloads, and that file imported into a new collection.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('MongoDB: a query exported to JSON Lines and imported again keeps its documents', async ({
  page,
  nexo,
}, testInfo) => {
  test.skip(!process.env.NEXO_MONGO_PLAIN, 'Needs the MongoDB servers of tools/mongo-fixture.sh');
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'MongoDB' })
    .click();
  const editor = page.getByRole('region', { name: 'Connection', exact: true });
  await editor.getByLabel('Paste a connection string').fill(process.env.NEXO_MONGO_PLAIN);
  await editor.getByRole('button', { name: 'Use URI' }).click();
  await editor.getByLabel('Connection name').fill('Transfers');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await editor.getByRole('button', { name: 'Browse data' }).click();

  const tree = page.getByRole('navigation', { name: 'Databases' });
  const query = page.getByRole('region', { name: 'Query', exact: true });
  const dialog = page.getByRole('dialog');
  await tree.getByRole('button', { name: /^nexo / }).click();
  await tree.getByRole('button', { name: /^big$/ }).click();
  await query.locator('.cm-content[aria-label="Filter"]').fill('{n: {$lt: 2500}}');

  await query.getByRole('button', { name: 'Export…' }).click();
  await expect(dialog).toContainText('filter: {n: {$lt: 2500}}');
  await dialog.getByLabel('Format').selectOption('jsonl');
  expect(await violations(page)).toEqual([]);
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^big-\d{4}-\d\d-\d\d\.jsonl$/);
  const file = testInfo.outputPath('big.jsonl');
  await download.saveAs(file);
  await expect(dialog).toContainText(/Read\s*2500/);
  await dialog.getByRole('button', { name: 'Close' }).click();

  const name = `e2e_transfer_${Date.now()}`;
  await tree.getByRole('button', { name: '＋ New database' }).click();
  await dialog.getByLabel('Database name').fill(name);
  await dialog.getByLabel('Collection name').fill('copy');
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(query.getByRole('heading', { name: `${name}.copy` })).toBeVisible();

  await query.getByRole('button', { name: 'Import…' }).click();
  const choosing = page.waitForEvent('filechooser');
  await dialog.getByRole('button', { name: 'Choose a file' }).click();
  await (await choosing).setFiles(file);
  await expect(dialog.getByTestId('transfer-file')).toContainText('big.jsonl');
  await expect(dialog.getByLabel('Format')).toHaveValue('jsonl');
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(dialog).toContainText(/Inserted\s*2500/);
  await expect(dialog).toContainText(/Failed\s*0/);
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(query.getByRole('definition').first()).toHaveText('2500');

  await query.getByText('Collection', { exact: true }).click();
  await query.getByRole('button', { name: 'Drop database' }).click();
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
  await dialog.getByRole('button', { name: 'Drop database' }).click();
  await expect(query).toContainText('Choose a collection to query it.');
});
