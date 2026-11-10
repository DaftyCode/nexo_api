import AxeBuilder from '@axe-core/playwright';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { expect, test } from './fixture.mjs';

/** Serious and critical axe violations, reduced to rule and target for readable failures. */
async function violations(page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/**
 * Clicks an "Add request" action and waits for the new request's tab. The workspace opens with
 * an "Untitled request" tab and the new one opens once the collection is saved; on a slow
 * machine, typing before that edits the untitled request instead.
 */
async function addRequest(page, action) {
  await action.click();
  await expect(page.getByRole('textbox', { name: 'Request name' })).toHaveValue('New request');
}

/**
 * The authorization address of the next OAuth 2.0 sign-in. The answer is read in the test
 * process as it passes through: reading it from the browser afterwards can fail, because the
 * browser may already have discarded the body ("No data found for resource").
 */
async function nextAuthorizationUrl(page) {
  const pattern = '**/execute/oauth2.authorize';
  let found;
  const captured = new Promise((resolve) => (found = resolve));
  const handler = async (route) => {
    const response = await route.fetch();
    const text = await response.text();
    try {
      const { authorizationUrl } = JSON.parse(text);
      if (authorizationUrl) found(authorizationUrl);
    } catch {
      // Not the answer that starts the sign-in.
    }
    await route.fulfill({ response, body: text });
  };
  await page.route(pattern, handler);
  // Wrapped: awaiting this function must not wait for the sign-in itself.
  return { url: captured.finally(() => page.unroute(pattern, handler)) };
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

test('a request shows the authorization it inherits from its folder', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('Auth API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'Auth API' });
  await collection.getByLabel('Collection actions').click();
  await collection.getByRole('button', { name: 'Add folder' }).click();
  await page.getByPlaceholder('Give it a name').fill('Local');
  await page.getByRole('button', { name: 'Create', exact: true }).click();

  // Folder settings: a bearer token for every request in the folder.
  const folder = collection.locator('.tree-row', { hasText: 'Local' });
  await folder.getByLabel('Item actions').click();
  await folder.getByRole('button', { name: 'Variables & settings' }).click();
  await expect(page.getByRole('heading', { name: 'Folder settings' })).toBeVisible();
  await page.getByRole('button', { name: 'Authorization', exact: true }).click();
  await page.getByLabel('Authorization type').selectOption('bearer');
  await page.getByRole('textbox', { name: 'Token' }).fill('{{token}}');
  await page.getByRole('button', { name: 'Save folder' }).click();
  await expect(page.getByText('Folder saved')).toBeVisible();

  // A new request in the folder inherits it, as in Postman, and says where it comes from.
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await addRequest(page, folder.getByLabel('Add request in folder'));
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await expect(page.getByLabel('Authorization type')).toHaveValue('inherit');
  await expect(page.getByText('Uses Bearer token from the folder "Local".')).toBeVisible();
  await expect(page.getByText('{{token}}', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Edit authorization' }).click();
  await expect(page.getByRole('heading', { name: 'Folder settings' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Token' })).toHaveValue('{{token}}');
});

test('OAuth 2.0: a collection gets a token and its requests send it', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('OAuth API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', {
    has: page.getByRole('button', { name: 'OAuth API', exact: true }),
  });
  await collection.getByLabel('Collection actions').click();
  await collection.getByRole('button', { name: 'Variables & settings' }).click();
  await page.getByRole('button', { name: 'Authorization', exact: true }).click();

  // As in Postman: OAuth 2.0, Client Credentials, then "Get new access token".
  await page.getByLabel('Authorization type').selectOption('oauth2');
  await page.getByLabel('Grant type').selectOption('client_credentials');
  await expect(page.getByLabel('Auth URL')).toHaveCount(0);
  await page.getByLabel('Access Token URL').fill(`${nexo.echo}/token`);
  await page.getByLabel('Client ID').fill('app');
  await page.getByLabel('Client Secret').fill('secret');
  await page.getByLabel('Token Name').fill('E2E token');
  await page.getByRole('button', { name: 'Get new access token' }).click();
  // A toast says it went well: the token is saved in the collection at once.
  const toast = page.locator('.toast');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toContainText('Access token obtained');
  await expect(toast).toContainText('Token "E2E token" saved and selected in the authorization.');
  await toast.getByRole('button', { name: 'Close notification' }).click();
  await expect(toast).toHaveCount(0);
  // As in Postman, the new token is selected in "Available Tokens"; its value stays in the vault.
  const current = page.getByRole('combobox', { name: 'Token', exact: true });
  await expect(current.locator('option:checked')).toHaveText('E2E token');
  await expect(page.locator('.token-input')).toHaveCount(0);

  await page.getByRole('button', { name: 'Manage Tokens' }).click();
  const tokens = page.getByRole('dialog', { name: 'Manage Tokens' });
  await tokens.getByRole('button', { name: 'Show' }).first().click();
  await expect(tokens.getByText('e2e-token')).toBeVisible();
  await tokens.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('.token-status')).toContainText('Expires');
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save collection' }).click();
  await expect(page.getByText('Collection saved')).toBeVisible();

  // A new request inherits the authorization and sends the token.
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  await collection.getByLabel('Collection actions').click();
  await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
  await page.getByLabel('Request URL').fill(`${nexo.echo}/me`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  // The token is sent from the vault and redacted from what Nexo shows and keeps.
  await expect(page.getByText('Bearer [REDACTED]')).toBeVisible();
});

test('OAuth 2.0: a PKCE sign-in completes with the address pasted back', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.keyboard.press('Control+t');
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('oauth2');
  await page.getByLabel('Grant type').selectOption('authorization_code_with_pkce');
  // A Callback URL that is not on this computer (like Postman's) is completed by pasting.
  await page.getByLabel('Callback URL').fill('https://oauth.pstmn.io/v1/browser-callback');
  await page.getByLabel('Auth URL').fill(`${nexo.echo}/authorize`);
  await page.getByLabel('Access Token URL').fill(`${nexo.echo}/token`);
  await page.getByLabel('Client ID').fill('app');

  const started = await nextAuthorizationUrl(page);
  await page.getByRole('button', { name: 'Get new access token' }).click();
  const authorizationUrl = await started.url;
  const dialog = page.getByRole('dialog', { name: 'Sign in with OAuth 2.0' });
  await expect(dialog).toBeVisible();
  expect(new URL(authorizationUrl).searchParams.get('code_challenge_method')).toBe('S256');

  // What the browser does: sign in and come back to the Callback URL with a code.
  const back = (await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location');
  await dialog.getByLabel('Address the browser returned to').fill(back);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).toBeHidden();
  const current = page.getByRole('combobox', { name: 'Token', exact: true });
  await expect(current).not.toHaveValue('');
  // A request outside a collection: the person saves it.
  await expect(page.locator('.toast')).toContainText('Save the request to keep using it.');
});

test('OAuth 2.0: a token pasted from the browser is used when the address has no code', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page.keyboard.press('Control+t');
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('oauth2');
  await page.getByLabel('Grant type').selectOption('authorization_code_with_pkce');
  await page.getByLabel('Token Name').fill('E2E-PASTED');
  await page.getByLabel('Callback URL').fill('https://front.example.com/callback');
  await page.getByLabel('Auth URL').fill(`${nexo.echo}/authorize`);
  await page.getByLabel('Access Token URL').fill(`${nexo.echo}/token`);
  await page.getByLabel('Client ID').fill('app');
  await page.getByRole('button', { name: 'Get new access token' }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in with OAuth 2.0' });
  await expect(dialog).toBeVisible();

  // The front signed in by itself and cleaned its address: no code to read.
  await dialog.getByLabel('Address the browser returned to').fill('https://front.example.com/home');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog.getByRole('alert')).toContainText('This address has no code');
  await dialog.getByLabel('Access token', { exact: true }).fill('Bearer token-from-cookie');
  await dialog.getByRole('button', { name: 'Use this token' }).click();
  await expect(dialog).toBeHidden();
  const current = page.getByRole('combobox', { name: 'Token', exact: true });
  await expect(current).not.toHaveValue('');
  await expect(current.locator('option:checked')).toContainText('E2E-PASTED');
});

test('OAuth 2.0: Auto-fetch Token signs in before sending without a token', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page.keyboard.press('Control+t');
  await page.getByLabel('Request URL').fill(`${nexo.echo}/me`);
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('oauth2');
  await page.getByLabel('Grant type').selectOption('authorization_code_with_pkce');
  await page.getByLabel('Token Name').fill('E2E-AUTO');
  await page.getByLabel('Callback URL').fill('https://oauth.pstmn.io/v1/browser-callback');
  await page.getByLabel('Auth URL').fill(`${nexo.echo}/authorize`);
  await page.getByLabel('Access Token URL').fill(`${nexo.echo}/token`);
  await page.getByLabel('Client ID').fill('app');
  await page.getByLabel('Auto-fetch Token').check();

  // Sending without a token opens the sign-in first, as Bruno does.
  const started = await nextAuthorizationUrl(page);
  await page.getByRole('button', { name: 'Send' }).first().click();
  const authorizationUrl = await started.url;
  const dialog = page.getByRole('dialog', { name: 'Sign in with OAuth 2.0' });
  await expect(dialog).toBeVisible();
  const back = (await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location');
  await dialog.getByLabel('Address the browser returned to').fill(back);
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).toBeHidden();
  // The request then goes with the new token (redacted in what Nexo shows).
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  await expect(page.getByText('Bearer [REDACTED]')).toBeVisible();

  // The next send reuses it without signing in again.
  const signIns = [];
  page.on('request', (request) => {
    if (request.url().includes('oauth2.authorize')) signIns.push(request.url());
  });
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByText('Bearer [REDACTED]')).toBeVisible();
  expect(signIns).toEqual([]);
});

test('a vault secret limited to some domains is not sent anywhere else', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Settings' })
    .click();
  await page.getByRole('button', { name: 'vault', exact: true }).click();
  await page.getByLabel('Secret name').fill('e2e_limited');
  await page.getByLabel('Value', { exact: true }).fill('e2e-limited-value');
  await page.getByLabel('Allowed domains').fill('127.0.0.1');
  await page.getByRole('button', { name: 'Save secret' }).click();
  const saved = page.locator('.secret-list li', { hasText: '{{vault:e2e_limited}}' });
  await expect(saved).toContainText('127.0.0.1');

  // Sent to an allowed domain, redacted in what Nexo shows.
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Collections' })
    .click();
  await page.keyboard.press('Control+t');
  await page.getByLabel('Request URL').fill(`${nexo.echo}/limited?key={{vault:e2e_limited}}`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  await expect(page.getByText('/limited?key=[REDACTED]')).toBeVisible();

  // Not sent to another domain: the request stops with an explanation.
  const elsewhere = nexo.echo.replace('127.0.0.1', 'localhost');
  await page.getByLabel('Request URL').fill(`${elsewhere}/limited?key={{vault:e2e_limited}}`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(
    page.getByText(
      'Secret e2e_limited cannot be sent to localhost. If it should go there, add that domain to its allowed domains in the vault.',
    ),
  ).toBeVisible();
});

test('OAuth 1.0: a request is signed in the Authorization header', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('OAuth1 API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'OAuth1 API' });
  await collection.getByLabel('Collection actions').click();
  await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
  await page.getByLabel('Request URL').fill(`${nexo.echo}/statuses?count=2`);
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('oauth1');

  // RSA methods take a private key instead of the consumer and token secrets, as in Postman.
  await page.getByLabel('Signature Method').selectOption('RSA-SHA256');
  await expect(page.getByLabel('Private Key')).toBeVisible();
  await expect(page.getByLabel('Consumer Secret')).toHaveCount(0);
  await page.getByLabel('Signature Method').selectOption('HMAC-SHA256');
  await page.getByLabel('Consumer Key').fill('e2e-consumer');
  await page.getByLabel('Consumer Secret').fill('e2e-secret');
  await page.getByLabel('Access Token').fill('e2e-token');
  await page.getByLabel('Token Secret').fill('e2e-token-secret');
  await page.getByLabel('Add authorization data to').selectOption('header');
  await expect(page.getByLabel('Signature Method')).toHaveValue('HMAC-SHA256');

  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  const response = page.locator('.response-section');
  await expect(response).toContainText('oauth_consumer_key');
  await expect(response).toContainText('HMAC-SHA256');
  await expect(response).not.toContainText('e2e-secret');
});

test('AWS Signature: a request is signed with the region and service chosen', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('AWS API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'AWS API' });
  await collection.getByLabel('Collection actions').click();
  await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
  await page.getByLabel('Request URL').fill(`${nexo.echo}/items`);
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('awsv4');
  await page.getByLabel('Access Key').fill('E2EKEY');
  await page.getByLabel('Secret Key').fill('e2e-aws-secret');
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByLabel('AWS Region').fill('eu-west-1');
  await page.getByLabel('Service Name').fill('lambda');

  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  const response = page.locator('.response-section');
  await expect(response).toContainText('AWS4-HMAC-SHA256 Credential=E2EKEY/');
  await expect(response).toContainText('/eu-west-1/lambda/aws4_request');
  await expect(response).not.toContainText('e2e-aws-secret');
});

test('Hawk: a request is signed with the ID, key and extra data', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('Hawk API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'Hawk API' });
  await collection.getByLabel('Collection actions').click();
  await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
  await page.getByLabel('Request URL').fill(`${nexo.echo}/resource`);
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('hawk');
  await page.getByLabel('Hawk Auth ID').fill('e2e-hawk-id');
  await page.getByLabel('Hawk Auth Key').fill('e2e-hawk-key');
  await page.getByLabel('Algorithm').selectOption('sha1');
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByLabel('ext', { exact: true }).fill('e2e-extra');

  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  const response = page.locator('.response-section');
  await expect(response).toContainText('Hawk id=');
  await expect(response).toContainText('e2e-hawk-id');
  await expect(response).toContainText('e2e-extra');
  await expect(response).not.toContainText('e2e-hawk-key');
});

test('JWT Bearer: a signed token is sent with the payload and prefix chosen', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('JWT API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'JWT API' });
  await collection.getByLabel('Collection actions').click();
  await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
  await page.getByLabel('Request URL').fill(`${nexo.echo}/me`);
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('jwt');
  await page.getByLabel('Algorithm').selectOption('HS512');
  await page.getByLabel('Secret', { exact: true }).fill('e2e-jwt-secret');
  await page.getByLabel('Payload').fill('{"sub":"e2e"}');
  await page.getByText('Advanced', { exact: true }).click();
  await page.getByLabel('Request header prefix').fill('JWT');

  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  const response = page.locator('.response-section');
  // {"alg":"HS512"} and {"sub":"e2e"} in Base64url.
  await expect(response).toContainText('JWT eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiJlMmUifQ.');
  await expect(response).not.toContainText('e2e-jwt-secret');
});

test('ASAP: a short-lived token is signed with the key ID and issuer', async ({ page, nexo }) => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('ASAP API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'ASAP API' });
  await collection.getByLabel('Collection actions').click();
  await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
  await page.getByLabel('Request URL').fill(`${nexo.echo}/rest`);
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('asap');
  await page.getByLabel('Algorithm').selectOption('ES256');
  await page.getByLabel('Issuer').fill('nexo');
  await page.getByLabel('Audience').fill('jira');
  await page.getByLabel('Key ID').fill('nexo/e2e');
  await page
    .getByLabel('Private key')
    .fill(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  const header = Buffer.from('{"alg":"ES256","kid":"nexo/e2e"}').toString('base64url');
  await expect(page.locator('.response-section')).toContainText(`Bearer ${header}.`);
});

test('Akamai EdgeGrid: a request is signed with the three tokens', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page.getByRole('button', { name: 'Create collection' }).first().click();
  await page.getByPlaceholder('Give it a name').fill('EdgeGrid API');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  const collection = page.locator('.collection', { hasText: 'EdgeGrid API' });
  await collection.getByLabel('Collection actions').click();
  await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
  await page.getByLabel('Request URL').fill(`${nexo.echo}/papi/v1/groups`);
  await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
  await page.getByLabel('Authorization type').selectOption('edgegrid');
  await page.getByLabel('Access Token').fill('e2e-access');
  await page.getByLabel('Client Token').fill('e2e-client');
  await page.getByLabel('Client Secret').fill('e2e-edgegrid-secret');

  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  const response = page.locator('.response-section');
  await expect(response).toContainText('EG1-HMAC-SHA256 client_token=e2e-client;');
  await expect(response).toContainText(';signature=');
  await expect(response).not.toContainText('e2e-edgegrid-secret');
});

for (const [type, label, check] of [
  ['wsse', 'WSSE', 'UsernameToken Username='],
  // The e2e server reads a netrc file with a machine entry for 127.0.0.1.
  ['netrc', 'Netrc', `Basic ${Buffer.from('e2e-user:e2e-netrc').toString('base64')}`],
]) {
  test(`${label}: a request is sent with its credentials`, async ({ page, nexo }) => {
    await nexo.signIn(page);
    await page.getByRole('button', { name: 'Create collection' }).first().click();
    await page.getByPlaceholder('Give it a name').fill(`${label} API`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const collection = page.locator('.collection', { hasText: `${label} API` });
    await collection.getByLabel('Collection actions').click();
    await addRequest(page, collection.getByRole('button', { name: 'Add request', exact: true }));
    await page.getByLabel('Request URL').fill(`${nexo.echo}/${type}`);
    await page.getByRole('button', { name: 'Authorization', exact: true }).first().click();
    await page.getByLabel('Authorization type').selectOption(type);
    if (type === 'wsse') {
      await page.getByLabel('Username').fill('bob');
      await page.getByLabel('Password').fill('e2e-wsse-password');
    }

    await page.getByRole('button', { name: 'Send' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
    await expect(page.locator('.response-section')).toContainText(check);
    await expect(page.locator('.response-section')).not.toContainText('e2e-wsse-password');
  });
}

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

  // The script API is suggested as one types it, with how each member is used.
  await editor.fill('');
  await page.keyboard.type('pm.environment.s');
  const suggestions = page.locator('.cm-tooltip-autocomplete');
  await expect(suggestions).toContainText('set');
  await expect(suggestions).toContainText('(key, value)');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect(editor).toHaveText('pm.environment.set');
  await page.keyboard.type("('a', 1);\npm.response.to.h");
  await expect(suggestions).toContainText('have');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F1');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});

test('files chosen for form-data and binary bodies are sent byte for byte', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
  const sha256 = createHash('sha256').update(png).digest('hex');
  // A Postman export keeps only the path of the file: it has to be chosen again.
  const exported = {
    info: {
      name: 'Uploads',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    item: [
      {
        name: 'Avatar',
        request: {
          method: 'POST',
          url: `${nexo.echo}/upload`,
          body: {
            mode: 'formdata',
            formdata: [
              { key: 'note', value: 'hi', type: 'text' },
              { key: 'avatar', type: 'file', src: '/Users/ana/avatar.png' },
            ],
          },
        },
      },
    ],
  };
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.getByLabel('Import content').fill(JSON.stringify(exported));
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  await page.locator('.collection', { hasText: 'Uploads' }).locator('.tree-row').click();
  const configuration = page.getByRole('navigation', { name: 'Request configuration' });
  await configuration.getByRole('button', { name: 'Body' }).click();
  await expect(page.locator('.kv-file-missing')).toContainText('/Users/ana/avatar.png');
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(
    page.getByText('Choose the file /Users/ana/avatar.png for the form-data field avatar'),
  ).toBeVisible();

  await page
    .getByLabel('Select files')
    .setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: png });
  await expect(page.locator('.kv-file-names')).toHaveText('avatar.png');
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.locator('.response-code')).toContainText(
    `avatar:avatar.png:image/png:${sha256}`,
  );

  // Saved by name, as Postman does; the file stays chosen in the open request.
  await page.getByRole('button', { name: /Save/ }).first().click();
  await expect(page.locator('.kv-file-names')).toHaveText('avatar.png');

  // A binary body sends exactly the bytes of the file.
  await page.locator('.body-options select').first().selectOption('file');
  await page
    .getByLabel('Select file', { exact: true })
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.locator('.response-code')).toContainText(`"sha256": "${sha256}"`);
  await expect(page.locator('.response-code')).toContainText('"type": "image/png"');
});

test('GraphQL: the schema is loaded and explored, and a subscription receives its results', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page.getByLabel('Request URL').fill(`${nexo.echo}/graphql`);
  const configuration = page.getByRole('navigation', { name: 'Request configuration' });
  await configuration.getByRole('button', { name: 'Body' }).click();
  await page.locator('.body-options select').first().selectOption('graphql');
  await page.getByRole('button', { name: 'Load schema' }).click();
  const explorer = page.getByRole('region', { name: 'Schema explorer' });
  await expect(explorer).toContainText('user(id: ID!): User');

  // The query editor (CodeMirror): the explorer inserts at the cursor.
  const query = page.getByLabel('GraphQL query');
  const text = () => query.evaluate((editor) => editor.innerText);
  await query.fill('query {\n  \n}');
  await query.press('Control+Home');
  await query.press('ArrowDown');
  await query.press('End');
  await explorer.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(text).toBe('query {\n  user(id: $id) {\n  \n}\n}');
  await explorer.getByRole('button', { name: 'User', exact: true }).click();
  await expect(explorer).toContainText('name: String');

  // Typing suggests the fields of the selection, with their types; Enter takes one.
  await query.fill('query {\n  ');
  await page.keyboard.type('us');
  const suggestions = page.locator('.cm-tooltip-autocomplete');
  await expect(suggestions).toContainText('user');
  await expect(suggestions).toContainText('User');
  // CodeMirror ignores Enter for 75 ms after the list opens, so a fast Enter is a new line.
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect.poll(text).toBe('query {\n  user');
  await page.keyboard.type('(id: "1") { n');
  await expect(suggestions).toContainText('name');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await expect.poll(text).toContain('{ name');
  // A field the schema does not have is marked.
  await query.fill('query { user(id: "1") { nickname } }');
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(1, { timeout: 5000 });
  expect(await violations(page)).toEqual([]);
  await query.fill('query { user(id: "1") { name } }');
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.locator('.response-code')).toContainText('"name": "Ana"');

  // The same endpoint's subscription, in the protocols panel.
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Protocols' })
    .click();
  await page.getByLabel('Protocol', { exact: true }).selectOption('graphql-subscription');
  await page.getByLabel('Connection URL').fill(`${nexo.echo.replace('http', 'ws')}/subscriptions`);
  // Its schema, loaded over HTTP at the same address, suggests the subscription's fields.
  await page.getByRole('button', { name: 'Load schema' }).click();
  await expect(page.getByText('suggested as you type')).toBeVisible();
  const subscription = page.getByLabel('GraphQL subscription');
  await subscription.fill('subscription {\n  ');
  await page.keyboard.type('ti');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('ticks');
  await expect(page.locator('.cm-tooltip-autocomplete')).toContainText('Int');
  await page.keyboard.press('Escape');
  await subscription.fill('subscription { ticks }');
  await page.getByRole('button', { name: /Connect/ }).click();
  for (const tick of [1, 2, 3])
    await expect(
      page.locator('.stream-event').filter({ hasText: `"ticks": ${tick}` }),
    ).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('button', { name: /Connect/ })).toBeVisible();

  // The same subscription over server-sent events, which the server completes.
  await page.getByLabel('Subscription protocol').selectOption('graphql-sse');
  await page.getByLabel('Connection URL').fill(`${nexo.echo}/graphql/stream`);
  await page.getByRole('button', { name: /Connect/ }).click();
  await expect(page.locator('.stream-event').filter({ hasText: 'complete' })).toBeVisible();
  for (const tick of [1, 2, 3])
    await expect(
      page.locator('.stream-event').filter({ hasText: `"ticks": ${tick}` }),
    ).toBeVisible();
});

