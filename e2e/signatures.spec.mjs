// End-to-end tests of signed authorization: OAuth 1.0, AWS, Hawk, JWT, ASAP and EdgeGrid.
import { generateKeyPairSync } from 'node:crypto';
import { expect, test } from './fixture.mjs';
import { addRequest } from './helpers.mjs';

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
