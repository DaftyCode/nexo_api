// End-to-end test of the Redis module against the fixture's Redis (tools/nosql-fixture.sh):
// a connection from a redis:// URL, its database in the tree opened on its keys grouped by
// `:`, a hash's sheet, the console, and FLUSHDB waiting for its name typed.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection } from './databases-helpers.mjs';

const environment = process.env;

test('a Redis database opens on its keys, with its console', async ({ page, nexo }) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('redis'),
    'Build the Redis driver: cargo build -p nexo-driver-redis',
  );
  test.skip(!environment.NEXO_REDIS_HOST, 'Start the NoSQL fixture: tools/nosql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Cache', {
    label: 'Redis',
    url: () =>
      `redis://${environment.NEXO_REDIS_USER}:${environment.NEXO_REDIS_PASSWORD}@${environment.NEXO_REDIS_HOST}:${environment.NEXO_REDIS_PORT}/0`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const connection = tree.getByRole('treeitem', { name: /^Cache/ });
  await connection.focus();
  await page.keyboard.press('ArrowRight');
  await expect(connection).toHaveAttribute('aria-expanded', 'true');
  await tree.getByRole('treeitem', { name: /^db0/ }).dblclick();

  const keys = page.getByRole('region', { name: 'Keys' });
  await keys.getByLabel('Pattern').fill('user:*');
  await keys.getByRole('button', { name: 'Search' }).click();
  await keys.getByRole('button', { name: /^user/ }).click();
  await keys.getByRole('button', { name: /^1/ }).first().click();
  await keys.getByTitle('user:1', { exact: true }).click();
  const sheet = page.getByRole('region', { name: 'Key' });
  await expect(sheet.getByRole('heading', { name: 'user:1' })).toBeVisible();
  await expect(sheet.getByRole('table')).toContainText('Lima');
  expect(await violations(page)).toEqual([]);

  await page.getByRole('button', { name: 'Console', exact: true }).click();
  const line = page.getByLabel('Command', { exact: true });
  await line.fill('HGET user:1 city');
  await line.press('Enter');
  await expect(page.getByRole('log', { name: 'Console' })).toContainText('"Lima"');
  await line.fill('FLUSHDB');
  await line.press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'FLUSHDB' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Cancel' }).click();
  await line.fill('DBSIZE');
  await line.press('Enter');
  await expect(page.getByRole('log', { name: 'Console' })).toContainText('(integer)');
});
