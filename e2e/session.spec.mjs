// End-to-end test of the order the person gives to everything and of reopening the workspace.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';

test('the workspace opens again as it was left: tabs, drafts and every order', async ({
  page,
  nexo,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await nexo.signIn(page, { restoreTabs: true });
  const request = (name) => ({ name, request: { method: 'GET', url: `${nexo.echo}/${name}` } });
  for (const [name, items] of [
    ['Session A', ['one', 'two']],
    ['Session B', ['three']],
  ]) {
    await page.getByRole('button', { name: 'Import' }).first().click();
    await page
      .getByLabel('Import content')
      .fill(JSON.stringify({ info: { name }, item: items.map(request) }));
    await page.getByRole('button', { name: 'Import', exact: true }).last().click();
    await expect(page.locator('.collection-name', { hasText: name })).toBeVisible();
  }
  const titles = () => page.locator('.collection-title .collection-name').allInnerTexts();
  const title = (name) =>
    page.locator('.collection-title', { has: page.locator('.collection-name', { hasText: name }) });
  const row = (collection, name) =>
    page
      .locator('.collection', { has: title(collection) })
      .locator('.tree-row', { has: page.getByText(name, { exact: true }) });
  const rows = (collection) =>
    page
      .locator('.collection', { has: title(collection) })
      .locator('.request-leaf span:last-child')
      .allInnerTexts();
  const status = page.locator('.statusbar [role="status"]');

  // A collection dragged by its title, before another one.
  await title('Session B').dragTo(title('Session A'), { targetPosition: { x: 60, y: 2 } });
  await expect
    .poll(async () => (await titles()).filter((t) => t.startsWith('Session')))
    .toEqual(['Session B', 'Session A']);

  // A request dragged to another collection, after its request.
  await row('Session A', 'two').dragTo(row('Session B', 'three'), {
    targetPosition: { x: 60, y: 29 },
  });
  await expect(status).toHaveText('Item moved');
  await expect.poll(() => rows('Session B')).toEqual(['three', 'two']);
  await expect.poll(() => rows('Session A')).toEqual(['one']);

  // Two requests open; one sent, the other changed without saving.
  await row('Session A', 'one').locator('.request-leaf').click();
  await page.getByRole('button', { name: 'Send' }).first().click();
  await expect(page.locator('.response-placeholder')).toHaveCount(0);
  await row('Session B', 'three').locator('.request-leaf').click();
  await page.getByLabel('Request URL').fill(`${nexo.echo}/three?draft=1`);
  const tab = (name) => page.locator('.request-tab', { hasText: name });
  await expect(tab('three').locator('.dirty-dot')).toBeVisible();

  // The changed tab dragged first, and a section of the side menu moved up.
  await tab('three').dragTo(page.locator('.request-tab').first(), {
    targetPosition: { x: 4, y: 10 },
  });
  const tabs = () =>
    page.locator('.request-tab > button:first-child span:nth-child(2)').allInnerTexts();
  await expect.poll(tabs).toEqual(['three', 'Untitled request', 'one']);
  const rail = page.getByRole('navigation', { name: 'Workspace sections' });
  await rail
    .getByRole('button', { name: 'MongoDB' })
    .dragTo(rail.getByRole('button', { name: 'Collections' }), { targetPosition: { x: 20, y: 2 } });
  await expect(rail.getByRole('button').first()).toHaveText(/MongoDB/);
  expect(await violations(page)).toEqual([]);

  // Saved in the workspace shortly after the last change.
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const headers = { 'x-nexo-client': 'nexo' };
        const [workspace] = await (await fetch('/api/workspaces', { headers })).json();
        const answer = await fetch(`/api/documents/session-${workspace.id}`, { headers });
        return answer.ok ? (await answer.json()).value.tabs.map((t) => t.draft?.name ?? '') : [];
      }),
    )
    .toEqual(['three', 'Untitled request', '']);

  await page.reload();
  await expect.poll(tabs).toEqual(['three', 'Untitled request', 'one']);
  await expect(tab('three').locator('.dirty-dot')).toBeVisible();
  await expect(page.getByLabel('Request URL')).toHaveValue(`${nexo.echo}/three?draft=1`);
  expect((await titles()).filter((t) => t.startsWith('Session'))).toEqual([
    'Session B',
    'Session A',
  ]);
  await expect.poll(() => rows('Session B')).toEqual(['three', 'two']);
  await expect(rail.getByRole('button').first()).toHaveText(/MongoDB/);
  // Responses are never kept: the request sent shows none.
  await tab('one').locator('button').first().click();
  await expect(page.locator('.response-placeholder')).toBeVisible();
});
