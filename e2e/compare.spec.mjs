// End-to-end test of comparing responses: the request of the tab sent with two environments,
// what changed field by field and side by side, and the differences left out.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('the same request with two environments shows what changed, and what is left out goes', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  for (const [name, stage] of [
    // Names of their own: the server is shared, and other tests look for «Staging».
    ['Compared staging', 'staging'],
    ['Compared production', 'production'],
  ]) {
    await page.getByRole('button', { name: 'Import' }).first().click();
    await page
      .getByLabel('Import content')
      .fill(JSON.stringify({ name, values: [{ key: 'stage', value: stage, enabled: true }] }));
    await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  }
  const sections = page.getByRole('navigation', { name: 'Workspace sections' });
  await sections.getByRole('button', { name: 'Collections' }).click();
  await page.getByLabel('Request URL').fill(`${nexo.echo}/{{stage}}/orders`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();

  // From the response: nothing was sent before it, so it is sent again.
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  const panel = page.locator('app-response-compare');
  await expect(panel.getByRole('heading', { name: 'Compare responses' })).toBeVisible();
  const first = panel.getByRole('group', { name: 'First response' });
  const second = panel.getByRole('group', { name: 'Second response' });
  await first.getByLabel('Environment').selectOption({ label: 'Compared staging' });
  await second.getByLabel('Take it from').selectOption('send');
  await second.getByLabel('Environment').selectOption({ label: 'Compared production' });
  await expect(first).toContainText('the request of the active tab');
  await panel.getByRole('button', { name: 'Compare', exact: true }).click();

  const result = panel.locator('.compare-result');
  await expect(result.getByRole('heading', { name: 'What changed' })).toBeVisible();
  const fields = result.getByRole('table', { name: 'Fields that differ' });
  await expect(fields.locator('tbody tr')).toHaveCount(1);
  await expect(fields.locator('tbody tr')).toContainText('$.path');
  await expect(fields.locator('tbody tr')).toContainText('/staging/orders');
  await expect(fields.locator('tbody tr')).toContainText('/production/orders');
  const diff = result.locator('app-diff-view');
  await expect(diff.locator('.cm-editor')).toHaveCount(2);
  await expect(diff).toContainText('Differences: 1');
  await diff.getByRole('button', { name: '↓ Next difference' }).click();
  await expect(diff).toContainText('Difference 1 of 1');
  expect(await violations(page)).toEqual([]);

  // Leaving out the path, the date and the length: the same responses are the same.
  await panel.getByLabel('Fields to leave out').fill('path');
  await panel.getByLabel('Headers to leave out').fill('Date, Content-Length');
  await panel.getByLabel('Headers to leave out').press('Enter');
  await expect(result.getByRole('heading', { name: 'The responses are the same' })).toBeVisible();
  await expect(result.locator('app-diff-view')).toHaveCount(0);

  // Both sends went to the history, as any request sent; Enter compared without sending.
  await page.getByRole('button', { name: 'Back to Collections' }).click();
  await sections.getByRole('button', { name: 'History' }).click();
  // The server is shared: earlier tests sent other requests.
  await expect(page.locator('.history-item', { hasText: '{{stage}}/orders' })).toHaveCount(3);
});
