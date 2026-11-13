// End-to-end test of Settings → Modules: the database modules are downloaded after asking,
// with what they are, how much they weigh, where they come from and their licenses, and
// removed. The module is the test driver, served by the fixture as the releases would.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('a database module is downloaded after asking, installed and removed', async ({
  page,
  nexo,
}) => {
  test.skip(!nexo.modules, 'Build the test driver: cargo build -p nexo-driver-test');
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByRole('button', { name: 'modules', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Database modules' });
  await expect(settings.getByText('Test database')).toBeVisible();
  await expect(settings.getByText('Not installed')).toBeVisible();
  expect(await violations(page)).toEqual([]);

  // Nothing is downloaded until the person says so.
  await settings.getByRole('button', { name: 'Install Test database' }).click();
  const dialog = page.getByRole('dialog', { name: 'Download the Test database module' });
  await expect(dialog).toContainText('MIT OR Apache-2.0');
  await expect(dialog).toContainText(/127\.0\.0\.1:\d+, version/);
  await expect(dialog.getByRole('button', { name: 'Download' })).toBeFocused();
  expect(await violations(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();

  await settings.getByRole('button', { name: 'Install Test database' }).click();
  await dialog.getByRole('button', { name: 'Download' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'Module installed' })).toBeVisible();
  await expect(settings.getByText('Installed', { exact: true })).toBeVisible();

  page.once('dialog', (question) => question.accept());
  await settings.getByRole('button', { name: 'Remove Test database' }).click();
  await expect(settings.getByText('Not installed')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
