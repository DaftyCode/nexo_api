// Helpers shared by the end-to-end tests.
import AxeBuilder from '@axe-core/playwright';
import { expect } from './fixture.mjs';

/** Serious and critical axe violations, reduced to rule and target for readable failures. */
export async function violations(page) {
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
export async function addRequest(page, action) {
  await action.click();
  await expect(page.getByRole('textbox', { name: 'Request name' })).toHaveValue('New request');
}

/**
 * The authorization address of the next OAuth 2.0 sign-in. The answer is read in the test
 * process as it passes through: reading it from the browser afterwards can fail, because the
 * browser may already have discarded the body ("No data found for resource").
 */
export async function nextAuthorizationUrl(page) {
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

/**
 * Leaves the MongoDB explorer and deletes the connection it browsed. The tests share one
 * server, so a connection left behind would show up in the list of the next one.
 */
export async function deleteMongoConnection(page, name) {
  await page
    .getByRole('navigation', { name: 'Databases' })
    .getByRole('button', { name: '← Connections' })
    .click();
  const list = page.getByRole('navigation', { name: 'Connections' });
  await list.getByRole('button', { name, exact: true }).click();
  page.once('dialog', (confirm) => confirm.accept());
  await page
    .getByRole('region', { name: 'Connection', exact: true })
    .getByRole('button', { name: 'Delete connection' })
    .click();
  await expect(list.getByRole('button', { name, exact: true })).toHaveCount(0);
}
