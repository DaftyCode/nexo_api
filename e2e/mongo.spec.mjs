// End-to-end tests of MongoDB connections, queries, writes and indexes.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('MongoDB: a pasted URI keeps its password in the vault, and a test explains failures', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'MongoDB' })
    .click();
  const editor = page.getByRole('region', { name: 'Connection', exact: true });
  await editor
    .getByLabel('Paste a connection string')
    .fill('mongodb://ana:s3cret@127.0.0.1:9/?authSource=admin&serverSelectionTimeoutMS=500');
  await editor.getByRole('button', { name: 'Use URI' }).click();
  await expect(editor.getByText('The password left the URI')).toBeVisible();
  const uri = editor.getByTestId('mongo-uri');
  await expect(uri).toHaveText(
    'mongodb://ana@127.0.0.1:9/?authSource=admin&serverSelectionTimeoutMS=500',
  );
  await editor.getByLabel('Connection name').fill('Local test');
  await editor.getByLabel('Folder').fill('Local');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  const list = page.getByRole('navigation', { name: 'Connections' });
  await expect(list.getByRole('button', { name: 'Local test' })).toBeVisible();
  await expect(list).toContainText('Local');

  // Nothing listens on port 9: the test says so, with the password never shown.
  await editor.getByRole('button', { name: 'Test connection' }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'No server answered' });
  await expect(alert).toBeVisible({ timeout: 15000 });
  await expect(alert).not.toContainText('s3cret');

  // Fields write the URI; a DNS seed list has no port.
  await editor.getByRole('button', { name: 'Options' }).click();
  await editor.getByLabel('Write concern (w)').fill('majority');
  await expect(uri).toContainText('&w=majority');
  await editor.getByRole('button', { name: 'Server', exact: true }).click();
  await editor.getByLabel('DNS seed list').check();
  await expect(editor.getByRole('note')).toContainText('has no port');
  await expect(editor.getByRole('button', { name: 'Test connection' })).toBeDisabled();
  expect(await violations(page)).toEqual([]);

  page.once('dialog', (confirm) => confirm.accept());
  await editor.getByRole('button', { name: 'Delete connection' }).click();
  await expect(list).toContainText('No connections yet.');
});

test('MongoDB: browse 100 000 documents, filter an embedded field, sort, page, count and cancel', async ({
  page,
  nexo,
}) => {
  // The data of tools/mongo-fixture.sh (CI starts it before the E2E tests).
  test.skip(!process.env.NEXO_MONGO_PLAIN, 'Needs the MongoDB servers of tools/mongo-fixture.sh');
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'MongoDB' })
    .click();
  const editor = page.getByRole('region', { name: 'Connection', exact: true });
  await editor.getByLabel('Paste a connection string').fill(process.env.NEXO_MONGO_PLAIN);
  await editor.getByRole('button', { name: 'Use URI' }).click();
  await editor.getByLabel('Connection name').fill('Fixture');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await editor.getByRole('button', { name: 'Browse data' }).click();

  const tree = page.getByRole('navigation', { name: 'Databases' });
  await tree.getByRole('button', { name: /^nexo / }).click();
  await expect(tree.getByRole('button', { name: /^madrid View/ })).toBeVisible();
  await expect(tree.getByRole('button', { name: /^metrics Time series/ })).toBeVisible();
  await expect(tree.getByRole('button', { name: /^fs\.files GridFS/ })).toBeVisible();
  await tree.getByRole('button', { name: /^big$/ }).click();
  const query = page.getByRole('region', { name: 'Query', exact: true });
  const range = query.getByTestId('mongo-range');
  await expect(range).toContainText('Documents 1 to 50');
  await expect(query.getByRole('definition').first()).toHaveText('100000');

  await query
    .locator('.cm-content[aria-label="Filter"]')
    .fill("{'customer.address.city': 'Madrid'}");
  await query.getByLabel('Sort').fill('{n: -1}');
  await query.getByRole('button', { name: 'Find', exact: true }).click();
  const results = query.getByRole('group', { name: 'Results' });
  await expect(results.locator('tbody tr').first()).toContainText('99999');
  await query.getByRole('button', { name: 'Next page' }).click();
  await expect(range).toContainText('Documents 51 to 100');
  await expect(results.locator('tbody tr').first()).toContainText('99899');
  await query.getByRole('button', { name: 'Previous page' }).click();
  await expect(range).toContainText('Documents 1 to 50');
  await query.getByRole('button', { name: 'Count documents' }).click();
  await expect(range).toContainText('of 50000');

  // An embedded document opens into columns; an array is entered as its own table.
  await results.getByRole('button', { name: '{ 2 fields }' }).first().click();
  await expect(results.getByRole('columnheader', { name: 'customer.name' })).toBeVisible();
  await results.getByRole('button', { name: '[ 2 elements ]' }).first().click();
  await expect(query.getByRole('navigation', { name: 'Arrays entered' })).toContainText('items');
  await expect(results.getByRole('columnheader', { name: 'sku' })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // A query the server takes long to answer (server-side JavaScript sleeps on each
  // document) is cancelled there; the interface never waits for it.
  await query.locator('.cm-content[aria-label="Filter"]').fill("{$where: 'sleep(100) || true'}");
  await query.getByRole('button', { name: 'Find', exact: true }).click();
  await query.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'The query was cancelled' })).toBeVisible({
    timeout: 5000,
  });
  await expect(query.getByRole('button', { name: 'Find', exact: true })).toBeEnabled();
});