test('a global a script writes is kept, used by the next request and edited', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  const sections = page.getByRole('navigation', { name: 'Workspace sections' });
  const configuration = page.getByRole('navigation', { name: 'Request configuration' });
  const send = async () => {
    await page.getByRole('button', { name: 'Send' }).first().click();
    await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  };
  await page.getByLabel('Request URL').fill(`${nexo.echo}/login`);
  await configuration.getByRole('button', { name: /Scripts/ }).click();
  await page.getByLabel('Test scripts').fill('pm.globals.set("session", "abc123");');
  await send();

  // The next request resolves it.
  await page.getByLabel('Request URL').fill(`${nexo.echo}/orders/{{session}}`);
  await send();
  await expect(page.locator('.response-code')).toContainText('/orders/abc123');

  // The editor shows it; a change made there is what the next request sends.
  await sections.getByRole('button', { name: 'Environments' }).click();
  await page.getByRole('button', { name: /Global variables/ }).click();
  const row = page.locator('app-variable-editor .kv-row').first();
  await expect(row.getByLabel('Variable name')).toHaveValue('session');
  await expect(row.getByLabel('Variable value')).toHaveValue('abc123');
  await row.getByLabel('Variable value').fill('xyz789');
  await page.getByRole('button', { name: 'Save globals' }).click();
  await expect(page.getByText('Unsaved changes')).toBeHidden();
  await sections.getByRole('button', { name: 'Collections' }).click();
  await send();
  await expect(page.locator('.response-code')).toContainText('/orders/xyz789');

  // Disabled, it is no longer resolved; deleted, it is gone.
  await sections.getByRole('button', { name: 'Environments' }).click();
  await page.getByRole('button', { name: /Global variables/ }).click();
  await row.getByLabel('Enable variable').uncheck();
  await page.getByRole('button', { name: 'Save globals' }).click();
  await sections.getByRole('button', { name: 'Collections' }).click();
  await send();
  // Unresolved, the reference goes out as written (percent-encoded), as in Postman.
  await expect(page.locator('.response-code')).toContainText('/orders/%7B%7Bsession%7D%7D');
  await sections.getByRole('button', { name: 'Environments' }).click();
  await page.getByRole('button', { name: /Global variables/ }).click();
  await row.getByLabel('Remove variable').click();
  await page.getByRole('button', { name: 'Save globals' }).click();
  await expect(page.getByLabel('Variable name')).not.toHaveValue('session');
});

