// End-to-end tests of API definitions, the collection tree and responses.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('API definitions are linted, explored and compared with their saved version', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByRole('button', { name: 'apis', exact: true }).click();
  const definitions = page.getByRole('region', { name: 'API definitions' });
  const editor = definitions.getByLabel('OpenAPI definition');
  await definitions.getByLabel('Name', { exact: true }).fill('Orders API');
  await editor.fill(
    [
      'openapi: 3.0.3',
      'info:',
      '  title: Orders',
      'paths:',
      '  /orders/{id}:',
      '    get:',
      '      summary: One order',
      '      responses:',
      "        '200':",
      '          description: The order',
      '    delete:',
      '      summary: Delete an order',
      '      responses:',
      "        '204':",
      '          description: Deleted',
      '',
    ].join('\n'),
  );
  await definitions.getByRole('button', { name: 'Save definition' }).click();
  await expect(definitions).toContainText('info.version is missing');
  await expect(definitions).toContainText(
    'GET /orders/{id}: the path variable id is not declared as a parameter',
  );
  await definitions.getByRole('button', { name: 'Line 2', exact: true }).click();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('info:');
  // The findings are marked on their lines in the editor too.
  await expect(definitions.locator('.cm-lintRange-error').first()).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await definitions.getByRole('button', { name: 'Explorer' }).click();
  await expect(definitions).toContainText('/orders/{id}');
  await expect(definitions).toContainText('Delete an order');

  // The delete is removed in the editor: a breaking change against the saved version.
  const text = await editor.evaluate((area) => area.innerText);
  await editor.fill(text.slice(0, text.indexOf('    delete:')));
  await definitions.getByRole('button', { name: 'Changes' }).click();
  await definitions.getByRole('button', { name: 'Compare' }).click();
  await expect(definitions).toContainText('1 breaking changes');
  await expect(definitions).toContainText('Endpoint removed');
  await expect(definitions).toContainText('/orders/{id}');
});

test('items are moved in the collection tree by dragging them', async ({ page, nexo }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nexo.signIn(page);
  const request = (name) => ({ name, request: { method: 'GET', url: `${nexo.echo}/${name}` } });
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.getByLabel('Import content').fill(
    JSON.stringify({
      info: { name: 'Draggable' },
      item: [
        request('alpha'),
        { name: 'Orders', item: [request('beta'), request('gamma')] },
        { name: 'Archive', item: [] },
      ],
    }),
  );
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  const collection = page.locator('.collection', { hasText: 'Draggable' });
  const row = (name) =>
    collection.locator('.tree-row').filter({
      has: page.locator('.request-leaf, .folder-name').getByText(name, { exact: true }),
    });
  const order = () =>
    collection
      .locator('.tree-row')
      .evaluateAll((rows) =>
        rows.map(
          (r) =>
            `${r.style.paddingLeft}:${r.querySelector('.request-leaf span:last-child, .folder-name span')?.textContent?.trim()}`,
        ),
      );
  const status = page.locator('.statusbar [role="status"]');
  await expect(row('alpha')).toBeVisible();

  // A request into a folder: dropped on the folder's middle.
  await row('alpha').dragTo(row('Archive'), { targetPosition: { x: 60, y: 15 } });
  await expect(status).toHaveText('Item moved');
  await expect
    .poll(order)
    .toEqual(['14px:Orders', '36px:beta', '36px:gamma', '14px:Archive', '36px:alpha']);

  // Reordered inside a folder: gamma before beta, dropped on beta's top edge.
  await row('gamma').dragTo(row('beta'), { targetPosition: { x: 60, y: 2 } });
  await expect
    .poll(order)
    .toEqual(['14px:Orders', '36px:gamma', '36px:beta', '14px:Archive', '36px:alpha']);

  // A whole folder after another one, dropped on its bottom edge.
  await row('Orders').dragTo(row('alpha'), { targetPosition: { x: 60, y: 29 } });
  await expect
    .poll(order)
    .toEqual(['14px:Archive', '36px:alpha', '36px:Orders', '58px:gamma', '58px:beta']);

  // A folder into itself does nothing, and says why.
  await row('Archive').dragTo(row('Orders'), { targetPosition: { x: 60, y: 15 } });
  await expect(status).toHaveText('A folder cannot be moved into itself');
  await expect
    .poll(order)
    .toEqual(['14px:Archive', '36px:alpha', '36px:Orders', '58px:gamma', '58px:beta']);
});

test('each request tab shows its own response', async ({ page, nexo }) => {
  await nexo.signIn(page);
  const url = page.getByLabel('Request URL');
  const send = page.getByRole('button', { name: 'Send' }).first();
  const response = page.locator('.response-code');
  const tabs = page.locator('.request-tab');

  await url.fill(`${nexo.echo}/first`);
  await send.click();
  await expect(response).toContainText('/first');
  await page.getByRole('button', { name: 'New request tab' }).click();
  // A new tab has no response yet.
  await expect(response).toHaveCount(0);
  await url.fill(`${nexo.echo}/second`);
  await send.click();
  await expect(response).toContainText('/second');

  // Switching tabs shows the response of the tab chosen.
  await tabs.nth(0).locator('button').first().click();
  await expect(url).toHaveValue(`${nexo.echo}/first`);
  await expect(response).toContainText('/first');
  await tabs.nth(1).locator('button').first().click();
  await expect(response).toContainText('/second');
  // Closing a tab (its unsaved changes discarded) shows the response of the one left.
  page.once('dialog', (confirm) => confirm.accept());
  await tabs.nth(1).getByRole('button', { name: 'Close request' }).click();
  await expect(response).toContainText('/first');
});

test('a long response scrolls to its end, with its actions in sight', async ({ page, nexo }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await nexo.signIn(page);
  await page.getByLabel('Request URL').fill(`${nexo.echo}/long`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  const area = page.locator('.response-content');
  await expect(page.locator('.response-code')).toContainText('"item": 0');
  const sizes = await area.evaluate((element) => ({
    scroll: element.scrollHeight,
    client: element.clientHeight,
  }));
  expect(sizes.scroll).toBeGreaterThan(sizes.client * 3);
  // The last item can be reached, and Pretty / Raw stay at the top while scrolling.
  await area.evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(page.getByText('"item": 499')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Raw' })).toBeInViewport();
  // Also by keyboard: the body takes the focus and scrolls.
  await area.evaluate((element) => element.scrollTo(0, 0));
  await page.locator('.response-code').focus();
  await page.keyboard.press('End');
  await expect(page.getByText('"item": 499')).toBeInViewport();
});
