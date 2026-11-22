// End-to-end test of MongoDB as a module (DB-39): a connection saved by a version that had it
// built in (only its URI, no driver) is in the tree of the databases; opening it downloads the
// module, saying MongoDB became one, and its collections open in its explorer.
import { expect, test } from './fixture.mjs';
import { deleteMongoConnection, mongoConnection, violations } from './helpers.mjs';

// A server of its own, so the module is not installed yet when the test starts.
test.use({ ownServer: 'mongo-migration' });

test('MongoDB: a connection of an earlier version opens once its module is downloaded', async ({
  page,
  nexo,
}) => {
  test.skip(!process.env.NEXO_MONGO_PLAIN, 'Needs the MongoDB servers of tools/mongo-fixture.sh');
  test.skip(
    !nexo.moduleIds.includes('mongodb'),
    'Build the MongoDB driver: cargo build -p nexo-driver-mongodb',
  );
  await nexo.signIn(page);
  // Saved as the MongoDB section of earlier versions saved it.
  const saved = await page.request.put(new URL('/api/documents', page.url()).href, {
    headers: { 'x-nexo-client': 'nexo' },
    data: {
      id: 'legacy-mongo',
      workspace_id: 'local',
      kind: 'connection',
      name: 'Legacy',
      revision: 0,
      updated_at: 0,
      value: { uri: process.env.NEXO_MONGO_PLAIN },
    },
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Workspace sections' })
    .getByRole('button', { name: 'Databases' })
    .click();

  const tree = page.getByRole('tree', { name: 'Connections' });
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('ArrowRight');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  const connection = mongoConnection(page, 'Legacy');
  await connection.focus();
  await page.keyboard.press('ArrowRight');
  const download = page.getByRole('dialog', { name: 'Download the MongoDB module' });
  await expect(download).toContainText('MongoDB is now a downloadable module');
  expect(await violations(page)).toEqual([]);
  await download.getByRole('button', { name: 'Download' }).click();
  await expect(download).toBeHidden();
  await expect(connection).toHaveAttribute('aria-expanded', 'true');

  await open(tree.getByRole('treeitem', { name: /^nexo\b/ }));
  const big = tree.getByRole('treeitem', { name: /^big\b/ });
  await big.focus();
  await page.keyboard.press('Enter');
  const query = page.getByRole('region', { name: 'Query', exact: true });
  await expect(query.getByRole('heading', { name: 'nexo.big' })).toBeVisible();
  await expect(query.locator('app-mongo-results')).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await deleteMongoConnection(page, 'Legacy');
});
