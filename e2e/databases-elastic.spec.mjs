// End-to-end test of the Elasticsearch module against the fixture's Elasticsearch
// (tools/nosql-fixture.sh): a connection from an elasticsearch:// URL, an index in the tree
// with its fields, and the console of Query DSL from the menu of the connection.
import { expect, test } from './fixture.mjs';
import { violations } from './helpers.mjs';
import { addConnection, folder } from './databases-helpers.mjs';

const environment = process.env;

test('an Elasticsearch connection shows its indices and has its console', async ({
  page,
  nexo,
}) => {
  test.setTimeout(120_000);
  test.skip(
    !nexo.moduleIds.includes('elastic'),
    'Build the Elasticsearch driver: cargo build -p nexo-driver-elastic',
  );
  test.skip(!environment.NEXO_ELASTIC_HOST, 'Start the NoSQL fixture: tools/nosql-fixture.sh');
  await nexo.signIn(page);
  await addConnection(page, 'Search', {
    label: 'Elasticsearch',
    url: () =>
      `elasticsearch://${environment.NEXO_ELASTIC_USER}:${environment.NEXO_SEARCH_PASSWORD}@${environment.NEXO_ELASTIC_HOST}:${environment.NEXO_ELASTIC_PORT}`,
  });
  const tree = page.getByRole('tree', { name: 'Connections' });
  const open = async (item) => {
    await item.focus();
    await page.keyboard.press('ArrowRight');
    await expect(item).toHaveAttribute('aria-expanded', 'true');
  };
  const connection = tree.getByRole('treeitem', { name: /^Search/ });
  await open(connection);
  await open(folder(tree, 'Indices'));
  await open(tree.getByRole('treeitem', { name: /^shop/ }));
  await expect(tree.getByRole('treeitem', { name: /^user\.address\.city/ })).toBeVisible();
  expect(await violations(page)).toEqual([]);

  await connection.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Query DSL console' }).click();
  await page.getByRole('button', { name: 'Health' }).click();
  await expect(page.getByRole('region', { name: 'Answer' })).toContainText('"status"');
  expect(await violations(page)).toEqual([]);
});
