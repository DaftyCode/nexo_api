// End-to-end tests of script editors, request bodies with files, globals and cookies.
import { createHash } from 'node:crypto';
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

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
