// End-to-end tests of requests, collections and the layout of the workspace.
import { expect, test } from './fixture.mjs';
import { violations, addRequest } from './helpers.mjs';

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
  await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
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
    /padding-left: 36px/,
  );
  // Folders open and close like their collection.
  const users = collection.getByRole('button', { name: 'Users', exact: true }).first();
  await expect(users).toHaveAttribute('aria-expanded', 'true');
  await users.click();
  await expect(collection.locator('.tree-row', { hasText: 'List users' })).toBeHidden();
  await users.click();
  await expect(collection.locator('.tree-row', { hasText: 'List users' })).toBeVisible();

  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
});

test('a Postman export opens with its body and path variables, and sends them', async ({
  page,
  nexo,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nexo.signIn(page);
  const request = (name, method, body, url) => ({
    name,
    request: { method, header: [], body, url },
  });
  const exported = {
    info: {
      name: 'Exported claims',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      request(
        'cache',
        'GET',
        { mode: 'urlencoded', urlencoded: [] },
        {
          raw: `${nexo.echo}/contexto/:clave`,
          variable: [{ key: 'clave', value: 'k1' }],
        },
      ),
      request(
        'cache',
        'POST',
        { mode: 'raw', raw: '{"channel":"web"}', options: { raw: { language: 'json' } } },
        { raw: `${nexo.echo}/contexto` },
      ),
    ],
  };
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.getByLabel('Import content').fill(JSON.stringify(exported));
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  const collection = page.locator('.collection', { hasText: 'Exported claims' });
  const configuration = page.getByRole('navigation', { name: 'Request configuration' });

  // The POST "cache" shows the body it sends.
  await collection.locator('.tree-row', { hasText: 'POST' }).click();
  await configuration.getByRole('button', { name: 'Body' }).click();
  await expect(page.getByLabel('Request body')).toHaveText('{"channel":"web"}');

  // The GET "cache" shows its path variable, which is edited and sent. A request panel made
  // small grows to show it.
  await configuration.getByRole('button', { name: 'Params' }).click();
  const divider = page.getByRole('separator', { name: 'Resize the request and the response' });
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 400, { steps: 4 });
  await page.mouse.up();
  await collection.locator('.tree-row', { hasText: 'GET' }).click();
  await expect
    .poll(() => page.locator('.request-content').evaluate((e) => e.scrollHeight - e.clientHeight))
    .toBeLessThanOrEqual(1);
  const clave = page.getByRole('textbox', { name: 'clave', exact: true });
  await expect(clave).toHaveValue('k1');
  await clave.fill('k2');
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.locator('.response-section')).toContainText('/contexto/k2');
});

test('panels resize by dragging their dividers, and Back leaves the settings', async ({
  page,
  nexo,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Request configuration' })
    .getByRole('button', { name: 'Body' })
    .click();
  const content = page.locator('.request-content');
  const before = (await content.boundingBox()).height;
  const divider = page.getByRole('separator', { name: 'Resize the request and the response' });
  await expect(divider).toHaveCSS('cursor', 'row-resize');
  const box = await divider.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 80, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await content.boundingBox()).height).toBeGreaterThan(before + 60);
  const resized = (await content.boundingBox()).height;
  // The body editor fills the panel, and the size is kept for the next session.
  const editor = (
    await page.locator('app-code-editor', { has: page.getByLabel('Request body') }).boundingBox()
  ).height;
  expect(editor).toBeGreaterThan(resized - 120);
  await page.reload();
  await expect
    .poll(async () => (await page.locator('.request-content').boundingBox())?.height)
    .toBe(resized);

  // "Reset layout" gives the panels back their template size.
  await page
    .getByRole('navigation', { name: 'Request configuration' })
    .getByRole('button', { name: 'Body' })
    .click();
  await page.getByRole('button', { name: 'Reset layout' }).click();
  await expect
    .poll(async () => (await page.locator('.request-content').boundingBox())?.height)
    .toBe(before);
  await expect(page.getByRole('button', { name: 'Reset layout' })).toBeDisabled();

  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('Back API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'Back API' });
  await collection.getByLabel('Collection actions').click();
  await collection.getByRole('button', { name: 'Variables & settings' }).click();
  await page.getByRole('button', { name: 'Back to Collections' }).click();
  await expect(page.getByRole('button', { name: 'Send' }).first()).toBeVisible();
});

test('item actions float over the next panel and stay usable with long names', async ({
  page,
  nexo,
}) => {
  // The "Move to" select lists the collection and folder names. A long name used to widen
  // the menu past the sidebar's left edge, where the sidebar clipped every action.
  const name = '[development] Orders service folder with a very long name';
  await page.setViewportSize({ width: 900, height: 700 });
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: name });
  await collection.getByLabel('Collection actions').click();
  await collection.getByRole('button', { name: 'Add folder' }).click();
  await page.getByPlaceholder('Give it a name').fill('Users');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  const row = collection.locator('.tree-row', { hasText: 'Users' });
  const menu = row.locator('.collection-menu > div');
  await row.getByLabel('Item actions').click();
  await expect(menu).toBeVisible();
  for (const action of [
    row.getByRole('button', { name: 'Rename' }),
    row.getByRole('button', { name: 'Delete' }),
    row.getByLabel('Move to'),
  ]) {
    await expect(action).toBeInViewport({ ratio: 1 });
  }
  // Scrolling the sidebar keeps the menu under its button: Playwright, like a user, may
  // scroll the button into view as it clicks it.
  await page.locator('.sidebar').evaluate((sidebar) => sidebar.dispatchEvent(new Event('scroll')));
  await expect(menu).toBeVisible();
  // A click outside closes the floating menu.
  await page.getByLabel('Request URL').click();
  await expect(menu).toBeHidden();

  // Clicking an action works: no panel covers the menu.
  await row.getByLabel('Item actions').click();
  await row.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByPlaceholder('Give it a name')).toHaveValue('Users');
});

test('collection settings scroll to their last option in a short window', async ({
  page,
  nexo,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('Tall settings');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'Tall settings' });
  await collection.getByLabel('Collection actions').click();
  await collection.getByRole('button', { name: 'Variables & settings' }).click();
  await page.getByRole('button', { name: 'Authorization', exact: true }).click();
  await page.getByLabel('Authorization type').selectOption('oauth2');

  // The page scrolls inside the window, so the last buttons can be reached with the wheel.
  const save = page.getByRole('button', { name: 'Save collection' });
  await expect(save).not.toBeInViewport();
  await page.locator('.tools-page').hover();
  await page.mouse.wheel(0, 5000);
  await expect(save).toBeInViewport();
});