test('cookies a response sets are edited, added and deleted, and the next request sends them', async ({
  page,
  nexo,
}) => {
  await nexo.signIn(page);
  await page.keyboard.press('Control+t');
  await page.getByLabel('Request URL').fill(`${nexo.echo}/set-cookie`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();

  await page.locator('.request-title').getByRole('button', { name: 'Cookies' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manage Cookies' });
  const domain = dialog.getByRole('region', { name: '127.0.0.1' });
  await expect(domain.getByRole('row', { name: /e2e_session/ })).toContainText('abc');
  await expect(domain.getByRole('row', { name: /e2e_session/ })).toContainText('Session');
  expect(await violations(page)).toEqual([]);

  // Edited: the new value replaces the one the response set.
  await domain
    .getByRole('row', { name: /e2e_session/ })
    .getByRole('button', { name: 'Edit' })
    .click();
  await dialog.getByLabel('Value', { exact: true }).fill('edited');
  await dialog.getByRole('button', { name: 'Save cookie' }).click();
  await expect(domain.getByRole('row', { name: /e2e_session/ })).toContainText('edited');

  // Added for the same domain, with an expiry.
  await domain.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog.getByLabel('Domain', { exact: true })).toHaveValue('127.0.0.1');
  await dialog.getByLabel('Name', { exact: true }).fill('e2e_added');
  await dialog.getByLabel('Value', { exact: true }).fill('yes');
  await dialog.getByLabel('Expires').fill('2099-01-01T00:00');
  await dialog.getByRole('button', { name: 'Save cookie' }).click();
  await expect(domain.getByRole('row', { name: /e2e_added/ })).toContainText('2099');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();

  const response = page.locator('app-response-view');
  await page.getByLabel('Request URL').fill(`${nexo.echo}/cookies`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(response).toContainText('/cookies');
  await expect(response).toContainText('e2e_session=edited');
  await expect(response).toContainText('e2e_added=yes');

  // Deleted: the next request no longer sends it.
  page.once('dialog', (confirm) => confirm.accept());
  await page.locator('.request-title').getByRole('button', { name: 'Cookies' }).click();
  await dialog.getByRole('button', { name: 'Delete cookie e2e_added' }).click();
  await expect(domain.getByRole('row', { name: /e2e_added/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Request URL').fill(`${nexo.echo}/cookies-again`);
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(response).toContainText('/cookies-again');
  await expect(response).toContainText('e2e_session=edited');
  await expect(response).not.toContainText('e2e_added');
});

test('Git remotes refuse unsafe addresses and are added and removed', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Git' })
    .click();
  await page.getByRole('button', { name: 'Initialize' }).click();
  await expect(
    page.locator('.tool-output').filter({ hasText: /Initialized|Reinitialized/ }),
  ).toBeVisible();
  const remotes = page.getByRole('region', { name: 'Remotes' });
  await expect(remotes).toContainText('No remotes.');

  await remotes.getByLabel('Remote URL').fill('ext::sh -c touch% /tmp/pwned');
  await remotes.getByRole('button', { name: 'Add remote' }).click();
  await expect(remotes.getByRole('alert')).toContainText('Use an https:// or ssh:// address');

  await remotes.getByLabel('Remote URL').fill('git@github.com:acme/api.git');
  await remotes.getByRole('button', { name: 'Add remote' }).click();
  await expect(remotes.getByRole('listitem').filter({ hasText: 'origin' })).toContainText(
    'git@github.com:acme/api.git',
  );
  expect(await violations(page)).toEqual([]);

  page.once('dialog', (confirm) => confirm.accept());
  await remotes.getByRole('button', { name: 'Remove remote origin' }).click();
  await expect(remotes).toContainText('No remotes.');
});

test('MCP: the resources and prompts of a server are browsed', async ({ page, nexo }) => {
  await nexo.signIn(page);
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'MCP' })
    .click();
  await page.getByLabel('Server URL').fill(`${nexo.echo}/mcp`);
  await page.getByLabel('Method').selectOption('initialize');
  await page.getByRole('button', { name: 'Send JSON-RPC' }).click();
  await expect(page.locator('app-mcp-results')).toContainText('e2e-session');

  await page.getByLabel('Method').selectOption('resources/list');
  await page.getByRole('button', { name: 'Send JSON-RPC' }).click();
  await page.getByRole('button', { name: 'Read Readme' }).click();
  await expect(page.getByLabel('docs://readme')).toContainText('Read me first');

  await page.getByLabel('Method').selectOption('prompts/list');
  await page.getByRole('button', { name: 'Send JSON-RPC' }).click();
  const prompt = page.getByRole('region', { name: 'greet' });
  await prompt.getByLabel('name *').fill('Ana');
  await prompt.getByRole('button', { name: 'Get prompt greet' }).click();
  await expect(page.locator('app-mcp-results')).toContainText('Say hello to Ana');
  expect(await violations(page)).toEqual([]);
});

test('reports of a run, a request and a collection are printed to PDF without secrets', async ({
  page,
  nexo,
}) => {
  // The print dialog is the system's: it is counted instead of opened.
  await page.addInitScript(() => {
    window.print = () => {
      window.__printed = (window.__printed ?? 0) + 1;
    };
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nexo.signIn(page);
  const printable = {
    info: { name: 'Printable', description: 'Orders API for the PDF' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: 'pdf-secret-token' }] },
    item: [
      {
        name: 'Orders',
        description: 'Everything about orders',
        item: [
          {
            name: 'List orders',
            request: { method: 'GET', url: `${nexo.echo}/orders`, description: 'All orders' },
            event: [
              {
                listen: 'test',
                script: {
                  exec: ["pm.test('answers 200', () => pm.response.to.have.status(200));"],
                },
              },
            ],
          },
        ],
      },
    ],
  };
  await page.getByRole('button', { name: 'Import' }).first().click();
  await page.getByLabel('Import content').fill(JSON.stringify(printable));
  await page.getByRole('button', { name: 'Import', exact: true }).last().click();
  const collection = page.locator('.collection', { hasText: 'Printable' });
  const preview = page.getByRole('dialog', { name: 'Print preview' });
  const paper = preview.locator('.report-paper');

  // Documentation of the collection.
  await collection.getByLabel('Collection actions').click();
  await page.getByRole('button', { name: 'Export documentation (PDF)' }).click();
  await expect(paper).toContainText('Collection documentation');
  await expect(paper).toContainText('Everything about orders');
  await expect(paper).toContainText('All orders');
  await expect(paper).toContainText(`${nexo.echo}/orders`);
  await expect(paper).not.toContainText('pdf-secret-token');
  expect(await violations(page)).toEqual([]);
  await preview.getByRole('button', { name: 'Close', exact: true }).click();

  // A request with its response.
  await collection.locator('.tree-row', { hasText: 'List orders' }).click();
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.getByRole('status').filter({ hasText: '200' })).toBeVisible();
  await page.locator('app-response-view').getByRole('button', { name: 'Export PDF' }).click();
  await expect(paper).toContainText('Request and response');
  await expect(paper).toContainText('/orders');
  await expect(paper).toContainText('answers 200');
  await preview.getByRole('button', { name: 'Close', exact: true }).click();

  // A run, printed: only the report is on paper, and it makes a PDF.
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Runner' })
    .click();
  await page.getByRole('button', { name: 'Run collection' }).click();
  await expect(page.getByText('Run completed')).toBeVisible();
  await page.locator('app-runner-panel').getByRole('button', { name: 'Export PDF' }).click();
  await expect(paper).toContainText('Collection run report');
  await expect(paper).toContainText('1 passed, 0 failed, 0 skipped');
  // The test is shown under the request that ran it.
  await expect(paper.locator('.report-block', { hasText: 'List orders' })).toContainText(
    'PASS · answers 200',
  );
  await expect(paper).not.toContainText('Other tests');
  await preview.getByRole('button', { name: 'Print or save as PDF' }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('app-root')).toBeHidden();
  await expect(page.locator('body > .print-sheet')).toBeVisible();
  await expect(page.locator('body > .print-sheet')).toContainText('PASS · answers 200');
  const pdf = await page.pdf({ format: 'A4' });
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  await page.emulateMedia({ media: 'screen' });
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.locator('body > .print-sheet')).toHaveCount(0);
});

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
