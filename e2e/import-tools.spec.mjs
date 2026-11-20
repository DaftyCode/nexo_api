// End-to-end tests of the imports from other API clients: a Bruno collection folder chosen
// in the dialog, and an Insomnia 11 collection pasted and sent with its environment.
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

const bruno = fileURLToPath(
  new URL('../backend/crates/nexo-engine/src/interchange/tools/fixtures/bruno', import.meta.url),
);

test('a Bruno collection folder is imported with its report', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.locator('input[webkitdirectory]').setInputFiles(bruno);
  const dialog = page.getByRole('dialog', { name: 'Import report' });
  await expect(dialog).toContainText(
    'Imported from Bruno. Requests: 5, folders: 1, environments: 1.',
  );
  await expect(dialog).toContainText('Files to choose again: Upload photo');
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'Pet Store' });
  await expect(collection).toBeVisible();
  await expect(collection.getByText('People', { exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Environment' })).toContainText('Local');
});

test('an Insomnia collection is pasted and its requests are sent', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page
    .getByLabel('Import content')
    .fill(
      [
        'type: collection.insomnia.rest/5.0',
        'name: Insomnia E2E',
        'collection:',
        '  - url: "{{ _.baseUrl }}/insomnia"',
        '    name: Pasted from Insomnia',
        '    meta: {id: req_e2e}',
        '    method: GET',
        'environments:',
        '  name: Base Environment',
        `  data: {baseUrl: "${nexo.echo}"}`,
      ].join('\n'),
    );
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  const dialog = page.getByRole('dialog', { name: 'Import report' });
  await expect(dialog).toContainText('Everything came as it was.');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page
    .locator('.collection', { hasText: 'Insomnia E2E' })
    .getByText('Pasted from Insomnia', { exact: true })
    .click();
  await expect(page.getByLabel('Request URL')).toHaveValue('{{baseUrl}}/insomnia');
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
});
