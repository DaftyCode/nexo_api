// End-to-end tests of inherited authorization, OAuth 2.0 and secrets limited to some domains.
import { expect, test } from './fixture.mjs';
import { addRequest, nextAuthorizationUrl } from './helpers.mjs';

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
  // A toast says what was saved, as for every save.
  await expect(page.locator('.toast')).toContainText('Folder saved');
  await expect(page.locator('.toast')).toContainText('"Local" in');

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
  await expect(page.locator('.toast')).toContainText('Collection saved');

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
