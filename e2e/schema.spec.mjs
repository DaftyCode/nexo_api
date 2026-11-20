// End-to-end test of JSON Schema from responses: read from a response and the history of its
// request, added as a test, and checked when the request is sent again.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('a schema read from the responses of a request becomes a passing test', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  const sections = page.getByRole('navigation', { name: 'Workspace sections' });
  await sections.getByRole('button', { name: 'Collections' }).click();
  await page.getByLabel('Request URL').fill(`${nexo.echo}/schema`);
  const send = page.getByRole('button', { name: 'Send' }).first();
  const status = page.getByRole('status').filter({ hasText: '200' });
  await send.click();
  await expect(status).toBeVisible();
  await send.click();
  await expect(status).toBeVisible();

  await page.getByRole('button', { name: 'JSON Schema…' }).click();
  await page.getByRole('button', { name: 'Infer schema' }).click();
  const panel = page.getByRole('region', { name: 'JSON Schema' });
  await expect(panel).toContainText('Read from 2 responses');
  await expect(panel.getByLabel('JSON Schema')).toContainText('"required": [');
  expect(await violations(page)).toEqual([]);
  await panel.getByRole('button', { name: 'Add schema test' }).click();
  await expect(page.locator('.statusbar [role="status"]')).toHaveText('Schema test added');

  await send.click();
  await expect(status).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Response sections' })
    .getByRole('button', { name: /Test results/ })
    .click();
  await expect(
    page.locator('.assertion', { hasText: 'The response matches its JSON Schema' }),
  ).toContainText('PASS');
});
