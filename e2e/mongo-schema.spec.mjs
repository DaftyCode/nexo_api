// End-to-end test of the Schema tab: a sample of 100 000 documents analysed, a frequent value
// opened in the Documents tab, and field names suggested in the filter.
import { expect, test } from './fixture.mjs';
import { deleteMongoConnection, violations } from './helpers.mjs';

test('MongoDB: the schema of a sample shows each field, and a value opens its documents', async ({
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
  await editor.getByLabel('Connection name').fill('Schemas');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await editor.getByRole('button', { name: 'Browse data' }).click();

  const tree = page.getByRole('navigation', { name: 'Databases' });
  const query = page.getByRole('region', { name: 'Query', exact: true });
  await tree.getByRole('button', { name: /^nexo / }).click();
  await tree.getByRole('button', { name: /^big$/ }).click();
  await query.getByRole('button', { name: 'Schema', exact: true }).click();
  await query.getByRole('button', { name: 'Analyze' }).click();
  await expect(query.getByTestId('schema-sampled')).toContainText('1000 documents sampled');

  const fields = query.getByRole('region', { name: 'Fields' });
  const city = fields.getByRole('row').filter({ has: page.getByRole('button', { name: 'city' }) });
  await expect(city).toContainText('100%');
  await expect(city).toContainText('String 100%');
  await expect(query).not.toContainText('Anomalies');
  expect(await violations(page)).toEqual([]);

  await city.getByRole('button', { name: 'city' }).click();
  await query.getByRole('button', { name: 'Find the documents with "Madrid"' }).click();
  await expect(query.locator('.cm-content[aria-label="Filter"]')).toHaveText(
    '{ "customer.address.city": "Madrid" }',
  );
  await expect(query.getByTestId('mongo-range')).toContainText('1');

  // The fields of the schema are suggested while the filter is typed.
  const filter = query.locator('.cm-content[aria-label="Filter"]');
  await filter.fill('{ customer.add');
  await page.keyboard.press('Control+Space');
  await expect(page.getByRole('option', { name: 'customer.address.zip' })).toBeVisible();
  await page.keyboard.press('Escape');

  await deleteMongoConnection(page, 'Schemas');
});
