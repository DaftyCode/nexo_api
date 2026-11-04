import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixture.mjs';

/** Serious and critical axe violations, reduced to rule and target for readable failures. */
async function violations(page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('pages have no serious accessibility violations', async ({ page, nexo }) => {
  for (const path of ['/', '/docs']) {
    await page.goto(nexo.base + path);
    await page.waitForLoadState('networkidle');
    expect(await violations(page), path).toEqual([]);
  }
  await nexo.signIn(page);
  await expect(page.getByRole('button', { name: 'Send' }).first()).toBeVisible();
  expect(await violations(page), '/workspace').toEqual([]);
});

test('a request is created, renamed, moved into a folder and sent', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('E2E API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'E2E API' });
  await expect(collection).toBeVisible();

  await collection.getByLabel('Collection actions').click();
  await collection.getByRole('button', { name: 'Add folder' }).click();
  await page.getByPlaceholder('Give it a name').fill('Users');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(collection.locator('.tree-row', { hasText: 'Users' })).toBeVisible();

  await collection.getByLabel('Collection actions').click();
  await collection.getByRole('button', { name: 'Add request', exact: true }).click();
  await page.getByLabel('Request URL').fill(`${nexo.echo}/users`);
  await page.getByRole('button', { name: /Save/ }).first().click();

  const row = collection.locator('.tree-row', { hasText: 'New request' });
  await row.getByLabel('Item actions').click();
  await row.getByRole('button', { name: 'Rename' }).click();
  await page.getByPlaceholder('Give it a name').fill('List users');
  await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
  const renamed = collection.locator('.tree-row', { hasText: 'List users' });
  await expect(renamed).toBeVisible();

  await renamed.getByLabel('Item actions').click();
  await renamed.getByLabel('Move to').selectOption({ label: 'Users' });
  // Inside the folder the request is indented one level deeper.
  await expect(collection.locator('.tree-row', { hasText: 'List users' })).toHaveAttribute(
    'style',
    /padding-left: 28px/,
  );

  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
});

test('Ctrl+Enter in a script editor does not send the request', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.keyboard.press('Control+t');
  await page.getByLabel('Request URL').fill(`${nexo.echo}/never`);
  await page
    .getByRole('button', { name: /Scripts/ })
    .first()
    .click();
  const editor = page.getByLabel('Test scripts');
  await editor.click();
  await editor.press('Control+Enter');
  await expect(page.getByRole('status').filter({ hasText: '200' })).toHaveCount(0);
  await page.keyboard.press('F1');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});
