import AxeBuilder from '@axe-core/playwright';
import { generateKeyPairSync } from 'node:crypto';
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
    /padding-left: 28px/,
  );

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
          variable: [{ key: 'clave', value: 'cead1876' }],
        },
      ),
      request(
        'cache',
        'POST',
        { mode: 'raw', raw: '{"canal":"MEDIADORES"}', options: { raw: { language: 'json' } } },
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
  await expect(page.getByLabel('Request body')).toHaveValue('{"canal":"MEDIADORES"}');

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
  await expect(clave).toHaveValue('cead1876');
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
  const editor = (await page.getByLabel('Request body').boundingBox()).height;
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
  const name = '[DEV-mediadores] Comunicador Siniestros BFF con un nombre muy largo';
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
  await page.keyboard.press('F1');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
});