test('MongoDB: a database is created, written, edited keeping types, undone and dropped', async ({
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
  await editor.getByLabel('Connection name').fill('Writer');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await editor.getByRole('button', { name: 'Browse data' }).click();

  const tree = page.getByRole('navigation', { name: 'Databases' });
  const dialog = page.getByRole('dialog');
  const name = `e2e_${Date.now()}`;
  await tree.getByRole('button', { name: '＋ New database' }).click();
  await dialog.getByLabel('Database name').fill(name);
  await dialog.getByLabel('Collection name').fill('items');
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Create' }).click();
  const query = page.getByRole('region', { name: 'Query', exact: true });
  await expect(query.getByRole('heading', { name: `${name}.items` })).toBeVisible();

  await query.getByRole('button', { name: 'Insert documents' }).click();
  await dialog
    .locator('.cm-content[aria-label="Documents"]')
    .fill(
      "[{_id: 1, at: ISODate('2024-01-02T03:04:05Z'), price: NumberDecimal('1.10')}, {_id: 2}, {_id: 3}]",
    );
  await dialog.getByRole('button', { name: 'Insert' }).click();
  const results = query.getByRole('group', { name: 'Results' });
  await expect(results.locator('tbody tr')).toHaveCount(3);

  // A date edited in the table stays a date.
  await results.getByRole('button', { name: '2024-01-02T03:04:05.000Z' }).click();
  await query.getByRole('button', { name: 'Edit value' }).click();
  await dialog.locator('.cm-content[aria-label="Value"]').fill("ISODate('2025-05-05T00:00:00Z')");
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(results.getByRole('button', { name: '2025-05-05T00:00:00.000Z' })).toBeVisible();
  await query.getByRole('button', { name: 'JSON', exact: true }).click();
  await query.getByLabel('Format').selectOption('canonical');
  await expect(query.locator('.cm-content[aria-label="Results"]')).toContainText('"$date"');
  await expect(query.locator('.cm-content[aria-label="Results"]')).toContainText(
    '"$numberDecimal": "1.10"',
  );
  await query.getByRole('button', { name: 'Table', exact: true }).click();

  // Many documents: counted first, then written.
  await query.getByRole('button', { name: 'Update many…' }).click();
  await expect(dialog).toContainText('3 documents match the filter');
  await dialog.locator('.cm-content[aria-label="Update"]').fill('{$set: {flag: true}}');
  await dialog.getByRole('button', { name: 'Update documents' }).click();
  await expect(results.locator('thead')).toContainText('flag');

  // A write to many documents is listed but cannot be undone; the edit of one can.
  const undo = tree.getByRole('button', { name: /^Undo mongo\.update/ });
  await expect(undo).toHaveCount(1);
  await undo.click();
  await dialog.getByRole('button', { name: 'Undo' }).click();
  // The document changed after the edit (the flag), so it is not put back.
  await expect(dialog).toContainText('A document changed after this change');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await query.getByText('Collection', { exact: true }).click();
  await query.getByRole('button', { name: 'Drop database' }).click();
  await expect(dialog.getByRole('button', { name: 'Drop database' })).toBeDisabled();
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Drop database' }).click();
  await expect(query).toContainText('Choose a collection to query it.');
  await expect(tree.getByRole('button', { name: new RegExp(`^${name} \\d`) })).toHaveCount(0);
});

test('MongoDB: a query scans the collection until an index created in Nexo serves it', async ({
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
  await editor.getByLabel('Connection name').fill('Tuner');
  await editor.getByRole('button', { name: 'Save connection' }).click();
  await editor.getByRole('button', { name: 'Browse data' }).click();

  const tree = page.getByRole('navigation', { name: 'Databases' });
  const dialog = page.getByRole('dialog');
  const name = `e2e_tuning_${Date.now()}`;
  await tree.getByRole('button', { name: '＋ New database' }).click();
  await dialog.getByLabel('Database name').fill(name);
  await dialog.getByLabel('Collection name').fill('orders');
  await dialog.getByRole('button', { name: 'Create' }).click();
  const query = page.getByRole('region', { name: 'Query', exact: true });
  await query.getByRole('button', { name: 'Insert documents' }).click();
  await dialog
    .locator('.cm-content[aria-label="Documents"]')
    .fill(JSON.stringify(Array.from({ length: 60 }, (_, n) => ({ n, status: n % 3 ? 'B' : 'A' }))));
  await dialog.getByRole('button', { name: 'Insert' }).click();
  await expect(query.getByRole('status').filter({ hasText: 'Documents 1 to 50' })).toBeVisible();

  // Without an index, the explain shows the whole collection read.
  await query.locator('.cm-content[aria-label="Filter"]').fill("{status: 'A'}");
  await query
    .locator('.mongo-actions')
    .getByRole('button', { name: 'Explain', exact: true })
    .click();
  const plan = query.getByRole('region', { name: 'Explain plan' });
  await expect(plan).toContainText('Collection scan: no index is used');
  await expect(plan.locator('.explain-stage strong').first()).toHaveText('COLLSCAN');
  expect(await violations(page)).toEqual([]);

  // An index created from Nexo, listed with its kind.
  const views = query.getByRole('navigation', { name: 'Collection views' });
  await views.getByRole('button', { name: 'Indexes', exact: true }).click();
  await query.getByRole('button', { name: 'New index' }).click();
  await query.locator('.cm-content[aria-label="Keys"]').fill('{ status: 1, n: -1 }');
  expect(await violations(page)).toEqual([]);
  await query.getByRole('button', { name: 'Create index' }).click();
  await expect(page.locator('.toast')).toContainText('Index created');
  await expect(query.getByRole('region', { name: 'Indexes' })).toContainText('status_1_n_-1');
  await expect(query.getByRole('region', { name: 'Indexes' })).toContainText('Compound');

  // The same query now reads the index.
  await views.getByRole('button', { name: 'Explain', exact: true }).click();
  await query.getByRole('button', { name: 'Run and measure' }).click();
  await expect(plan.locator('.explain-stage strong').first()).toHaveText('IXSCAN');
  await expect(plan).toContainText('Uses the index status_1_n_-1');
  await plan.getByRole('button', { name: 'JSON', exact: true }).click();
  await expect(plan.locator('.explain-json')).toContainText('"winningPlan"');

  // The profiler of the database is read; changing it is for the person to decide.
  await views.getByRole('button', { name: 'Profiler', exact: true }).click();
  await expect(query.getByRole('region', { name: 'Profiler' })).toContainText(
    `Profiler of ${name}: Off`,
  );
  expect(await violations(page)).toEqual([]);

  await views.getByRole('button', { name: 'Documents', exact: true }).click();
  await query.getByText('Collection', { exact: true }).click();
  await query.getByRole('button', { name: 'Drop database' }).click();
  await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
  await dialog.getByRole('button', { name: 'Drop database' }).click();
  await expect(query).toContainText('Choose a collection to query it.');
});
