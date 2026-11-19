// End-to-end tests of protected environments: a colour on the workspace bar and the tabs, a
// dialog once per send of what may change data, and a read-only environment the engine keeps.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('a protected environment asks before changes and, read-only, never sends them', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  const sections = page.getByRole('navigation', { name: 'Workspace sections' });
  await sections.getByRole('button', { name: 'Environments' }).click();
  await page.getByLabel('Environment name').fill('Staging');
  await page.getByRole('button', { name: 'Color 1' }).click();
  await page.getByLabel('Protection').selectOption('confirm');
  await page.getByRole('button', { name: 'Save environment' }).click();
  await expect(page.locator('.environment-status')).toContainText('This environment is active.');
  await expect(page.locator('.workspace-bar.environment-marked')).toBeVisible();
  await expect(page.locator('.environment-badge')).toContainText('Asks first');
  expect(await violations(page)).toEqual([]);

  await sections.getByRole('button', { name: 'Collections' }).click();
  await expect(page.locator('.request-tabbar.environment-marked')).toBeVisible();
  await page.getByLabel('HTTP method').selectOption('DELETE');
  await page.getByLabel('Request URL').fill(`${nexo.echo}/orders/1`);
  const send = page.getByRole('button', { name: 'Send' }).first();
  const dialogs = [];
  let answer = 'dismiss';
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void (answer === 'accept' ? dialog.accept() : dialog.dismiss());
  });
  await send.click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(dialogs[0]).toContain('Send DELETE');
  expect(dialogs[0]).toContain('«Staging»');
  await expect(page.getByRole('status').filter({ hasText: '200' })).toHaveCount(0);
  answer = 'accept';
  await send.click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  expect(dialogs).toHaveLength(2);

  // Read-only: no dialog, and the engine refuses it.
  await sections.getByRole('button', { name: 'Environments' }).click();
  await page
    .getByRole('button', { name: /Staging/ })
    .first()
    .click();
  await page.getByLabel('Protection').selectOption('readonly');
  await page.getByRole('button', { name: 'Save environment' }).click();
  await expect(page.locator('.environment-badge')).toContainText('Read-only');
  await sections.getByRole('button', { name: 'Collections' }).click();
  await send.click();
  await expect(page.locator('.alert.error')).toContainText(
    'The environment «Staging» is read-only: DELETE requests are not sent',
  );
  expect(dialogs).toHaveLength(2);
});
